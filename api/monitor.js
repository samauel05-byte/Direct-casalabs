// Monitor DGII — único punto de entrada de la API (Vercel Hobby limita las
// funciones). vercel.json reescribe /api/monitor/<ruta> → /api/monitor?route=<ruta>.
//
// Lectura (cualquier usuario autorizado): estado e historial almacenados.
// Administración (rol admin): configurar, pausar, verificación manual, alertas.
// Cron (secreto): ejecuta las comprobaciones desde el servidor cada minuto.
//
// La actualización del panel SOLO lee datos guardados; no genera peticiones a la
// DGII por cada visitante. Las nuevas peticiones a la DGII salen únicamente del
// proceso programado (ruta 'cron') o de una verificación manual de administrador.

const { authenticate } = require('../lib/auth');
const { requireTenant } = require('../lib/tenant');
const { allow } = require('../lib/rate-limit');
const supabase = require('../lib/supabase');
const store = require('../lib/monitor/store');
const alerts = require('../lib/monitor/alerts');

function sendJson(res, code, obj) { res.status(code).json(obj); }

// ── Cron: ejecuta las comprobaciones pendientes y procesa alertas ───────────
async function handleCron(req, res) {
  const secret = process.env.MONITOR_CRON_SECRET || '';
  const cronSecret = process.env.CRON_SECRET || '';
  if (!secret && !cronSecret) return sendJson(res, 503, { error: 'MONITOR_CRON_SECRET no configurado' });
  // Acepta: (a) el scheduler propio (Cloudflare Worker / cron externo) con el
  // secreto en cabecera; (b) el cron de Vercel, que envía Authorization: Bearer
  // CRON_SECRET. Cualquiera de los dos autoriza la corrida.
  const given = req.headers['x-monitor-secret'] || (req.query && req.query.key) || '';
  const auth = String(req.headers['authorization'] || '');
  const okOwn = secret && given === secret;
  const okVercel = cronSecret && auth === `Bearer ${cronSecret}`;
  if (!okOwn && !okVercel) return sendJson(res, 401, { error: 'No autorizado' });
  // Envío de prueba controlado para operaciones (protegido por el mismo secreto):
  // POST /api/monitor/cron?test=<correo> manda un correo de prueba por SMTP y responde.
  if (req.query && req.query.test) {
    const to = String(req.query.test).trim().toLowerCase();
    const r = await alerts.sendTest(to);
    return sendJson(res, 200, { ok: r.ok, test: to, error: r.error || null });
  }
  try {
    const { ran, changes } = await store.runDueChecks({});
    const alertResult = await alerts.processChanges(changes);
    // Poda ocasional (≈1% de las corridas) para no borrar en cada minuto.
    if (Math.random() < 0.01) await store.prune();
    // Heartbeat externo (dead-man switch) si está configurado.
    const hb = process.env.MONITOR_HEARTBEAT_URL;
    if (hb) { try { await fetch(hb, { method: 'GET' }); } catch {} }
    return sendJson(res, 200, { ok: true, ran, changes: changes.length, alerts: alertResult });
  } catch (e) {
    console.error('monitor cron', e); return sendJson(res, 500, { error: 'Error interno del servidor' });
  }
}

module.exports = async (req, res) => {
  const route = String((req.query && req.query.route) || '').replace(/^\/+/, '');

  // El cron no usa sesión de usuario (lo invoca el scheduler con un secreto).
  if (route === 'cron') return handleCron(req, res);

  const session = await authenticate(req);
  if (!session) return sendJson(res, 401, { error: 'No autorizado' });
  const isAdmin = session.role === 'admin';

  try {
    // ── Lectura (cualquier usuario autorizado) ──────────────────────────────
    if (req.method === 'GET' && (route === '' || route === 'status')) {
      const snapshot = await store.getStatusSnapshot();
      // Conteo de alertas pendientes de la firma + si hay proveedor de correo.
      let pendingAlerts = 0;
      if (session.tenantId) {
        const { count } = await supabase.from(store.T.notif).select('id', { count: 'exact', head: true })
          .eq('tenant_id', session.tenantId).in('status', ['pending', 'failed']);
        pendingAlerts = count || 0;
      }
      return sendJson(res, 200, { ok: true, ...snapshot, isAdmin, alertsProvider: alerts.providerConfigured(), pendingAlerts });
    }

    if (req.method === 'GET' && route === 'day') {
      const checkId = String(req.query.check_id || '');
      const date = String(req.query.date || '');
      if (!checkId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'check_id y date (YYYY-MM-DD) requeridos' });
      const detail = await store.getDayDetail(checkId, date);
      return sendJson(res, 200, { ok: true, ...detail });
    }

    // Registro de verificaciones (programadas y manuales) — paginado y filtrable.
    if (req.method === 'GET' && route === 'checks-log') {
      const q = req.query || {};
      const page = Math.max(0, parseInt(q.page, 10) || 0);
      const pageSize = Math.min(100, Math.max(10, parseInt(q.pageSize, 10) || 50));
      const log = await store.getChecksLog({
        checkId: q.check_id || null, environment: q.environment || null, source: q.source || null,
        status: q.status || null, from: q.from || null, to: q.to || null, page, pageSize,
      });
      return sendJson(res, 200, { ok: true, ...log });
    }

    // Historial de incidentes (todos los servicios) con filtros.
    if (req.method === 'GET' && route === 'incidents') {
      const q = req.query || {};
      const incidents = await store.getIncidentsList({
        checkId: q.check_id || null, environment: q.environment || null, status: q.status || null,
        from: q.from || null, to: q.to || null,
      });
      return sendJson(res, 200, { ok: true, incidents });
    }

    // ── Administración (rol admin + firma) ──────────────────────────────────
    if (!isAdmin) return sendJson(res, 403, { error: 'Solo administradores' });
    if (!requireTenant(res, session.tenantId)) return;

    if (req.method === 'GET' && route === 'admin') {
      const checks = await store.listChecks();
      const settings = await store.getSettings();
      const { data: subs } = await supabase.from(store.T.subs).select('*').eq('tenant_id', session.tenantId).order('created_at');
      const { data: notifs } = await supabase.from(store.T.notif).select('*').eq('tenant_id', session.tenantId).order('created_at', { ascending: false }).limit(50);
      const audit = await store.listAudit(50);
      return sendJson(res, 200, { ok: true, checks, settings, subscriptions: subs || [], notifications: notifs || [], audit, alertsProvider: alerts.providerConfigured() });
    }

    const actor = { actorId: session.userId, actorName: session.username };

    // Ajustes globales del monitoreo (retención, umbral de suficiencia, etc.).
    if (req.method === 'POST' && route === 'settings') {
      const b = req.body || {};
      const allowed = { retention_days: [1, 400], min_observations: [1, 1000], manual_min_interval_s: [5, 3600], stale_after_s: [60, 3600] };
      const changed = {};
      for (const k of Object.keys(allowed)) {
        if (b[k] !== undefined) { const v = Math.max(allowed[k][0], Math.min(allowed[k][1], parseInt(b[k], 10) || allowed[k][0])); await store.setSetting(k, v); changed[k] = v; }
      }
      if (!Object.keys(changed).length) return sendJson(res, 400, { error: 'Sin cambios' });
      await store.recordAudit({ ...actor, action: 'settings', target: 'global', detail: changed });
      return sendJson(res, 200, { ok: true });
    }

    // Envío de prueba de correo a un destinatario configurado expresamente.
    if (req.method === 'POST' && route === 'alert-test') {
      const ok = await allow(req, 'monitor_alert_test', 3, 5 * 60 * 1000, session.userId);
      if (!ok) return sendJson(res, 429, { error: 'Espera antes de enviar otra prueba' });
      const to = String((req.body && req.body.email) || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return sendJson(res, 400, { error: 'Correo de prueba no válido' });
      await store.setSetting('alert_test_recipient', to);
      const r = await alerts.sendTest(to);
      await store.recordAudit({ ...actor, action: 'alert_test', target: to, detail: { ok: r.ok, error: r.error || null } });
      if (!r.ok) return sendJson(res, 200, { ok: false, error: r.error });
      return sendJson(res, 200, { ok: true });
    }

    // Configurar / pausar una comprobación.
    if (req.method === 'POST' && route === 'config') {
      const b = req.body || {};
      if (!b.id) return sendJson(res, 400, { error: 'id requerido' });
      const upd = {};
      for (const k of ['enabled', 'degraded_ms', 'timeout_ms', 'interval_s', 'fail_threshold', 'recover_threshold']) {
        if (b[k] !== undefined) upd[k] = k === 'enabled' ? !!b[k] : Math.max(1, parseInt(b[k], 10) || 0);
      }
      if (!Object.keys(upd).length) return sendJson(res, 400, { error: 'Sin cambios' });
      upd.updated_at = new Date().toISOString();
      const { error } = await supabase.from(store.T.checks).update(upd).eq('id', b.id);
      if (error) throw error;
      const action = ('enabled' in upd && Object.keys(upd).length === 2) ? (upd.enabled ? 'resume' : 'pause') : 'config';
      await store.recordAudit({ ...actor, action, target: b.id, detail: upd });
      return sendJson(res, 200, { ok: true });
    }

    // Verificación manual (con límite de frecuencia).
    if (req.method === 'POST' && route === 'check') {
      const s = await store.getSettings();
      const ok = await allow(req, 'monitor_manual', 5, (s.manual_min_interval_s || 30) * 1000, session.userId);
      if (!ok) return sendJson(res, 429, { error: 'Espera un momento antes de volver a verificar manualmente' });
      const id = String((req.body && req.body.id) || '');
      const checks = await store.listChecks();
      const targets = id ? checks.filter(c => c.id === id) : checks.filter(c => c.enabled);
      const changes = [];
      for (const c of targets) { try { const { change } = await store.performCheck(c, { source: 'manual' }); if (change) changes.push(change); } catch (e) { console.error(e.message); } }
      await alerts.processChanges(changes);
      await store.recordAudit({ ...actor, action: 'manual_check', target: id || 'todas', detail: { ran: targets.length } });
      return sendJson(res, 200, { ok: true, ran: targets.length });
    }

    // Alertas: crear/actualizar/eliminar suscripciones (privadas por firma).
    if (req.method === 'POST' && route === 'subscriptions') {
      const b = req.body || {};
      if (b.delete && b.id) {
        const { error } = await supabase.from(store.T.subs).delete().eq('id', b.id).eq('tenant_id', session.tenantId);
        if (error) throw error;
        await store.recordAudit({ ...actor, action: 'subscription', target: 'delete', detail: { id: b.id } });
        return sendJson(res, 200, { ok: true });
      }
      const email = String(b.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(res, 400, { error: 'Correo no válido' });
      const row = {
        tenant_id: session.tenantId, email,
        check_id: b.check_id || null,
        on_incident: b.on_incident !== false, on_recovery: b.on_recovery !== false, on_stale: b.on_stale !== false,
        enabled: b.enabled !== false,
      };
      if (b.id) {
        const { error } = await supabase.from(store.T.subs).update(row).eq('id', b.id).eq('tenant_id', session.tenantId);
        if (error) throw error;
      } else {
        // Buscar-y-insertar/actualizar (check_id puede ser null, así que no se usa upsert).
        let q = supabase.from(store.T.subs).select('id').eq('tenant_id', session.tenantId).eq('email', email);
        q = row.check_id ? q.eq('check_id', row.check_id) : q.is('check_id', null);
        const { data: exist } = await q.maybeSingle();
        if (exist) {
          const { error } = await supabase.from(store.T.subs).update(row).eq('id', exist.id);
          if (error) throw error;
        } else {
          const { error } = await supabase.from(store.T.subs).insert(row);
          if (error) throw error;
        }
      }
      await store.recordAudit({ ...actor, action: 'subscription', target: email, detail: { check_id: row.check_id, enabled: row.enabled } });
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: 'Ruta no encontrada' });
  } catch (e) {
    console.error('monitor api', e); return sendJson(res, 500, { error: 'Error interno del servidor' });
  }
};
