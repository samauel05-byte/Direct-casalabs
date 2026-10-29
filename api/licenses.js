// Licencias de Direct. vercel.json reescribe /api/licenses/<ruta> → /api/licenses?route=<ruta>.
//
// Público (con el enlace de un solo uso que llega por correo):
//   GET  /api/licenses/activate?token=…   datos de la licencia pendiente
//   POST /api/licenses/activate           crea la firma, su administrador y su bóveda
// Sólo super-administrador (root, direct_profiles.is_platform_admin):
//   GET  /api/licenses/list               licencias y firmas
//   POST /api/licenses/create             emite una licencia y manda el enlace
//   POST /api/licenses/resend             renueva el enlace de una pendiente
//   POST /api/licenses/revoke             anula una pendiente
//   POST /api/licenses/extend             suma meses a una firma
//   POST /api/licenses/suspend | resume   suspende o reactiva una firma
const supabase = require('../lib/supabase');
const db = require('../lib/db');
const { authenticate } = require('../lib/auth');
const { allow } = require('../lib/rate-limit');
const L = require('../lib/licenses');

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const RESERVED = new Set(['root', 'admin', 'administrador', 'soporte', 'support', 'direct', 'sistema', 'system']);
const fail = (res, code, msg) => res.status(code).json({ error: msg });

function addMonths(from, months) {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function slugOf(name) {
  const base = String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return base.length >= 2 ? base : 'firma';
}

async function activateInfo(req, res) {
  if (!await allow(req, 'activate-info', 30, 15 * 60 * 1000)) return fail(res, 429, 'Demasiados intentos. Intenta nuevamente en unos minutos.');
  const token = String(req.query.token || '');
  if (token.length < 20 || token.length > 100) return fail(res, 404, 'Este enlace no es válido.');
  const { data, error } = await supabase.from('direct_licenses').select('customer_name, plan, months, status, link_expires_at').eq('token_hash', L.hashToken(token)).maybeSingle();
  if (error) throw error;
  if (!data || data.status !== 'pending' || new Date(data.link_expires_at) < new Date()) return fail(res, 404, 'Este enlace no es válido, ya se usó o venció. Pida uno nuevo a soporte.');
  return res.json({ ok: true, customerName: data.customer_name, plan: data.plan, months: data.months });
}

async function activate(req, res) {
  if (!await allow(req, 'activate', 10, 15 * 60 * 1000)) return fail(res, 429, 'Demasiados intentos. Intenta nuevamente en unos minutos.');
  const b = req.body || {};
  const token = String(b.token || '');
  const firmName = typeof b.firmName === 'string' ? b.firmName.trim().replace(/\s+/g, ' ') : '';
  const username = typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  if (token.length < 20 || token.length > 100) return fail(res, 404, 'Este enlace no es válido.');
  if (firmName.length < 2 || firmName.length > 120) return fail(res, 400, 'Escribe el nombre de tu firma (2 a 120 caracteres).');
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) return fail(res, 400, 'El usuario debe tener 3 a 64 caracteres: letras, números, punto, guion o guion bajo.');
  if (RESERVED.has(username)) return fail(res, 400, 'Ese usuario no está disponible. Elige otro.');
  if (password.length < 8 || password.length > 200) return fail(res, 400, 'La contraseña debe tener al menos 8 caracteres.');
  const { userSalt, vaultKeyIv, vaultKeyCt, vaultSalt, verifierIv, verifierCt } = b;
  const okB64 = (v, max) => typeof v === 'string' && v.length <= max && B64.test(v);
  if (typeof userSalt !== 'string' || !/^v2\$[A-Za-z0-9+/]{22}={2}$/.test(userSalt) || !okB64(vaultKeyIv, 32) || !okB64(vaultKeyCt, 256)
    || !okB64(vaultSalt, 48) || !okB64(verifierIv, 32) || !okB64(verifierCt, 256)) return fail(res, 400, 'Datos de seguridad inválidos. Recarga la página e inténtalo de nuevo.');

  // Se reclama la licencia de forma atómica: sólo una persona puede usar el enlace.
  const now = new Date();
  const { data: claimed, error: claimErr } = await supabase.from('direct_licenses')
    .update({ status: 'activated', activated_at: now.toISOString() })
    .eq('token_hash', L.hashToken(token)).eq('status', 'pending').gt('link_expires_at', now.toISOString())
    .select('id, customer_email, plan, months, max_users').maybeSingle();
  if (claimErr) throw claimErr;
  if (!claimed) return fail(res, 404, 'Este enlace no es válido, ya se usó o venció. Pida uno nuevo a soporte.');

  const undoClaim = () => supabase.from('direct_licenses').update({ status: 'pending', activated_at: null, tenant_id: null }).eq('id', claimed.id);
  let tenantId = null, userId = null;
  try {
    for (let i = 0; i < 6 && !tenantId; i++) {
      const slug = i === 0 ? slugOf(firmName) : `${slugOf(firmName).slice(0, 52)}-${Math.random().toString(36).slice(2, 6)}`;
      const { data, error } = await supabase.from('direct_tenants').insert({
        name: firmName, slug, license_until: addMonths(now, claimed.months).toISOString(), license_status: 'active',
        license_plan: claimed.plan || null, max_users: claimed.max_users || null, billing_email: claimed.customer_email,
      }).select('id').single();
      if (!error) tenantId = data.id;
      else if (error.code !== '23505') throw error;
    }
    if (!tenantId) throw new Error('No se pudo crear la firma');

    const created = await supabase.auth.admin.createUser({ email: `${username}@direct.local`, password, email_confirm: true });
    if (created.error) {
      await supabase.from('direct_tenants').delete().eq('id', tenantId); await undoClaim();
      if (/already|registered|exists/i.test(created.error.message || '')) return fail(res, 409, 'Ese usuario ya está en uso. Elige otro.');
      console.error(created.error); return fail(res, 400, 'No se pudo crear el usuario.');
    }
    userId = created.data.user.id;

    const { error: profileErr } = await supabase.from('direct_profiles').insert({
      id: userId, tenant_id: tenantId, role: 'admin',
      access_direct: true, access_cami: true, access_nala: true, access_nomina: true, access_ir2: true, access_estimacion: true, access_clientes: true,
      portals_direct: ['dgii', 'tss', 'trabajo', 'sirla', 'carnet', 'azul'],
      user_key_salt: userSalt, vault_key_iv: vaultKeyIv, vault_key_ct: vaultKeyCt,
    });
    if (profileErr) throw profileErr;
    await db.setConfig(tenantId, 'vaultSalt', vaultSalt);
    await db.setConfig(tenantId, 'verifierIv', verifierIv);
    await db.setConfig(tenantId, 'verifierCt', verifierCt);
    await supabase.from('direct_licenses').update({ tenant_id: tenantId }).eq('id', claimed.id);
    return res.json({ ok: true, username });
  } catch (e) {
    console.error('[licenses] activate', e);
    try {
      if (userId) await supabase.auth.admin.deleteUser(userId);
      if (tenantId) await supabase.from('direct_tenants').delete().eq('id', tenantId);
      await undoClaim();
    } catch { /* se informa el error original */ }
    return fail(res, 500, 'No se pudo completar la activación. Inténtalo de nuevo o escribe a soporte.');
  }
}

// ── Administración (sólo root) ──
async function requirePlatform(req, res) {
  const session = await authenticate(req);
  if (!session) { fail(res, 401, 'No autorizado'); return null; }
  if (session.role !== 'admin' || !await L.isPlatformAdmin(session.userId)) { fail(res, 403, 'Solo el administrador de la plataforma'); return null; }
  return session;
}

function cleanLicense(b) {
  const name = typeof b.customer_name === 'string' ? b.customer_name.trim().replace(/\s+/g, ' ') : '';
  const email = typeof b.customer_email === 'string' ? b.customer_email.trim().toLowerCase() : '';
  const months = Math.trunc(Number(b.months));
  const maxUsers = b.max_users === '' || b.max_users == null ? null : Math.trunc(Number(b.max_users));
  const plan = typeof b.plan === 'string' && b.plan.trim() ? b.plan.trim().slice(0, 60) : null;
  if (name.length < 2 || name.length > 160) return { error: 'Escribe el nombre del cliente.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 160) return { error: 'El correo del cliente no es válido.' };
  if (!(months >= 1 && months <= 36)) return { error: 'Los meses de licencia deben ser de 1 a 36.' };
  if (maxUsers !== null && !(maxUsers >= 1 && maxUsers <= 500)) return { error: 'El máximo de usuarios debe ser de 1 a 500.' };
  return { row: { customer_name: name, customer_email: email, months, max_users: maxUsers, plan, note: typeof b.note === 'string' ? b.note.slice(0, 300) : null } };
}

async function issue(row, createdBy) {
  const token = L.newToken();
  const { data, error } = await supabase.from('direct_licenses').insert({
    ...row, token_hash: L.hashToken(token), link_expires_at: new Date(Date.now() + L.LINK_DAYS * 864e5).toISOString(), created_by: createdBy,
  }).select('id').single();
  if (error) throw error;
  return { id: data.id, token, link: L.activationLink(token) };
}

async function sendMail(row, link) {
  try { return await L.sendActivationEmail({ to: row.customer_email, customer: row.customer_name, link, plan: row.plan, months: row.months }); }
  catch (e) { console.error('[licenses] correo', e.message); return false; }
}

async function admin(route, req, res) {
  const session = await requirePlatform(req, res);
  if (!session) return;
  const b = req.body || {};
  if (route === 'list' && req.method === 'GET') {
    const [lic, ten, prof] = await Promise.all([
      supabase.from('direct_licenses').select('id, customer_name, customer_email, plan, months, max_users, status, link_expires_at, tenant_id, created_at, activated_at, note').order('created_at', { ascending: false }).limit(300),
      supabase.from('direct_tenants').select('id, name, slug, license_until, license_status, license_plan, max_users, billing_email, created_at').order('created_at'),
      supabase.from('direct_profiles').select('tenant_id'),
    ]);
    if (lic.error) throw lic.error; if (ten.error) throw ten.error;
    const users = {};
    for (const p of prof.data || []) users[p.tenant_id] = (users[p.tenant_id] || 0) + 1;
    const mail = L.mailConfig();
    return res.json({ ok: true, emailConfigured: mail.ok, graceDays: L.GRACE_DAYS,
      licenses: lic.data || [],
      tenants: (ten.data || []).map(t => ({ ...t, users: users[t.id] || 0, state: L.stateOf(t) })) });
  }
  if (req.method !== 'POST') return fail(res, 405, 'Método no permitido');

  if (route === 'create') {
    const c = cleanLicense(b); if (c.error) return fail(res, 400, c.error);
    const out = await issue(c.row, session.userId);
    const emailSent = b.send_email === false ? false : await sendMail(c.row, out.link);
    return res.status(201).json({ ok: true, id: out.id, link: out.link, emailSent });
  }
  const id = typeof b.id === 'string' ? b.id : '';
  if (route === 'resend' || route === 'revoke') {
    const { data: lic, error } = await supabase.from('direct_licenses').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!lic || lic.status !== 'pending') return fail(res, 409, 'Solo se puede hacer esto con licencias pendientes.');
    if (route === 'revoke') { await supabase.from('direct_licenses').update({ status: 'revoked' }).eq('id', id); return res.json({ ok: true }); }
    const token = L.newToken();
    await supabase.from('direct_licenses').update({ token_hash: L.hashToken(token), link_expires_at: new Date(Date.now() + L.LINK_DAYS * 864e5).toISOString() }).eq('id', id);
    const link = L.activationLink(token);
    return res.json({ ok: true, link, emailSent: await sendMail(lic, link) });
  }
  if (route === 'extend' || route === 'suspend' || route === 'resume') {
    const tenantId = typeof b.tenant_id === 'string' ? b.tenant_id : '';
    const { data: t, error } = await supabase.from('direct_tenants').select('id, slug, license_until').eq('id', tenantId).maybeSingle();
    if (error) throw error;
    if (!t) return fail(res, 404, 'Firma no encontrada.');
    if (route === 'suspend' && t.slug === 'save') return fail(res, 409, 'La firma de la plataforma no se puede suspender.');
    let patch;
    if (route === 'suspend') patch = { license_status: 'suspended' };
    else if (route === 'resume') patch = { license_status: 'active' };
    else {
      const months = Math.trunc(Number(b.months));
      if (!(months >= 1 && months <= 36)) return fail(res, 400, 'Los meses deben ser de 1 a 36.');
      if (t.slug === 'save' && !t.license_until) return fail(res, 409, 'Esta firma no tiene vencimiento.');
      const from = t.license_until && new Date(t.license_until) > new Date() ? new Date(t.license_until) : new Date();
      patch = { license_until: addMonths(from, months).toISOString(), license_status: 'active' };
    }
    const { error: ue } = await supabase.from('direct_tenants').update(patch).eq('id', tenantId);
    if (ue) throw ue;
    L.forget(tenantId);
    return res.json({ ok: true });
  }
  return fail(res, 404, 'Ruta no encontrada');
}

module.exports = async (req, res) => {
  const route = String(req.query?.route || '').replace(/^\/+|\/+$/g, '');
  try {
    if (route === 'activate') {
      if (req.method === 'GET') return await activateInfo(req, res);
      if (req.method === 'POST') return await activate(req, res);
      return fail(res, 405, 'Método no permitido');
    }
    return await admin(route, req, res);
  } catch (e) {
    console.error('[licenses]', route, e);
    return fail(res, 500, 'Error interno del servidor');
  }
};
