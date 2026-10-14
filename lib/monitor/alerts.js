// Alertas por correo del Monitor DGII.
//
// Pipeline:
//  1) Un cambio de estado confirmado (incidente abierto/cerrado, o monitor
//     detenido) genera una fila en dgii_monitor_notifications por cada
//     destinatario suscrito. El índice único (incident_id,email,kind) evita
//     duplicados: un solo aviso por cambio de estado.
//  2) Se intenta enviar por un proveedor compatible (Resend, vía HTTPS). Si no
//     hay proveedor configurado (variables de entorno ausentes), la fila queda
//     'pending' y el panel avisa que las alertas están pendientes de configurar.
//  3) Reintentos controlados: cada corrida reintenta las 'pending'/'failed' con
//     menos de MAX_ATTEMPTS intentos.
//
// Seguridad: nunca se exponen claves ni certificados. Las suscripciones y el
// registro de notificaciones son privados por firma (tenant).

const supabase = require('../supabase');
const { T } = require('./store');

const MAX_ATTEMPTS = 5;
const APP_URL = process.env.MONITOR_APP_URL || 'https://app.casalabs.com.do';
const RESEND_KEY = process.env.MONITOR_RESEND_API_KEY || '';
const ALERT_FROM = process.env.MONITOR_ALERT_FROM || '';

function providerConfigured() { return !!(RESEND_KEY && ALERT_FROM); }

function rdTime(iso) {
  try {
    return new Intl.DateTimeFormat('es-DO', {
      timeZone: 'America/Santo_Domingo', dateStyle: 'medium', timeStyle: 'medium',
    }).format(new Date(iso));
  } catch { return iso; }
}

function subject(kind, check) {
  const amb = check.environment?.toUpperCase();
  if (kind === 'incident') return `🔴 Monitor DGII — Incidente: ${check.name} (${amb})`;
  if (kind === 'recovery') return `🟢 Monitor DGII — Recuperado: ${check.name} (${amb})`;
  return `🟠 Monitor DGII — El monitor dejó de ejecutar comprobaciones`;
}

function body(kind, check, incident) {
  const when = rdTime((incident?.confirmed_at || incident?.resolved_at) || new Date().toISOString());
  const lines = [];
  if (kind === 'incident') {
    lines.push(`Se confirmó un incidente en una comprobación de la DGII.`);
    lines.push(`Servicio: ${check.name}`);
    lines.push(`Ambiente: ${check.environment}`);
    lines.push(`Qué verifica: ${check.description}`);
    lines.push(`Confirmado (hora RD): ${when}`);
    if (incident?.error_type) lines.push(`Tipo de error: ${incident.error_type} — ${incident.error_detail || ''}`);
  } else if (kind === 'recovery') {
    lines.push(`La comprobación volvió a responder correctamente.`);
    lines.push(`Servicio: ${check.name}`);
    lines.push(`Ambiente: ${check.environment}`);
    lines.push(`Recuperado (hora RD): ${rdTime(incident?.resolved_at || new Date().toISOString())}`);
  } else {
    lines.push(`El Monitor DGII dejó de ejecutar comprobaciones. Revisa el proceso programado.`);
    lines.push(`Hora RD: ${when}`);
  }
  lines.push('');
  lines.push(`Abrir el módulo: ${APP_URL}`);
  lines.push('');
  lines.push('Monitor independiente de Direct. El estado refleja las comprobaciones indicadas y no garantiza el funcionamiento de todos los servicios de la DGII.');
  const text = lines.join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;line-height:1.5">${lines.map(l => l ? `<p style="margin:4px 0">${l.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</p>` : '<br>').join('')}</div>`;
  return { text, html };
}

async function sendEmail(to, subj, content) {
  if (!providerConfigured()) return { ok: false, error: 'proveedor_no_configurado' };
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: ALERT_FROM, to: [to], subject: subj, text: content.text, html: content.html }),
    });
    if (resp.ok) return { ok: true };
    const t = await resp.text().catch(() => '');
    return { ok: false, error: `http_${resp.status}: ${String(t).slice(0, 160)}` };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}

// Crea las filas de notificación para un cambio de estado (dedup por índice único).
async function enqueueForChange(change) {
  const kind = change.event === 'opened' ? 'incident' : 'recovery';
  const check = change.check;
  if (!(kind === 'incident' ? true : true)) return;
  // Suscripciones activas que cubren esta comprobación y este tipo de aviso.
  const { data: subs } = await supabase.from(T.subs)
    .select('*').eq('enabled', true)
    .or(`check_id.is.null,check_id.eq.${check.id}`);
  const wantField = kind === 'incident' ? 'on_incident' : 'on_recovery';
  for (const s of subs || []) {
    if (!s[wantField]) continue;
    await supabase.from(T.notif).insert({
      tenant_id: s.tenant_id, email: s.email, incident_id: change.incident?.id || null, kind,
      status: 'pending', attempts: 0,
    }).then(() => {}, () => {}); // el índice único ignora duplicados
  }
}

// Intenta enviar las notificaciones pendientes/fallidas (reintentos controlados).
async function flushNotifications() {
  if (!providerConfigured()) return { sent: 0, pending: await countPending(), provider: false };
  const { data: pend } = await supabase.from(T.notif)
    .select('*').in('status', ['pending', 'failed']).lt('attempts', MAX_ATTEMPTS).order('created_at').limit(50);
  let sent = 0;
  for (const n of pend || []) {
    // Recupera el incidente y la comprobación para el contenido.
    let check = null, incident = null;
    if (n.incident_id) {
      const { data: inc } = await supabase.from(T.incidents).select('*').eq('id', n.incident_id).maybeSingle();
      incident = inc;
      if (inc) { const { data: c } = await supabase.from(T.checks).select('*').eq('id', inc.check_id).maybeSingle(); check = c; }
    }
    if (!check) { // sin contexto: marca como fallida controladamente
      await supabase.from(T.notif).update({ status: 'failed', attempts: n.attempts + 1, error: 'sin_contexto' }).eq('id', n.id);
      continue;
    }
    const content = body(n.kind, check, incident);
    const r = await sendEmail(n.email, subject(n.kind, check), content);
    if (r.ok) { await supabase.from(T.notif).update({ status: 'sent', attempts: n.attempts + 1, sent_at: new Date().toISOString(), error: null }).eq('id', n.id); sent++; }
    else { await supabase.from(T.notif).update({ status: 'failed', attempts: n.attempts + 1, error: r.error }).eq('id', n.id); }
  }
  return { sent, pending: await countPending(), provider: true };
}

async function countPending() {
  const { count } = await supabase.from(T.notif).select('id', { count: 'exact', head: true }).in('status', ['pending', 'failed']);
  return count || 0;
}

async function processChanges(changes) {
  for (const ch of changes || []) { try { await enqueueForChange(ch); } catch (e) { console.error('alert enqueue', e.message); } }
  return flushNotifications();
}

module.exports = { providerConfigured, processChanges, flushNotifications, enqueueForChange, countPending, rdTime };
