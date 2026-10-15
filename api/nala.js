// Único punto de entrada de NALA (Vercel Hobby admite 12 funciones). vercel.json
// reescribe /api/nala/<ruta> → /api/nala?route=<ruta>. Las rutas existentes
// /api/nala/analyze y /api/nala/chat se atienden con sus manejadores originales,
// sin cambios (api/nala/_analyze.js y api/nala/_chat.js).
const crypto = require('crypto');
const { nalaContext } = require('../lib/nala/context');
const { HttpError } = require('../lib/nala/http');
const pipeline = require('../lib/nala/pipeline');
const core = require('../lib/nala/api/core');
const batches = require('../lib/nala/api/batches');
const invoices = require('../lib/nala/api/invoices');
const exportsApi = require('../lib/nala/api/exports');
const templates = require('../lib/nala/api/templates');

async function legacy(name, req, res) {
  const mod = name === 'analyze' ? await import('./nala/_analyze.js') : await import('./nala/_chat.js');
  const handler = typeof mod.default === 'function' ? mod.default : mod.default.default;
  return handler(req, res);
}

const ROUTES = [
  ['GET', /^me$/, ctx => core.me(ctx)],
  ['GET', /^stats$/, (ctx, q) => core.stats(ctx, q)],
  ['GET', /^clients$/, (ctx, q) => core.listClients(ctx, q)],
  ['POST', /^clients$/, (ctx, q, b) => core.createClient(ctx, b)],
  ['GET', /^clients\/([^/]+)$/, (ctx, q, b, m) => core.clientDetail(ctx, m[1])],
  ['PATCH', /^clients\/([^/]+)$/, (ctx, q, b, m) => core.updateClient(ctx, m[1], b)],
  ['GET', /^rnc\/([^/]+)$/, (ctx, q, b, m) => core.rnc(ctx, decodeURIComponent(m[1]), q)],
  ['GET', /^documents\/([^/]+)\/url$/, (ctx, q, b, m) => core.documentUrl(ctx, m[1])],
  ['GET', /^batches$/, (ctx, q) => batches.list(ctx, q)],
  ['POST', /^batches$/, (ctx, q, b) => batches.create(ctx, b)],
  ['GET', /^batches\/([^/]+)$/, (ctx, q, b, m) => batches.detail(ctx, m[1])],
  ['DELETE', /^batches\/([^/]+)$/, (ctx, q, b, m) => batches.remove(ctx, m[1])],
  ['POST', /^batches\/([^/]+)\/files$/, (ctx, q, b, m) => batches.registerFiles(ctx, m[1], b)],
  ['POST', /^batches\/([^/]+)\/files\/([^/]+)\/complete$/, (ctx, q, b, m) => batches.completeFile(ctx, m[1], m[2])],
  ['POST', /^batches\/([^/]+)\/start$/, (ctx, q, b, m) => batches.start(ctx, m[1])],
  ['POST', /^batches\/([^/]+)\/reprocess$/, (ctx, q, b, m) => batches.reprocess(ctx, m[1], b)],
  ['POST', /^batches\/([^/]+)\/discard-duplicates$/, (ctx, q, b, m) => batches.discardDuplicates(ctx, m[1])],
  ['POST', /^jobs\/tick$/, ctx => batches.tick(ctx)],
  ['GET', /^invoices$/, (ctx, q) => invoices.list(ctx, q)],
  ['GET', /^invoices\/([^/]+)$/, (ctx, q, b, m) => invoices.detail(ctx, m[1])],
  ['PATCH', /^invoices\/([^/]+)$/, (ctx, q, b, m) => invoices.save(ctx, m[1], b)],
  ['POST', /^invoices\/([^/]+)\/lock$/, (ctx, q, b, m) => invoices.lock(ctx, m[1], false)],
  ['DELETE', /^invoices\/([^/]+)\/lock$/, (ctx, q, b, m) => invoices.lock(ctx, m[1], true)],
  ['POST', /^invoices\/([^/]+)\/approve$/, (ctx, q, b, m) => invoices.approve(ctx, m[1], b)],
  ['POST', /^invoices\/([^/]+)\/revert$/, (ctx, q, b, m) => invoices.revert(ctx, m[1], b)],
  ['POST', /^invoices\/([^/]+)\/relocate$/, (ctx, q, b, m) => invoices.relocate(ctx, m[1], b)],
  ['POST', /^invoices\/([^/]+)\/exclude$/, (ctx, q, b, m) => invoices.setExcluded(ctx, m[1], b, true)],
  ['POST', /^invoices\/([^/]+)\/restore$/, (ctx, q, b, m) => invoices.setExcluded(ctx, m[1], b, false)],
  ['POST', /^exports\/preview$/, (ctx, q, b) => exportsApi.preview(ctx, b)],
  ['POST', /^exports$/, (ctx, q, b) => exportsApi.create(ctx, b)],
  ['GET', /^exports$/, (ctx, q) => exportsApi.list(ctx, q)],
  ['GET', /^exports\/([^/]+)$/, (ctx, q, b, m) => exportsApi.detail(ctx, m[1])],
  ['GET', /^exports\/([^/]+)\/download$/, (ctx, q, b, m) => exportsApi.download(ctx, m[1], q)],
  ['POST', /^exports\/([^/]+)\/status$/, (ctx, q, b, m) => exportsApi.setStatus(ctx, m[1], b)],
  ['GET', /^team$/, ctx => core.team(ctx)],
  ['PUT', /^team\/([^/]+)$/, (ctx, q, b, m) => core.updateMember(ctx, m[1], b)],
  ['GET', /^templates$/, ctx => templates.list(ctx)],
  ['POST', /^templates\/upload-url$/, (ctx, q, b) => templates.uploadUrl(ctx, b)],
  ['POST', /^templates$/, (ctx, q, b) => templates.register(ctx, b)],
  ['DELETE', /^templates\/(606|607)\/(excel|txt)(?:\/(\d+))?$/, (ctx, q, b, m) => templates.remove(ctx, m[1], m[2], m[3])],
  ['GET', /^settings$/, ctx => core.getSettings(ctx)],
  ['PUT', /^settings$/, (ctx, q, b) => core.putSettings(ctx, b)],
  ['GET', /^retention$/, ctx => core.retention(ctx)],
  ['POST', /^retention\/purge$/, (ctx, q, b) => core.purge(ctx, b)],
  ['GET', /^events$/, (ctx, q) => core.events(ctx, q)],
];

// Scheduled worker (pg_cron/pg_net or Vercel Cron) authenticated by a server
// secret; processes pending jobs of every tenant.
function workerAuthorized(req) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return [process.env.NALA_WORKER_SECRET, process.env.CRON_SECRET].filter(s => s && s.length >= 16)
    .some(secret => token.length === secret.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret)));
}

module.exports = async (req, res) => {
  const route = String(req.query?.route || '').replace(/^\/+|\/+$/g, '');
  if (route === 'analyze') return legacy('analyze', req, res);
  if (route === 'chat') return legacy('chat', req, res);
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (route === 'jobs/worker' && ['GET', 'POST'].includes(req.method)) {
      if (!workerAuthorized(req)) return res.status(401).json({ error: 'No autorizado' });
      return res.json(await pipeline.runJobs({ tenantId: null, budgetMs: 55000 }));
    }
    const match = ROUTES.map(([method, re, fn]) => ({ method, m: re.exec(route), fn })).filter(r => r.m);
    if (!match.length) return res.status(404).json({ error: 'Ruta no encontrada' });
    const handler = match.find(r => r.method === req.method);
    if (!handler) return res.status(405).json({ error: 'Método no permitido' });
    const ctx = await nalaContext(req);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = await handler.fn(ctx, req.query || {}, body, handler.m);
    return res.status(req.method === 'POST' && /^(batches|clients|exports)$/.test(route) ? 201 : 200).json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message, ...error.extra });
    console.error('[nala]', route, error);
    return res.status(500).json({ error: 'Error interno de NALA. Intente nuevamente.' });
  }
};
