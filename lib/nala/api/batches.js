// Carga masiva y lotes: creación, registro de archivos con enlaces firmados,
// inicio del procesamiento, reproceso y seguimiento.
const crypto = require('crypto');
const supabase = require('../../supabase');
const storage = require('../storage');
const settingsStore = require('../settings');
const pipeline = require('../pipeline');
const { logEvent, getClient, getBatch, refreshPeers } = require('../store');
const h = require('../http');

const EXT_KIND = { jpg: 'image', jpeg: 'image', png: 'image', pdf: 'pdf', zip: 'zip' };
const EXT_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf', zip: 'application/zip' };

async function list(ctx, q) {
  ctx.require('view');
  let query = supabase.from('nala_batches').select('*').eq('tenant_id', ctx.tenantId).order('created_at', { ascending: false }).limit(Math.min(Number(q.limit) || 100, 300));
  if (q.client_id) { ctx.requireClient(h.uuid(q.client_id)); query = query.eq('client_id', q.client_id); }
  else if (ctx.scopeArray()) query = query.in('client_id', ctx.scopeArray().length ? ctx.scopeArray() : ['00000000-0000-0000-0000-000000000000']);
  if (q.period) query = query.eq('period', h.period(q.period));
  if (q.format) query = query.eq('format', h.format(q.format));
  if (q.status) query = query.in('status', String(q.status).split(',').slice(0, 6));
  const { data, error } = await query;
  h.dbError(error);
  const ids = (data || []).map(b => b.id);
  const counts = await summaries(ctx.tenantId, ids);
  return { batches: (data || []).map(b => ({ ...b, summary: counts[b.id] || null })) };
}

// Per-batch counters from the same SQL function used everywhere else.
async function summaries(tenantId, ids) {
  const out = {};
  await Promise.all(ids.slice(0, 300).map(async id => {
    const { data, error } = await supabase.rpc('nala_stats', { p_tenant: tenantId, p_batch: id });
    h.dbError(error);
    out[id] = data;
  }));
  return out;
}

async function create(ctx, body) {
  ctx.require('upload');
  const clientId = h.uuid(body.client_id, 'Empresa');
  const client = await getClient(ctx, clientId, { withSettings: false });
  if (client.status === 'inactive') h.fail(409, 'La empresa cliente está inactiva.');
  const format = h.format(body.format);
  const period = h.period(body.period);
  const name = h.text(body.name, { max: 120, min: 1, label: 'El nombre del lote' });
  const idem = typeof body.idempotency_key === 'string' ? body.idempotency_key.slice(0, 128) : null;
  if (idem) {
    const { data: existing, error } = await supabase.from('nala_batches').select('*').eq('tenant_id', ctx.tenantId).eq('idempotency_key', idem).maybeSingle();
    h.dbError(error);
    if (existing) return { batch: existing, reused: true };
  }
  const { data, error } = await supabase.from('nala_batches').insert({ tenant_id: ctx.tenantId, client_id: clientId, format, period, name, idempotency_key: idem, created_by: ctx.userId }).select('*').single();
  if (error?.code === '23505' && idem) {
    const { data: again } = await supabase.from('nala_batches').select('*').eq('tenant_id', ctx.tenantId).eq('idempotency_key', idem).single();
    return { batch: again, reused: true };
  }
  h.dbError(error);
  await logEvent(ctx, { entity: 'batch', entity_id: data.id, batch_id: data.id, client_id: clientId, action: 'batch_created', details: { format, period, name } });
  return { batch: data };
}

async function detail(ctx, id) {
  ctx.require('view');
  const batch = await getBatch(ctx, h.uuid(id));
  const [{ data: documents, error: de }, { data: jobs, error: je }, { data: stats, error: se }, client] = await Promise.all([
    supabase.from('nala_documents').select('id, parent_id, original_name, mime_type, kind, size_bytes, sha256, page_count, status, duplicate_of, error, uploaded_by, created_at, uploaded_at, processed_at').eq('batch_id', batch.id).order('created_at'),
    supabase.from('nala_jobs').select('id, document_id, kind, status, attempts, max_attempts, run_after, last_error, started_at, finished_at, duration_ms, payload, created_at').eq('batch_id', batch.id).order('created_at'),
    supabase.rpc('nala_stats', { p_tenant: ctx.tenantId, p_batch: batch.id }),
    getClient(ctx, batch.client_id, { withSettings: false }),
  ]);
  h.dbError(de); h.dbError(je); h.dbError(se);
  const jobList = jobs || [];
  const done = jobList.filter(j => ['succeeded', 'failed', 'cancelled'].includes(j.status)).length;
  const durations = jobList.filter(j => j.duration_ms).map(j => j.duration_ms);
  const progress = {
    jobs_total: jobList.length, jobs_done: done, jobs_failed: jobList.filter(j => j.status === 'failed').length,
    jobs_running: jobList.filter(j => j.status === 'running').length, jobs_queued: jobList.filter(j => j.status === 'queued').length,
    percent: jobList.length ? Math.round((done / jobList.length) * 100) : 0,
    elapsed_ms: batch.started_at ? (batch.finished_at ? Date.parse(batch.finished_at) : Date.now()) - Date.parse(batch.started_at) : 0,
    avg_job_ms: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
  };
  return { batch: { ...batch, client_name: client.legal_name }, documents: documents || [], jobs: jobList, stats, progress };
}

const ddmmyyyy = iso => new Date(iso).toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Santo_Domingo' });
const INV_STATUS = { pending_review: 'pendiente', reviewed: 'revisada', approved: 'aprobada', excluded: 'excluida' };

// A file identical (SHA-256) to one already read in this firm is not loaded
// again; the answer says where it is and what became of its invoices.
async function alreadyLoaded(ctx, sha) {
  const { data: docs, error } = await supabase.from('nala_documents').select('id, batch_id, original_name, status, created_at')
    .eq('tenant_id', ctx.tenantId).eq('sha256', sha).not('status', 'in', '(pending_upload,failed,unsupported,duplicate)')
    .order('created_at').limit(1);
  h.dbError(error);
  const doc = docs?.[0];
  if (!doc) return null;
  const [{ data: b }, { data: invs }] = await Promise.all([
    supabase.from('nala_batches').select('id, name, client_id, period, format').eq('id', doc.batch_id).single(),
    supabase.from('nala_invoices').select('ncf, status, client_id, format').eq('document_id', doc.id).limit(20),
  ]);
  // A copy discarded as repeated reports the state of the NCF's active invoice.
  for (const inv of invs || []) {
    if (inv.status !== 'excluded' || !inv.ncf) continue;
    const { data: twin } = await supabase.from('nala_invoices').select('status').eq('tenant_id', ctx.tenantId).eq('client_id', inv.client_id)
      .eq('format', inv.format).eq('ncf', inv.ncf).neq('status', 'excluded').order('status').limit(1);
    if (twin?.[0]) inv.status = twin[0].status;
  }
  const client = b ? (await supabase.from('direct_clients').select('legal_name').eq('id', b.client_id).single()).data : null;
  const visible = b && ctx.canClient(b.client_id);
  const where = visible ? `el lote «${b.name}» (${client?.legal_name || ''}, ${b.format} ${b.period.slice(4)}/${b.period.slice(0, 4)})` : 'otro lote de su empresa';
  const detail = (invs || []).length ? ` Comprobantes: ${invs.map(i => `${i.ncf || 'sin NCF'} ${INV_STATUS[i.status] || i.status}`).join(', ')}.` : (doc.status === 'processed' ? '' : ' Está en proceso.');
  return { message: `Esta factura ya fue cargada el ${ddmmyyyy(doc.created_at)} en ${where}.${detail} No se vuelve a leer.`, batch_id: visible ? b.id : null, document_id: doc.id };
}

// Registers files and returns one signed upload URL per new file. Files the
// batch already has (same SHA-256) are not registered twice.
async function registerFiles(ctx, id, body) {
  ctx.require('upload');
  const batch = await getBatch(ctx, h.uuid(id));
  if (!['draft', 'review', 'completed', 'failed', 'queued', 'processing'].includes(batch.status)) h.fail(409, 'El lote no admite archivos.');
  const settings = await settingsStore.load(ctx.tenantId);
  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length) h.fail(400, 'Seleccione al menos un archivo.');
  const { count } = await supabase.from('nala_documents').select('id', { count: 'exact', head: true }).eq('batch_id', batch.id).is('parent_id', null);
  if ((count || 0) + files.length > settings.limits.max_files_per_batch) h.fail(400, `Un lote admite hasta ${settings.limits.max_files_per_batch} archivos.`);
  const results = [];
  for (const file of files.slice(0, 500)) {
    const name = String(file?.name || '').trim().slice(0, 255);
    const ext = name.split('.').pop().toLowerCase();
    const size = Number(file?.size);
    const sha = String(file?.sha256 || '').toLowerCase();
    if (!name) { results.push({ name, error: 'Nombre de archivo vacío.' }); continue; }
    if (ext === 'rar') { results.push({ name, error: 'RAR no es compatible: comprima los archivos en ZIP.' }); continue; }
    if (!EXT_KIND[ext]) { results.push({ name, error: 'Tipo no admitido. Use JPG, PNG, PDF o ZIP.' }); continue; }
    const maxBytes = (ext === 'zip' ? settings.limits.zip_max_uncompressed_mb : settings.limits.max_file_mb) * 1024 * 1024;
    if (!Number.isFinite(size) || size <= 0 || size > Math.min(maxBytes, 50 * 1024 * 1024)) { results.push({ name, error: `Tamaño inválido o superior al límite (${settings.limits.max_file_mb} MB).` }); continue; }
    if (!/^[0-9a-f]{64}$/.test(sha)) { results.push({ name, error: 'Falta la huella SHA-256 del archivo.' }); continue; }
    const { data: same, error: se } = await supabase.from('nala_documents').select('id, status, storage_path').eq('batch_id', batch.id).eq('sha256', sha).is('parent_id', null).maybeSingle();
    h.dbError(se);
    if (same?.status === 'pending_upload') {
      // Interrupted upload of this same file: resume it.
      results.push({ name, document_id: same.id, already: true, status: same.status, upload_url: await storage.signedUpload(same.storage_path).catch(() => null) });
      continue;
    }
    const previous = await alreadyLoaded(ctx, sha);
    if (previous) { results.push({ name, error: previous.message, already_processed: previous }); continue; }
    const docId = crypto.randomUUID();
    const doc = { id: docId, tenant_id: ctx.tenantId, batch_id: batch.id, original_name: name, mime_type: EXT_MIME[ext], kind: EXT_KIND[ext], size_bytes: size, sha256: sha, uploaded_by: ctx.userId };
    doc.storage_path = pipeline.docPath(doc, name);
    const { error } = await supabase.from('nala_documents').insert(doc);
    h.dbError(error);
    results.push({ name, document_id: docId, upload_url: await storage.signedUpload(doc.storage_path) });
  }
  await logEvent(ctx, { entity: 'batch', entity_id: batch.id, batch_id: batch.id, client_id: batch.client_id, action: 'files_registered', details: { files: results.map(r => ({ name: r.name, document_id: r.document_id, error: r.error || null })) } });
  return { files: results };
}

async function completeFile(ctx, id, docId) {
  ctx.require('upload');
  const batch = await getBatch(ctx, h.uuid(id));
  const { data: doc, error } = await supabase.from('nala_documents').select('*').eq('batch_id', batch.id).eq('id', h.uuid(docId)).maybeSingle();
  h.dbError(error);
  if (!doc) h.fail(404, 'Documento no encontrado.');
  if (doc.status !== 'pending_upload') return { document: doc };
  // The object must exist in private storage before the upload counts.
  await storage.signedDownload(doc.storage_path, 30).catch(() => h.fail(409, 'El archivo todavía no se ha recibido en el almacenamiento.'));
  const { data, error: ue } = await supabase.from('nala_documents').update({ status: 'uploaded', uploaded_at: new Date().toISOString() }).eq('id', doc.id).select('*').single();
  h.dbError(ue);
  await logEvent(ctx, { entity: 'document', entity_id: doc.id, batch_id: batch.id, client_id: batch.client_id, action: 'uploaded', details: { name: doc.original_name, size: doc.size_bytes, sha256: doc.sha256 } });
  return { document: data };
}

async function start(ctx, id) {
  ctx.require('upload');
  const batch = await getBatch(ctx, h.uuid(id));
  const settings = await settingsStore.load(ctx.tenantId);
  const { data: docs, error } = await supabase.from('nala_documents').select('id').eq('batch_id', batch.id).eq('status', 'uploaded').is('parent_id', null);
  h.dbError(error);
  for (const doc of docs || []) {
    await pipeline.enqueue({ tenant_id: ctx.tenantId, batch_id: batch.id, document_id: doc.id, kind: 'prepare', dedupe_key: `prepare:${doc.id}`, max_attempts: settings.limits.max_attempts });
    await supabase.from('nala_documents').update({ status: 'queued' }).eq('id', doc.id).eq('status', 'uploaded');
  }
  const { data: status, error: re } = await supabase.rpc('nala_refresh_batch', { p_batch: batch.id });
  h.dbError(re);
  await logEvent(ctx, { entity: 'batch', entity_id: batch.id, batch_id: batch.id, client_id: batch.client_id, action: 'processing_started', details: { documents: (docs || []).length } });
  return { queued: (docs || []).length, status };
}

// Reprocess failed (or selected) documents without duplicating invoices:
// same page ranges and extraction keys; corrections and approvals are kept.
async function reprocess(ctx, id, body) {
  ctx.require('reprocess');
  const batch = await getBatch(ctx, h.uuid(id));
  const settings = await settingsStore.load(ctx.tenantId);
  const onlyFailed = body.failed_only !== false;
  const requested = Array.isArray(body.document_ids) ? body.document_ids.map(d => h.uuid(d)) : null;
  let query = supabase.from('nala_documents').select('*').eq('batch_id', batch.id).neq('kind', 'zip');
  if (requested) query = query.in('id', requested);
  const { data: docs, error } = await query;
  h.dbError(error);
  const generation = Date.now();
  let count = 0;
  for (const doc of docs || []) {
    if (doc.status === 'purged' || doc.status === 'unsupported') continue;
    const { data: jobs, error: je } = await supabase.from('nala_jobs').select('*').eq('document_id', doc.id);
    h.dbError(je);
    const failedJobs = (jobs || []).filter(j => j.status === 'failed');
    if (onlyFailed && !failedJobs.length && doc.status !== 'failed' && !(body.force_duplicate && doc.status === 'duplicate')) continue;
    if (jobs?.some(j => ['queued', 'running'].includes(j.status))) continue;
    const prepareFailed = failedJobs.some(j => j.kind === 'prepare') || !(jobs || []).some(j => j.kind === 'extract') || doc.status === 'duplicate';
    if (prepareFailed) {
      await pipeline.enqueue({ tenant_id: ctx.tenantId, batch_id: batch.id, document_id: doc.id, kind: 'prepare', payload: { generation, force: doc.status === 'duplicate' && !!body.force_duplicate },
        dedupe_key: `prepare:${doc.id}:g${generation}`, max_attempts: settings.limits.max_attempts });
    } else {
      const ranges = new Map();
      for (const j of (jobs || []).filter(x => x.kind === 'extract' && (!onlyFailed || x.status === 'failed'))) ranges.set(`${j.payload.page_from}-${j.payload.page_to}`, j.payload);
      for (const r of ranges.values()) {
        await pipeline.enqueue({ tenant_id: ctx.tenantId, batch_id: batch.id, document_id: doc.id, kind: 'extract', payload: { page_from: r.page_from, page_to: r.page_to, generation },
          dedupe_key: `extract:${doc.id}:${r.page_from}-${r.page_to}:g${generation}`, max_attempts: settings.limits.max_attempts });
      }
    }
    await supabase.from('nala_documents').update({ status: 'queued', error: null }).eq('id', doc.id);
    count++;
  }
  await logEvent(ctx, { entity: 'batch', entity_id: batch.id, batch_id: batch.id, client_id: batch.client_id, action: 'reprocess_requested', details: { documents: count, failed_only: onlyFailed } });
  const { data: status } = await supabase.rpc('nala_refresh_batch', { p_batch: batch.id });
  return { requeued: count, status };
}

// Discards (excludes) the invoices of a batch that repeat one already
// processed. Originals are untouched; each exclusion is recorded.
async function discardDuplicates(ctx, id) {
  ctx.require('exclude');
  const batch = await getBatch(ctx, h.uuid(id));
  const { data, error } = await supabase.from('nala_invoices').select('*').eq('batch_id', batch.id).in('status', ['pending_review', 'reviewed'])
    .contains('issues', JSON.stringify([{ code: 'DUPLICADO' }]));
  h.dbError(error);
  const settings = await settingsStore.load(ctx.tenantId);
  const clientCache = new Map();
  const contextFor = async clientId => {
    if (!clientCache.has(clientId)) clientCache.set(clientId, { client: (await supabase.from('direct_clients').select('id, legal_name, rnc, cedula').eq('id', clientId).single()).data, settings });
    return clientCache.get(clientId);
  };
  let count = 0;
  for (const invoice of data || []) {
    const dup = invoice.issues.find(i => i.code === 'DUPLICADO');
    const { data: updated, error: ue } = await supabase.from('nala_invoices').update({ status: 'excluded', version: invoice.version + 1, updated_at: new Date().toISOString(), updated_by: ctx.userId })
      .eq('id', invoice.id).eq('version', invoice.version).select('*').maybeSingle();
    h.dbError(ue);
    if (!updated) continue;
    count++;
    await logEvent(ctx, { entity: 'invoice', entity_id: invoice.id, invoice_id: invoice.id, batch_id: batch.id, client_id: invoice.client_id, action: 'excluded', reason: `Factura repetida. ${dup.message}`, details: { duplicate_of: dup.ref } });
    await refreshPeers(ctx.tenantId, updated, contextFor);
  }
  await supabase.rpc('nala_refresh_batch', { p_batch: batch.id });
  return { discarded: count };
}

async function tick(ctx) {
  ctx.require('view');
  const settings = await settingsStore.load(ctx.tenantId);
  return pipeline.runJobs({ tenantId: ctx.tenantId, budgetMs: 55000, concurrency: settings.limits.concurrent_jobs });
}

module.exports = { list, create, detail, registerFiles, completeFile, start, reprocess, discardDuplicates, tick, summaries };
