// Enlace de baja automático de las promociones. El enlace lleva un token firmado (HMAC) con la firma y el correo:
// nadie puede darse de baja por otro ni inventar un enlace sin la clave del servidor. No caduca (un enlace de baja debe seguir sirviendo).
const crypto = require('crypto');

const secret = () => process.env.COBROS_UNSUB_SECRET || process.env.CRON_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const b64 = buf => Buffer.from(buf).toString('base64url');
const mac = payload => b64(crypto.createHmac('sha256', secret()).update('cobros-baja:' + payload).digest());
const appUrl = () => String(process.env.PUBLIC_APP_URL || 'https://app.casalabs.com.do').replace(/\/+$/, '');

function sign(tenantId, email) {
  if (!secret()) throw new Error('Falta una clave del servidor para firmar los enlaces de baja.');
  const payload = b64(JSON.stringify({ t: tenantId, e: String(email).trim().toLowerCase() }));
  return `${payload}.${mac(payload)}`;
}

// → { tenantId, email } o null si el token no es auténtico.
function verify(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig || !secret()) return null;
  const good = Buffer.from(mac(payload)), given = Buffer.from(sig);
  if (good.length !== given.length || !crypto.timingSafeEqual(good, given)) return null;
  try {
    const { t, e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return t && e ? { tenantId: String(t), email: String(e) } : null;
  } catch { return null; }
}

const pageLink = token => `${appUrl()}/baja?t=${encodeURIComponent(token)}`;
const oneClickUrl = token => `${appUrl()}/api/cobros/unsubscribe?t=${encodeURIComponent(token)}`;

// Cabeceras estándar (RFC 8058): Gmail/Outlook muestran su botón «Cancelar suscripción» y la baja es de un clic.
function headers(token) {
  return { 'List-Unsubscribe': `<${oneClickUrl(token)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

const maskEmail = e => { const [u, d] = String(e).split('@'); return `${u.slice(0, 2)}${'*'.repeat(Math.max(1, u.length - 2))}@${d}`; };

module.exports = { sign, verify, pageLink, oneClickUrl, headers, maskEmail, appUrl };
