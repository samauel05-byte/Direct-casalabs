const crypto = require('crypto');
const supabase = require('./supabase');

const GRACE_DAYS = 5;
const LINK_DAYS = 14;
const APP_URL = process.env.MONITOR_APP_URL || 'https://app.casalabs.com.do';

const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = token => crypto.createHash('sha256').update(String(token || '')).digest('hex');
const activationLink = token => `${APP_URL}/activar?t=${token}`;

// Estado de la licencia de una firma. license_until null = sin vencimiento (firmas
// anteriores a las licencias). Tras el vencimiento hay GRACE_DAYS de gracia.
function stateOf(t, now = Date.now()) {
  if (!t) return { blocked: false, code: 'none' };
  if (t.license_status === 'suspended') return { blocked: true, code: 'suspended', message: 'La licencia de su firma está suspendida. Comuníquese con soporte.' };
  if (!t.license_until) return { blocked: false, code: 'unlimited' };
  const until = new Date(t.license_until).getTime();
  if (now <= until) return { blocked: false, code: 'active', daysLeft: Math.ceil((until - now) / 864e5) };
  if (now <= until + GRACE_DAYS * 864e5) return { blocked: false, code: 'grace', graceDaysLeft: Math.ceil((until + GRACE_DAYS * 864e5 - now) / 864e5) };
  return { blocked: true, code: 'expired', message: 'La licencia de su firma venció. Renuévela con soporte para seguir usando Direct.' };
}

// Caché corta por firma para no consultar la tabla en cada petición.
const cache = new Map();
async function tenantState(tenantId) {
  if (!tenantId) return { blocked: false, code: 'none' };
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < 60000) return hit.state;
  let state = { blocked: false, code: 'none' };
  try {
    const { data, error } = await supabase.from('direct_tenants').select('license_until, license_status').eq('id', tenantId).maybeSingle();
    if (!error && data) state = stateOf(data);
  } catch { /* sin migración o sin red: no se bloquea */ }
  cache.set(tenantId, { at: Date.now(), state });
  return state;
}
const forget = tenantId => cache.delete(tenantId);

async function isPlatformAdmin(userId) {
  try {
    const { data, error } = await supabase.from('direct_profiles').select('is_platform_admin').eq('id', userId).maybeSingle();
    return !error && data?.is_platform_admin === true;
  } catch { return false; }
}

function mailConfig() {
  const e = process.env;
  const host = e.LICENSE_SMTP_HOST || e.MONITOR_SMTP_HOST || '';
  const user = e.LICENSE_SMTP_USER || e.MONITOR_SMTP_USER || '';
  const pass = e.LICENSE_SMTP_PASS || e.MONITOR_SMTP_PASS || '';
  const from = e.LICENSE_FROM || e.MONITOR_ALERT_FROM || user;
  return { host, user, pass, from, port: Number(e.LICENSE_SMTP_PORT || e.MONITOR_SMTP_PORT || 587), ok: !!(host && user && pass && from) };
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Devuelve true si se envió; false si no hay correo configurado (el enlace se
// entrega igual en la respuesta para copiarlo y mandarlo por otro medio).
async function sendActivationEmail({ to, customer, link, plan, months }) {
  const m = mailConfig();
  if (!m.ok) return false;
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({ host: m.host, port: m.port, secure: m.port === 465, auth: { user: m.user, pass: m.pass } });
  const text = `Hola ${customer},\n\nGracias por adquirir Direct${plan ? ` (plan ${plan})` : ''}. Para crear su acceso y configurar su firma abra este enlace (es de un solo uso y vence en ${LINK_DAYS} días):\n\n${link}\n\nEn esa página elegirá el nombre de su firma, su usuario y su contraseña. Guárdela bien: no se puede recuperar. Su licencia cubre ${months} mes(es) desde la activación.\n\nSi usted no solicitó esto, ignore este mensaje.`;
  const html = `<p>Hola ${esc(customer)},</p><p>Gracias por adquirir <b>Direct</b>${plan ? ` (plan ${esc(plan)})` : ''}. Para crear su acceso y configurar su firma abra este enlace (es de un solo uso y vence en ${LINK_DAYS} días):</p><p><a href="${esc(link)}">${esc(link)}</a></p><p>En esa página elegirá el nombre de su firma, su usuario y su contraseña. <b>Guárdela bien: no se puede recuperar.</b> Su licencia cubre ${months} mes(es) desde la activación.</p><p style="color:#888">Si usted no solicitó esto, ignore este mensaje.</p>`;
  await t.sendMail({ from: m.from, to, subject: 'Active su licencia de Direct', text, html });
  return true;
}

module.exports = { GRACE_DAYS, LINK_DAYS, newToken, hashToken, activationLink, stateOf, tenantState, forget, isPlatformAdmin, sendActivationEmail, mailConfig };
