const db = require('../lib/db');
const supabase = require('../lib/supabase');
const { authenticate } = require('../lib/auth');

const EVENTS = new Set(['open', 'login_ok', 'login_failed']);

// Portal entries and login results (history + "contraseña por actualizar").
// Any Direct user records their own entries; only administrators read the
// whole history. Company names never reach the server: they are encrypted, so
// the browser resolves credential ids to names.
async function recordEvent(session, body) {
  const credentialId = String(body.credential_id || '').slice(0, 200);
  const institution = String(body.institution || '').slice(0, 40);
  const event = String(body.event || '');
  if (!credentialId || !institution || !EVENTS.has(event)) return { status: 400, body: { error: 'Evento no válido' } };
  if (Array.isArray(session.companies_direct) && session.role !== 'admin' && !session.companies_direct.includes(credentialId)) {
    return { status: 403, body: { error: 'Sin acceso a esa empresa' } };
  }
  const { error } = await supabase.from('direct_access_events').insert({
    tenant_id: session.tenantId, user_id: session.userId, username: session.username || null,
    credential_id: credentialId, institution, event, detail: body.detail ? String(body.detail).slice(0, 300) : null,
  });
  if (error) throw error;
  return { status: 200, body: { ok: true } };
}

async function listEvents(session, q) {
  if (session.role !== 'admin') return { status: 403, body: { error: 'Solo administradores' } };
  let query = supabase.from('direct_access_events').select('id, user_id, username, credential_id, institution, event, detail, created_at')
    .eq('tenant_id', session.tenantId).order('created_at', { ascending: false }).limit(Math.min(Number(q.limit) || 300, 1000));
  if (q.user) query = query.eq('user_id', q.user);
  if (q.institution) query = query.eq('institution', q.institution);
  const { data, error } = await query;
  if (error) throw error;
  return { status: 200, body: { ok: true, events: data || [] } };
}

// Latest login result per credential, and this user's recent entries.
async function loginStatus(session) {
  const [{ data: results, error }, { data: mine, error: mineError }] = await Promise.all([
    supabase.from('direct_access_events').select('credential_id, event, created_at').eq('tenant_id', session.tenantId)
      .in('event', ['login_ok', 'login_failed']).order('created_at', { ascending: false }).limit(3000),
    supabase.from('direct_access_events').select('credential_id, institution, created_at').eq('tenant_id', session.tenantId)
      .eq('user_id', session.userId).eq('event', 'open').order('created_at', { ascending: false }).limit(60),
  ]);
  if (error) throw error;
  if (mineError) throw mineError;
  const allowed = Array.isArray(session.companies_direct) && session.role !== 'admin' ? new Set(session.companies_direct) : null;
  const status = {};
  for (const r of results || []) {
    if (status[r.credential_id] || (allowed && !allowed.has(r.credential_id))) continue;
    status[r.credential_id] = { result: r.event === 'login_ok' ? 'ok' : 'failed', at: r.created_at };
  }
  const recent = [];
  for (const r of mine || []) if (!recent.some(x => x.credential_id === r.credential_id)) recent.push(r);
  return { status: 200, body: { ok: true, status, recent: recent.slice(0, 12) } };
}

// Panel de uso (solo admin): agrega la actividad de entradas a portales del
// tenant. Los nombres de empresa van cifrados, por eso no se exponen aquí.
async function usageStats(session) {
  if (session.role !== 'admin') return { status: 403, body: { error: 'Solo administradores' } };
  const RD = -4 * 60; // Rep. Dominicana: UTC-4 fijo (sin horario de verano).
  const local = iso => { const d = new Date(new Date(iso).getTime() + RD * 60000); return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours() }; };
  const [evRes, profRes, credRes] = await Promise.all([
    supabase.from('direct_access_events').select('user_id, username, institution, event, credential_id, created_at')
      .eq('tenant_id', session.tenantId).order('created_at', { ascending: false }).limit(10000),
    supabase.from('direct_profiles').select('id', { count: 'exact', head: true }).eq('tenant_id', session.tenantId),
    supabase.from('direct_credentials').select('id', { count: 'exact', head: true }).eq('tenant_id', session.tenantId),
  ]);
  if (evRes.error) throw evRes.error;
  const events = evRes.data || [];
  const now = Date.now(); const h24 = now - 864e5, d7 = now - 7 * 864e5;
  const resumen = {
    eventos_total: events.length,
    eventos_24h: events.filter(e => +new Date(e.created_at) >= h24).length,
    eventos_7d: events.filter(e => +new Date(e.created_at) >= d7).length,
    usuarios_activos: new Set(events.map(e => e.user_id)).size,
    usuarios_registrados: profRes.count || 0,
    empresas: credRes.count || 0,
    logins_ok: events.filter(e => e.event === 'login_ok').length,
    logins_fallidos: events.filter(e => e.event === 'login_failed').length,
    entradas: events.filter(e => e.event === 'open').length,
    ultimo: events[0]?.created_at || null,
    primero: events[events.length - 1]?.created_at || null,
  };
  const dayMap = {};
  for (const e of events) { const { day } = local(e.created_at); const m = (dayMap[day] = dayMap[day] || { open: 0, login: 0 }); if (e.event === 'open') m.open++; else if (e.event === 'login_ok') m.login++; }
  const por_dia = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(now + RD * 60000 - i * 864e5).toISOString().slice(0, 10); por_dia.push({ d, open: dayMap[d]?.open || 0, login: dayMap[d]?.login || 0 }); }
  const uMap = {};
  for (const e of events) { const u = e.username || '(sin nombre)'; const m = (uMap[u] = uMap[u] || { usuario: u, ev: 0, log: 0, emp: new Set(), last: e.created_at }); m.ev++; if (e.event === 'login_ok') m.log++; m.emp.add(e.credential_id); if (+new Date(e.created_at) > +new Date(m.last)) m.last = e.created_at; }
  const por_usuario = Object.values(uMap).map(m => ({ usuario: m.usuario, ev: m.ev, log: m.log, emp: m.emp.size, last: m.last })).sort((a, b) => b.ev - a.ev);
  const pMap = {};
  for (const e of events) { const m = (pMap[e.institution] = pMap[e.institution] || { portal: e.institution, n: 0, users: new Set() }); m.n++; m.users.add(e.user_id); }
  const por_portal = Object.values(pMap).map(m => ({ portal: m.portal, n: m.n, users: m.users.size })).sort((a, b) => b.n - a.n);
  const por_hora = Array.from({ length: 24 }, () => 0);
  for (const e of events) por_hora[local(e.created_at).hour]++;
  const recientes = events.slice(0, 20).map(e => ({ at: e.created_at, usuario: e.username || '(sin nombre)', portal: e.institution, event: e.event }));
  return { status: 200, body: { ok: true, resumen, por_dia, por_usuario, por_portal, por_hora, recientes } };
}

// ── Analítica de uso DENTRO de SERP (privacy-safe, por usuario) ──
// Registra navegación del sistema (módulos, vistas, buscador, sesión) para
// aprender a qué se dedica cada quien. NUNCA guarda nombres de empresa, RNC ni
// textos de búsqueda: 'target' son claves opacas y 'meta' solo contadores.
const USAGE_KINDS = new Set(['module_open', 'portal_view', 'view', 'search', 'session', 'feature']);
// Depura meta: solo contadores/banderas seguros, nunca texto libre del usuario.
function safeMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const out = {};
  let n = 0;
  for (const k of Object.keys(meta)) {
    if (n >= 8 || !/^[a-z_]{1,20}$/.test(k)) continue;
    const v = meta[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && /^[a-z0-9_-]{1,40}$/i.test(v)) out[k] = v;
    else continue;
    n++;
  }
  return n ? out : null;
}
async function recordUsage(session, body) {
  const kind = String(body.kind || '');
  if (!USAGE_KINDS.has(kind)) return { status: 400, body: { error: 'Evento no válido' } };
  // 'target' opaco: solo claves tipo módulo/portal/vista/feature.
  let target = body.target == null ? null : String(body.target).slice(0, 60);
  if (target && !/^[a-z0-9_.:-]{1,60}$/i.test(target)) target = null;
  // Mejor esfuerzo: la analítica nunca debe romper la app ni ensuciar logs si
  // falta la migración; se traga el error y responde ok.
  try {
    await supabase.from('direct_usage_events').insert({
      tenant_id: session.tenantId, user_id: session.userId, username: session.username || null,
      kind, target, meta: safeMeta(body.meta),
    });
  } catch (e) { /* best-effort */ }
  return { status: 200, body: { ok: true } };
}
async function listUsage(session, q) {
  if (session.role !== 'admin') return { status: 403, body: { error: 'Solo administradores' } };
  let query = supabase.from('direct_usage_events').select('id, user_id, username, kind, target, meta, created_at')
    .eq('tenant_id', session.tenantId).order('created_at', { ascending: false }).limit(Math.min(Number(q.limit) || 2000, 10000));
  if (q.user) query = query.eq('user_id', q.user);
  if (q.kind) query = query.eq('kind', q.kind);
  const { data, error } = await query;
  if (error) throw error;
  return { status: 200, body: { ok: true, events: data || [] } };
}

module.exports = async (req, res) => {
  const session = await authenticate(req);
  if (!session) return res.status(401).json({ error: 'No autorizado' });
  if (session.role !== 'admin' && !session.access_direct) {
    return res.status(403).json({ error: 'Sin acceso a Direct' });
  }
  const portals = session.role === 'admin' ? null : session.portals_direct;
  const companies = session.role === 'admin' ? null : session.companies_direct;
  try {
    if (req.query.usage === '1') {
      if (!session.tenantId) return res.status(409).json({ error: 'Falta la migración de empresas' });
      const out = req.method === 'POST' ? await recordUsage(session, req.body || {}) : await listUsage(session, req.query);
      return res.status(out.status).json(out.body);
    }
    if (req.query.events === '1' || req.query.event === '1' || req.query.status === '1' || req.query.stats === '1') {
      if (!session.tenantId) return res.status(409).json({ error: 'Falta la migración de empresas' });
      let out;
      if (req.method === 'POST') out = await recordEvent(session, req.body || {});
      else if (req.query.stats === '1') out = await usageStats(session);
      else if (req.query.status === '1') out = await loginStatus(session);
      else out = await listEvents(session, req.query);
      return res.status(out.status).json(out.body);
    }
    // Rutas CRUD de credenciales: sin tenant no hay aislamiento posible, así
    // que se falla cerrado en lugar de operar sobre todas las firmas.
    if (!session.tenantId) return res.status(409).json({ error: 'Falta la migración de empresas' });
    if (req.method === 'GET') {
      if (req.query.poll === '1') {
        const since = parseInt(req.query.since, 10) || 0;
        const updates = await db.getCredentialsSince(session.tenantId, since, portals, companies);
        return res.json({ ok: true, updates, serverTime: Date.now() });
      }
      const credentials = await db.getCredentials(session.tenantId, portals, companies);
      return res.json({ ok: true, credentials });
    }
    if (req.method === 'POST') {
      if (session.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
      const { credentials } = req.body || {};
      if (!Array.isArray(credentials) || credentials.length === 0) {
        return res.status(400).json({ error: 'Se requiere un array de credenciales' });
      }
      // Límites para evitar abuso/DoS y entradas malformadas. El blob cifrado
      // (ct) puede ser grande si lleva las tarjetas DGII, pero acotado.
      if (credentials.length > 500) {
        return res.status(400).json({ error: 'Demasiadas credenciales en una sola petición (máx. 500)' });
      }
      const okStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
      for (const c of credentials) {
        if (!okStr(c && c.id, 200) || !okStr(c.iv, 256) || !okStr(c.ct, 200000)) {
          return res.status(400).json({ error: 'Cada credencial requiere id, iv y ct válidos' });
        }
        if (typeof c.institution !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(c.institution)) {
          return res.status(400).json({ error: 'Institución no válida' });
        }
      }
      const count = await db.upsertCredentials(session.tenantId, credentials);
      return res.json({ ok: true, count });
    }
    res.status(405).end();
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Error interno del servidor' });
  }
};
