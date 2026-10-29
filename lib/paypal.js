// PayPal (suscripciones mensuales). Variables de entorno:
//   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET  credenciales de la app de PayPal
//   PAYPAL_WEBHOOK_ID                       id del webhook que apunta a /api/licenses/paypal-webhook
//   PAYPAL_ENV                              «live» (por defecto) o «sandbox»
//   PAYPAL_PLANS                            opcional: {"P-XXXX":{"plan":"Completo","max_users":5}}
const BASE_LIVE = 'https://api-m.paypal.com';
const BASE_SANDBOX = 'https://api-m.sandbox.paypal.com';

const base = () => process.env.PAYPAL_BASE_URL || (process.env.PAYPAL_ENV === 'sandbox' ? BASE_SANDBOX : BASE_LIVE);
const configured = () => !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET && process.env.PAYPAL_WEBHOOK_ID);

let cached = null;
async function accessToken() {
  if (cached && cached.exp > Date.now() + 30000) return cached.token;
  const r = await fetch(`${base()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials', signal: AbortSignal.timeout(10000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error('PayPal: no se pudo autenticar');
  cached = { token: d.access_token, exp: Date.now() + (d.expires_in || 300) * 1000 };
  return cached.token;
}

async function api(path, init = {}) {
  const r = await fetch(`${base()}${path}`, { ...init, signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`PayPal ${r.status}: ${d.message || d.name || 'error'}`);
  return d;
}

// Confirma con PayPal que el aviso es auténtico (firma del webhook).
async function verifyWebhook(headers, event) {
  if (!configured()) return false;
  const h = k => headers[k] || headers[k.toLowerCase()] || '';
  try {
    const d = await api('/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      body: JSON.stringify({
        auth_algo: h('paypal-auth-algo'), cert_url: h('paypal-cert-url'), transmission_id: h('paypal-transmission-id'),
        transmission_sig: h('paypal-transmission-sig'), transmission_time: h('paypal-transmission-time'),
        webhook_id: process.env.PAYPAL_WEBHOOK_ID, webhook_event: event,
      }),
    });
    return d.verification_status === 'SUCCESS';
  } catch { return false; }
}

const getSubscription = id => api(`/v1/billing/subscriptions/${encodeURIComponent(id)}`);
const getPlan = id => api(`/v1/billing/plans/${encodeURIComponent(id)}`);

function planInfo(planId, paypalPlanName) {
  let map = {};
  try { map = JSON.parse(process.env.PAYPAL_PLANS || '{}'); } catch { /* sin mapa */ }
  const m = map[planId] || {};
  return { plan: m.plan || paypalPlanName || 'PayPal', maxUsers: Number.isInteger(m.max_users) ? m.max_users : null };
}

module.exports = { configured, verifyWebhook, getSubscription, getPlan, planInfo };
