// Único punto de entrada de Estados Financieros (una sola función Vercel, como NALA y Nómina).
// vercel.json reescribe /api/estados/<ruta> → /api/estados?route=<ruta>.
const { estadosContext } = require('../lib/estados/context');
const { HttpError } = require('../lib/nala/http');
const api = require('../lib/estados/api');

const ROUTES = [
  ['GET', /^me$/, ctx => api.me(ctx)],
  ['GET', /^config$/, ctx => api.getConfig(ctx)],
  ['PUT', /^config$/, (ctx, q, b) => api.putConfig(ctx, b)],
  ['GET', /^clients$/, ctx => api.listClients(ctx)],
  ['GET', /^templates\/([^/]+)$/, (ctx, q, b, m) => api.template(ctx, m[1])],

  ['GET', /^reports$/, (ctx, q) => api.listReports(ctx, q)],
  ['POST', /^reports$/, (ctx, q, b) => api.createReport(ctx, b)],
  ['GET', /^reports\/([^/]+)$/, (ctx, q, b, m) => api.reportDetail(ctx, m[1])],
  ['PATCH', /^reports\/([^/]+)$/, (ctx, q, b, m) => api.updateReport(ctx, m[1], b)],
  ['POST', /^reports\/([^/]+)\/transition$/, (ctx, q, b, m) => api.transition(ctx, m[1], b)],
  ['PUT', /^reports\/([^/]+)\/documents$/, (ctx, q, b, m) => api.updateDocuments(ctx, m[1], b)],
  ['GET', /^reports\/([^/]+)\/entries$/, (ctx, q, b, m) => api.listEntries(ctx, m[1], q)],
  ['GET', /^reports\/([^/]+)\/versions\/(\d+)$/, (ctx, q, b, m) => api.getVersion(ctx, m[1], m[2])],
  ['GET', /^reports\/([^/]+)\/compare$/, (ctx, q, b, m) => api.compare(ctx, m[1], q)],
  ['GET', /^reports\/([^/]+)\/export$/, (ctx, q, b, m) => api.exportReport(ctx, m[1])],

  ['GET', /^reports\/([^/]+)\/statements$/, (ctx, q, b, m) => api.getStatements(ctx, m[1])],
  ['PUT', /^reports\/([^/]+)\/statements$/, (ctx, q, b, m) => api.putStatements(ctx, m[1], b)],
  ['POST', /^reports\/([^/]+)\/statements\/import$/, (ctx, q, b, m) => api.importStatements(ctx, m[1], b)],
  ['GET', /^reports\/([^/]+)\/package$/, (ctx, q, b, m) => api.getPackage(ctx, m[1])],
  ['PUT', /^reports\/([^/]+)\/package$/, (ctx, q, b, m) => api.updatePackage(ctx, m[1], b)],
  ['POST', /^reports\/([^/]+)\/assumptions$/, (ctx, q, b, m) => api.createAssumption(ctx, m[1], b)],
  ['PATCH', /^assumptions\/([^/]+)$/, (ctx, q, b, m) => api.updateAssumption(ctx, m[1], b)],
  ['DELETE', /^assumptions\/([^/]+)$/, (ctx, q, b, m) => api.deleteAssumption(ctx, m[1])],
  ['POST', /^reports\/([^/]+)\/adjustments$/, (ctx, q, b, m) => api.createAdjustment(ctx, m[1], b)],
  ['DELETE', /^adjustments\/([^/]+)$/, (ctx, q, b, m) => api.deleteAdjustment(ctx, m[1])],

  ['POST', /^reports\/([^/]+)\/import\/preview$/, (ctx, q, b, m) => api.importPreview(ctx, m[1], b)],
  ['POST', /^reports\/([^/]+)\/import\/confirm$/, (ctx, q, b, m) => api.importConfirm(ctx, m[1], b)],
  ['POST', /^imports\/([^/]+)\/revert$/, (ctx, q, b, m) => api.revertImport(ctx, m[1], b)],

  ['GET', /^team$/, ctx => api.team(ctx)],
  ['PUT', /^team\/([^/]+)$/, (ctx, q, b, m) => api.updateMember(ctx, m[1], b)],
];

const CREATED = /^reports$|\/(?:assumptions|adjustments)$/;

module.exports = async (req, res) => {
  const route = String(req.query?.route || '').replace(/^\/+|\/+$/g, '');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const match = ROUTES.map(([method, re, fn]) => ({ method, m: re.exec(route), fn })).filter(r => r.m);
    if (!match.length) return res.status(404).json({ error: 'Ruta no encontrada' });
    const handler = match.find(r => r.method === req.method);
    if (!handler) return res.status(405).json({ error: 'Método no permitido' });
    const ctx = await estadosContext(req);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = await handler.fn(ctx, req.query || {}, body, handler.m);
    return res.status(req.method === 'POST' && CREATED.test(route) ? 201 : 200).json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message, ...error.extra });
    console.error('[estados]', route, error);
    return res.status(500).json({ error: 'Error interno de Estados Financieros. Intente nuevamente.' });
  }
};
