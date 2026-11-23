// Único punto de entrada de Cobros (una sola función Vercel, como Nómina y NALA).
// vercel.json reescribe /api/cobros/<ruta> → /api/cobros?route=<ruta>.
// Módulo restringido: solo entra quien tenga access_cobros (sin atajo para administradores).
const crypto = require('crypto');
const { authenticate } = require('../lib/auth');
const { HttpError, fail } = require('../lib/nala/http');
const api = require('../lib/cobros/api');

// El cron diario de Vercel envía Authorization: Bearer CRON_SECRET; no lleva sesión de usuario.
function cronAuthorized(req) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return [process.env.COBROS_CRON_SECRET, process.env.CRON_SECRET].filter(x => x && x.length >= 16)
    .some(secret => token.length === secret.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret)));
}

async function cobrosContext(req) {
  const session = await authenticate(req);
  if (!session) fail(401, 'No autorizado');
  if (!session.access_cobros) fail(403, 'Sin acceso a Cobros');
  if (!session.tenantId) fail(503, 'La migración multiempresa todavía no está aplicada.');
  return { session, userId: session.userId, tenantId: session.tenantId };
}

const ROUTES = [
  ['GET', /^me$/, ctx => api.me(ctx)],
  ['GET', /^dashboard$/, ctx => api.dashboard(ctx)],
  ['GET', /^clients$/, ctx => api.listClients(ctx)],
  ['POST', /^clients$/, (ctx, q, b) => api.createClient(ctx, b)],
  ['DELETE', /^clients\/([^/]+)$/, (ctx, q, b, m) => api.deleteClient(ctx, m[1])],
  ['POST', /^clients\/([^/]+)\/optout$/, (ctx, q, b, m) => api.optOut(ctx, m[1], b)],
  ['GET', /^fx$/, ctx => api.fxRate(ctx)],
  ['GET', /^invoices$/, ctx => api.listInvoices(ctx)],
  ['POST', /^invoices$/, (ctx, q, b) => api.createInvoice(ctx, b)],
  ['POST', /^invoices\/([^/]+)\/remind$/, (ctx, q, b, m) => api.remindInvoice(ctx, m[1])],
  ['POST', /^invoices\/([^/]+)\/notice-days$/, (ctx, q, b, m) => api.setRemindDays(ctx, m[1], b)],
  ['POST', /^invoices\/([^/]+)\/paypal$/, (ctx, q, b, m) => api.paypalLink(ctx, m[1], b)],
  ['POST', /^invoices\/([^/]+)\/paypal-check$/, (ctx, q, b, m) => api.checkPaypal(ctx, m[1])],
  ['POST', /^invoices\/([^/]+)\/paid$/, (ctx, q, b, m) => api.markPaid(ctx, m[1])],
  ['GET', /^campaigns$/, ctx => api.listCampaigns(ctx)],
  ['POST', /^campaigns\/send$/, (ctx, q, b) => api.sendCampaign(ctx, b)],
  ['GET', /^log$/, ctx => api.listLog(ctx)],
];

module.exports = async (req, res) => {
  const route = String(req.query?.route || '').replace(/^\/+|\/+$/g, '');
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (route === 'cron' && ['GET', 'POST'].includes(req.method)) {
      if (!cronAuthorized(req)) return res.status(401).json({ error: 'No autorizado' });
      return res.json({ ok: true, ...(await api.runDaily()) });
    }
    const match = ROUTES.map(([method, re, fn]) => ({ method, m: re.exec(route), fn })).filter(r => r.m);
    if (!match.length) return res.status(404).json({ error: 'Ruta no encontrada' });
    const handler = match.find(r => r.method === req.method);
    if (!handler) return res.status(405).json({ error: 'Método no permitido' });
    const ctx = await cobrosContext(req);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = await handler.fn(ctx, req.query || {}, body, handler.m);
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message, ...error.extra });
    console.error('[cobros]', route, error);
    return res.status(500).json({ error: 'Error interno de Cobros. Intente nuevamente.' });
  }
};
