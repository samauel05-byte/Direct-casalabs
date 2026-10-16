// Único punto de entrada de Nómina (una sola función Vercel, como NALA).
// vercel.json reescribe /api/nomina/<ruta> → /api/nomina?route=<ruta>.
const crypto = require('crypto');
const { nominaContext } = require('../lib/nomina/context');
const { HttpError } = require('../lib/nala/http');
const api = require('../lib/nomina/api');
const autoCron = require('../lib/nomina/cron');

// El cron de generación automática (Vercel Cron) se autentica con un secreto de
// servidor, igual que el worker de NALA; no lleva sesión de usuario.
function cronAuthorized(req) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return [process.env.NOMINA_CRON_SECRET, process.env.CRON_SECRET].filter(s => s && s.length >= 16)
    .some(secret => token.length === secret.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret)));
}

const ROUTES = [
  ['GET', /^me$/, ctx => api.me(ctx)],
  ['GET', /^clients$/, ctx => api.listClients(ctx)],
  ['POST', /^clients$/, (ctx, q, b) => api.createClient(ctx, b)],
  ['PATCH', /^clients\/([^/]+)$/, (ctx, q, b, m) => api.updateClient(ctx, m[1], b)],
  ['DELETE', /^clients\/([^/]+)$/, (ctx, q, b, m) => api.deleteClient(ctx, m[1])],

  ['GET', /^clients\/([^/]+)\/settings$/, (ctx, q, b, m) => api.getSettings(ctx, m[1])],
  ['PUT', /^clients\/([^/]+)\/settings$/, (ctx, q, b, m) => api.putSettings(ctx, m[1], b)],

  ['GET', /^clients\/([^/]+)\/columns$/, (ctx, q, b, m) => api.listColumns(ctx, m[1])],
  ['POST', /^clients\/([^/]+)\/columns$/, (ctx, q, b, m) => api.createColumn(ctx, m[1], b)],
  ['PATCH', /^columns\/([^/]+)$/, (ctx, q, b, m) => api.updateColumn(ctx, m[1], b)],
  ['DELETE', /^columns\/([^/]+)$/, (ctx, q, b, m) => api.deleteColumn(ctx, m[1])],

  ['GET', /^clients\/([^/]+)\/employees$/, (ctx, q, b, m) => api.listEmployees(ctx, m[1])],
  ['GET', /^employees\/([^/]+)\/history$/, (ctx, q, b, m) => api.employeeHistory(ctx, m[1])],
  ['POST', /^clients\/([^/]+)\/employees$/, (ctx, q, b, m) => api.createEmployee(ctx, m[1], b)],
  ['PATCH', /^employees\/([^/]+)$/, (ctx, q, b, m) => api.updateEmployee(ctx, m[1], b)],
  ['DELETE', /^employees\/([^/]+)$/, (ctx, q, b, m) => api.deleteEmployee(ctx, m[1])],

  ['GET', /^employees\/([^/]+)\/files$/, (ctx, q, b, m) => api.listEmployeeFiles(ctx, m[1], q)],
  ['POST', /^employees\/([^/]+)\/files$/, (ctx, q, b, m) => api.addEmployeeFile(ctx, m[1], b)],
  ['GET', /^files\/([^/]+)\/link$/, (ctx, q, b, m) => api.employeeFileLink(ctx, m[1])],
  ['DELETE', /^files\/([^/]+)$/, (ctx, q, b, m) => api.deleteEmployeeFile(ctx, m[1])],

  ['GET', /^clients\/([^/]+)\/periods$/, (ctx, q, b, m) => api.listPeriods(ctx, m[1])],
  ['POST', /^clients\/([^/]+)\/periods$/, (ctx, q, b, m) => api.createPeriod(ctx, m[1], b)],
  ['GET', /^periods\/([^/]+)$/, (ctx, q, b, m) => api.periodDetail(ctx, m[1])],
  ['PATCH', /^periods\/([^/]+)$/, (ctx, q, b, m) => api.updatePeriod(ctx, m[1], b)],
  ['DELETE', /^periods\/([^/]+)$/, (ctx, q, b, m) => api.deletePeriod(ctx, m[1])],
  ['PUT', /^periods\/([^/]+)\/entries$/, (ctx, q, b, m) => api.saveEntries(ctx, m[1], b)],
  ['GET', /^periods\/([^/]+)\/export$/, (ctx, q, b, m) => api.exportPeriod(ctx, m[1])],
];

const CREATED = /(?:^clients|\/(?:columns|employees|periods))$/;

module.exports = async (req, res) => {
  const route = String(req.query?.route || '').replace(/^\/+|\/+$/g, '');
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (route === 'cron' && ['GET', 'POST'].includes(req.method)) {
      if (!cronAuthorized(req)) return res.status(401).json({ error: 'No autorizado' });
      return res.json({ ok: true, ...(await autoCron.runAuto()) });
    }
    const match = ROUTES.map(([method, re, fn]) => ({ method, m: re.exec(route), fn })).filter(r => r.m);
    if (!match.length) return res.status(404).json({ error: 'Ruta no encontrada' });
    const handler = match.find(r => r.method === req.method);
    if (!handler) return res.status(405).json({ error: 'Método no permitido' });
    const ctx = await nominaContext(req);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = await handler.fn(ctx, req.query || {}, body, handler.m);
    return res.status(req.method === 'POST' && CREATED.test(route) ? 201 : 200).json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message, ...error.extra });
    console.error('[nomina]', route, error);
    return res.status(500).json({ error: 'Error interno de Nómina. Intente nuevamente.' });
  }
};
