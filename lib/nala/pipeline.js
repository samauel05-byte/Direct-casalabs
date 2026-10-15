// Persistent background processing. Jobs live in nala_jobs and are claimed
// with a lease (FOR UPDATE SKIP LOCKED); a crashed or timed-out worker's jobs
// are reclaimed when the lease expires. Retries are limited with exponential
// backoff. Processing is idempotent: invoices are keyed by
// document:first-page:index and re-extraction never overwrites fields a human
// corrected nor touches approved or excluded invoices.
const crypto = require('crypto');
const JSZip = require('jszip');
const { PDFDocument, PDFName, PDFRawStream, PDFDict } = require('pdf-lib');
const supabase = require('../supabase');
const storage = require('./storage');
const settingsStore = require('./settings');
const extractor = require('./extractor');
const { evaluate, stripComputed, refreshPeers } = require('./store');
const money = require('./money');
const { dbError } = require('./http');

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

class JobError extends Error {
  constructor(message, retryable = true) { super(message); this.retryable = retryable; }
}

const KIND_BY_EXT = { jpg: 'image', jpeg: 'image', png: 'image', pdf: 'pdf', zip: 'zip' };
const MIME_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf', zip: 'application/zip' };

function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'image', mime: 'image/jpeg' };
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'image', mime: 'image/png' };
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return { kind: 'pdf', mime: 'application/pdf' };
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return { kind: 'zip', mime: 'application/zip' };
  if (buf.slice(0, 4).toString('latin1') === 'Rar!') return { kind: 'rar', mime: 'application/vnd.rar' };
  return { kind: null, mime: null };
}

const safeName = name => String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(-120) || 'archivo';
const docPath = (doc, name) => `${doc.tenant_id}/${doc.batch_id}/${doc.id}/${safeName(name)}`;

async function loadDocument(id) {
  const { data, error } = await supabase.from('nala_documents').select('*').eq('id', id).maybeSingle();
  dbError(error);
  if (!data) throw new JobError('El documento ya no existe.', false);
  return data;
}

async function updateDocument(id, patch) {
  const { error } = await supabase.from('nala_documents').update(patch).eq('id', id);
  dbError(error);
}

async function enqueue(job) {
  const row = { max_attempts: 3, payload: {}, ...job };
  const { error } = await supabase.from('nala_jobs').upsert(row, { onConflict: 'dedupe_key', ignoreDuplicates: true });
  dbError(error);
}

async function event(tenantId, e) {
  const { error } = await supabase.from('nala_events').insert({ tenant_id: tenantId, actor: null, ...e });
  dbError(error);
}

// ─── prepare: verify the original, expand ZIPs, split PDFs into chunks ─────
async function prepare(job, settings) {
  const doc = await loadDocument(job.document_id);
  if (doc.status === 'purged') throw new JobError('El original fue depurado por retención documental.', false);
  const buf = await storage.download(doc.storage_path).catch(e => { throw new JobError(e.message, true); });
  const hash = sha256(buf);
  if (doc.sha256 && doc.sha256 !== hash) throw new JobError('La huella SHA-256 del archivo recibido no coincide con la declarada en la carga.', false);
  const detected = sniff(buf);
  const patch = { sha256: hash, size_bytes: buf.length };
  if (detected.kind === 'rar') {
    await updateDocument(doc.id, { ...patch, status: 'unsupported', error: 'RAR no es compatible: comprima los archivos en ZIP.' });
    return { note: 'rar' };
  }
  if (!detected.kind || detected.kind !== doc.kind) {
    await updateDocument(doc.id, { ...patch, status: 'unsupported', error: `El contenido no corresponde a un ${doc.kind.toUpperCase()} válido.` });
    return { note: 'unsupported' };
  }
  if (!job.payload?.force) {
    // Only an *earlier* document can make this one a duplicate, so two copies
    // processed concurrently never mark each other and the first one wins.
    const { data: dup, error } = await supabase.from('nala_documents').select('id, batch_id, original_name')
      .eq('tenant_id', doc.tenant_id).eq('sha256', hash).neq('id', doc.id).not('status', 'in', '(duplicate,purged,unsupported)')
      .or(`created_at.lt.${doc.created_at},and(created_at.eq.${doc.created_at},id.lt.${doc.id})`).limit(1);
    dbError(error);
    if (dup?.length) {
      const { data: b } = await supabase.from('nala_batches').select('name').eq('id', dup[0].batch_id).maybeSingle();
      await updateDocument(doc.id, { ...patch, status: 'duplicate', duplicate_of: dup[0].id,
        error: `Esta factura ya fue cargada ("${dup[0].original_name}", lote «${b?.name || String(dup[0].batch_id).slice(0, 8)}»). No se vuelve a leer.` });
      await event(doc.tenant_id, { entity: 'document', entity_id: doc.id, batch_id: doc.batch_id, action: 'duplicate_file', details: { duplicate_of: dup[0].id, sha256: hash } });
      return { note: 'duplicate' };
    }
  }
  const limits = settings.limits;
  if (doc.kind === 'zip') {
    const zip = await JSZip.loadAsync(buf).catch(() => { throw new JobError('El ZIP está dañado o protegido con contraseña.', false); });
    const entries = Object.values(zip.files).filter(f => !f.dir && !/(^|\/)(__MACOSX|\.)/.test(f.name));
    if (entries.length > limits.max_files_per_batch) throw new JobError(`El ZIP contiene ${entries.length} archivos; el máximo es ${limits.max_files_per_batch}.`, false);
    const declared = entries.reduce((s, f) => s + (f._data?.uncompressedSize || 0), 0);
    if (declared > limits.zip_max_uncompressed_mb * 1024 * 1024) throw new JobError(`El ZIP descomprimido supera ${limits.zip_max_uncompressed_mb} MB.`, false);
    let created = 0;
    for (const entry of entries) {
      const ext = entry.name.split('.').pop().toLowerCase();
      const childId = crypto.createHash('sha256').update(`${doc.id}:${entry.name}`).digest('hex');
      const id = `${childId.slice(0, 8)}-${childId.slice(8, 12)}-4${childId.slice(13, 16)}-8${childId.slice(17, 20)}-${childId.slice(20, 32)}`;
      const base = { id, tenant_id: doc.tenant_id, batch_id: doc.batch_id, parent_id: doc.id, original_name: entry.name.split('/').pop().slice(0, 255), uploaded_by: doc.uploaded_by, uploaded_at: new Date().toISOString() };
      const kind = KIND_BY_EXT[ext];
      if (!kind || kind === 'zip') {
        const { error } = await supabase.from('nala_documents').upsert({ ...base, mime_type: 'application/octet-stream', kind: 'pdf', size_bytes: 0, storage_path: `${doc.tenant_id}/${doc.batch_id}/${id}/omitido`, status: 'unsupported',
          error: ext === 'rar' ? 'RAR no es compatible.' : (kind === 'zip' ? 'No se procesan ZIP dentro de otro ZIP.' : `Tipo .${ext} no admitido (JPG, PNG, PDF).`) }, { onConflict: 'id', ignoreDuplicates: true });
        dbError(error);
        continue;
      }
      const content = await entry.async('nodebuffer');
      if (content.length > limits.max_file_mb * 1024 * 1024) {
        const { error } = await supabase.from('nala_documents').upsert({ ...base, mime_type: MIME_BY_EXT[ext], kind, size_bytes: content.length, storage_path: `${doc.tenant_id}/${doc.batch_id}/${id}/omitido`, status: 'unsupported', error: `Supera ${limits.max_file_mb} MB.` }, { onConflict: 'id', ignoreDuplicates: true });
        dbError(error);
        continue;
      }
      const child = { ...base, mime_type: MIME_BY_EXT[ext], kind, size_bytes: content.length, sha256: sha256(content), status: 'uploaded' };
      child.storage_path = docPath(child, child.original_name);
      await storage.upload(child.storage_path, content, child.mime_type);
      const { error } = await supabase.from('nala_documents').upsert(child, { onConflict: 'id', ignoreDuplicates: true });
      dbError(error);
      await enqueue({ tenant_id: doc.tenant_id, batch_id: doc.batch_id, document_id: id, kind: 'prepare', dedupe_key: `prepare:${id}`, max_attempts: limits.max_attempts });
      created++;
    }
    await updateDocument(doc.id, { ...patch, status: 'processed', processed_at: new Date().toISOString(), page_count: 0, error: null });
    return { note: `zip:${created}` };
  }
  let pages = 1;
  if (doc.kind === 'pdf') {
    let pdf;
    try { pdf = await PDFDocument.load(buf, { updateMetadata: false }); } catch (e) {
      throw new JobError(/encrypt/i.test(e.message) ? 'El PDF está protegido con contraseña.' : 'El PDF está dañado o no se puede leer.', false);
    }
    pages = pdf.getPageCount();
    if (pages === 0) throw new JobError('El PDF no tiene páginas.', false);
    if (pages > limits.max_pages_per_document) throw new JobError(`El PDF tiene ${pages} páginas; el máximo configurado es ${limits.max_pages_per_document}.`, false);
  }
  const chunk = doc.kind === 'pdf' ? limits.pages_per_chunk : 1;
  const generation = job.payload?.generation || 0;
  for (let from = 1; from <= pages; from += chunk) {
    const to = Math.min(pages, from + chunk - 1);
    await enqueue({ tenant_id: doc.tenant_id, batch_id: doc.batch_id, document_id: doc.id, kind: 'extract', payload: { page_from: from, page_to: to, generation },
      dedupe_key: `extract:${doc.id}:${from}-${to}:g${generation}`, max_attempts: limits.max_attempts });
  }
  await updateDocument(doc.id, { ...patch, page_count: pages, status: 'queued', error: null });
  return { note: `pages:${pages}` };
}

// If a PDF page is a single scanned JPEG (DCTDecode), returns that image's
// bytes as base64 so it can be sent to the model at full resolution. Returns
// null for pages that are not a simple JPEG scan (vector/text PDFs, multiple
// images, other encodings), so the caller falls back to sending the PDF.
function pageScanJpeg(pdf, pageIndex) {
  try {
    const page = pdf.getPage(pageIndex);
    const res = page.node.Resources && page.node.Resources();
    if (!res) return null;
    const xobj = res.lookup(PDFName.of('XObject'), PDFDict);
    if (!xobj) return null;
    const jpegs = [];
    for (const [, ref] of xobj.entries()) {
      const stream = pdf.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;
      const dict = stream.dict;
      const subtype = dict.lookup(PDFName.of('Subtype'));
      if (!subtype || subtype.toString() !== '/Image') continue;
      const filter = String(dict.lookup(PDFName.of('Filter')) || '');
      // Sólo JPEG puro (DCTDecode y nada más); cualquier otra combinación → PDF.
      if (!/DCTDecode/.test(filter) || /Flate|LZW|ASCII|CCITT|RunLength|JPX/.test(filter)) return null;
      jpegs.push(Buffer.from(stream.contents));
    }
    if (jpegs.length !== 1) return null; // 0 o varias imágenes en la página → PDF
    if (jpegs[0].length > 18 * 1024 * 1024) return null; // límite de imagen de la API
    return jpegs[0].toString('base64');
  } catch { return null; }
}

// ─── extract: read invoices from a page range ─────────────────────────────
async function extract(job, settings, { signal } = {}) {
  const doc = await loadDocument(job.document_id);
  if (['purged', 'duplicate', 'unsupported'].includes(doc.status)) return { note: `skip:${doc.status}` };
  const { data: batch, error: be } = await supabase.from('nala_batches').select('*').eq('id', doc.batch_id).single();
  dbError(be);
  const buf = await storage.download(doc.storage_path).catch(e => { throw new JobError(e.message, true); });
  if (sha256(buf) !== doc.sha256) throw new JobError('El original cambió después de la carga (huella distinta).', false);
  await updateDocument(doc.id, { status: 'processing' });
  const { page_from: from, page_to: to } = job.payload;
  let parts;
  if (doc.kind === 'image') parts = [{ kind: 'image', mimeType: doc.mime_type, base64: buf.toString('base64') }];
  else {
    const source = await PDFDocument.load(buf, { updateMetadata: false });
    // PDFs escaneados: cada página es una imagen embebida de buena resolución.
    // Enviarla como imagen (detalle alto) se lee mucho mejor que el PDF nativo,
    // que OpenAI rasteriza a baja resolución. Si alguna página no es un escaneo
    // JPEG simple (p. ej. PDF vectorial con texto), se usa el PDF como antes.
    const images = [];
    for (let p = from; p <= to && images; p++) {
      const b64 = pageScanJpeg(source, p - 1);
      if (b64) images.push({ kind: 'image', mimeType: 'image/jpeg', base64: b64 });
      else { images.length = 0; break; }
    }
    if (images.length) parts = images;
    else {
      const out = await PDFDocument.create();
      const copied = await out.copyPages(source, Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i));
      copied.forEach(p => out.addPage(p));
      parts = [{ kind: 'pdf', filename: `${safeName(doc.original_name)}#p${from}-${to}.pdf`, base64: Buffer.from(await out.save()).toString('base64') }];
    }
  }
  let result;
  try {
    result = await extractor.extract({ format: batch.format, documentName: doc.original_name, pageFrom: from, pageTo: to, parts, signal });
  } catch (e) {
    throw new JobError(e.message, e.retryable !== false);
  }
  const { data: cs, error: ce } = await supabase.from('nala_client_settings').select('settings').eq('tenant_id', batch.tenant_id).eq('client_id', batch.client_id).maybeSingle();
  dbError(ce);
  const { data: client, error: cle } = await supabase.from('direct_clients').select('id, legal_name, rnc, cedula').eq('id', batch.client_id).single();
  dbError(cle);
  const clientSettings = cs?.settings || {};
  const contextFor = async clientId => {
    if (clientId === client.id) return { client, settings };
    const { data } = await supabase.from('direct_clients').select('id, legal_name, rnc, cedula').eq('id', clientId).single();
    return { client: data, settings };
  };
  let created = 0; let updated = 0; let skipped = 0;
  for (let index = 0; index < result.invoices.length; index++) {
    const raw = result.invoices[index];
    const mapped = extractor.toFields(batch.format, raw, clientSettings);
    const pageFrom = Math.min(Math.max(from + (Number(raw.pagina_desde) || 1) - 1, from), to);
    const pageTo = Math.min(Math.max(from + (Number(raw.pagina_hasta) || raw.pagina_desde || 1) - 1, pageFrom), to);
    const key = `${doc.id}:${from}:${index}`;
    const clientSide = batch.format === '606' ? ['receptor_id', 'receptor_nombre'] : ['emisor_id', 'emisor_nombre'];
    const meta = { suggested: (mapped.suggested || []).filter(k => !clientSide.includes(k)), lowConfidence: (mapped.lowConfidence || []).filter(k => !clientSide.includes(k)), truncated: mapped.truncated, model: result.model, extracted_at: new Date().toISOString(), job_id: job.id };
    const { data: existing, error: ee } = await supabase.from('nala_invoices').select('*').eq('extraction_key', key).maybeSingle();
    dbError(ee);
    if (existing && ['approved', 'excluded'].includes(existing.status)) {
      skipped++;
      await event(batch.tenant_id, { entity: 'invoice', entity_id: existing.id, invoice_id: existing.id, batch_id: batch.id, client_id: existing.client_id, action: 'reprocess_skipped', details: { status: existing.status } });
      continue;
    }
    const corrected = existing?.corrected_fields || [];
    const fields = { ...mapped.fields };
    for (const k of corrected) fields[k] = existing.fields?.[k] ?? null;
    applyClientSide(fields, batch.format, client, new Set(corrected));
    const row = existing
      ? { ...existing, fields, extracted: raw, extraction_meta: meta, page_from: pageFrom, page_to: pageTo }
      : { tenant_id: batch.tenant_id, client_id: batch.client_id, batch_id: batch.id, document_id: doc.id, extraction_key: key, page_from: pageFrom, page_to: pageTo,
          format: batch.format, period: batch.period, status: 'pending_review', fields, extracted: raw, extraction_meta: meta, corrected_fields: [] };
    const evaluated = stripComputed(await evaluate(batch.tenant_id, row, { client, settings }));
    if (existing) {
      const { error } = await supabase.from('nala_invoices').update({ fields, extracted: raw, extraction_meta: meta, page_from: pageFrom, page_to: pageTo, ...evaluated, version: existing.version + 1, updated_at: new Date().toISOString() })
        .eq('id', existing.id).eq('version', existing.version);
      dbError(error);
      updated++;
      await event(batch.tenant_id, { entity: 'invoice', entity_id: existing.id, invoice_id: existing.id, batch_id: batch.id, client_id: existing.client_id, action: 'reextracted', details: { preserved_corrections: corrected } });
      await refreshPeers(batch.tenant_id, { ...existing, ...evaluated }, contextFor);
    } else {
      const { data: inserted, error } = await supabase.from('nala_invoices').upsert({ ...row, ...evaluated }, { onConflict: 'extraction_key', ignoreDuplicates: true }).select('id').maybeSingle();
      dbError(error);
      if (inserted) {
        created++;
        await event(batch.tenant_id, { entity: 'invoice', entity_id: inserted.id, invoice_id: inserted.id, batch_id: batch.id, client_id: batch.client_id, action: 'extracted',
          details: { document_id: doc.id, pages: [pageFrom, pageTo], model: result.model } });
        await refreshPeers(batch.tenant_id, { ...row, ...evaluated, id: inserted.id }, contextFor);
      }
    }
  }
  return { note: `invoices:+${created}/~${updated}/=${skipped}`, emptyPages: result.emptyPages, found: result.invoices.length };
}

// El lado del propio cliente es fijo: en 606 el comprador (receptor) es la
// empresa del lote; en 607 el vendedor (emisor). No se lee del escaneo: se
// toma del registro del cliente, salvo que un humano lo haya corregido.
function applyClientSide(fields, format, client, corrected) {
  const rnc = String((client && (client.rnc || client.cedula)) || '').replace(/\D/g, '');
  if (!rnc) return;
  const idKey = format === '606' ? 'receptor_id' : 'emisor_id';
  const nameKey = format === '606' ? 'receptor_nombre' : 'emisor_nombre';
  if (!corrected.has(idKey)) fields[idKey] = rnc;
  if (!corrected.has(nameKey) && client.legal_name) fields[nameKey] = client.legal_name;
}

// Re-evaluates a batch's pending invoices against the current rules and client
// settings, without re-reading the originals. Applies the client's defaults
// (currency, payment method, goods/services) and fixes the client's own party.
// Approved/excluded invoices are left intact.
async function revalidate(job, settings) {
  const { data: batch, error: be } = await supabase.from('nala_batches').select('*').eq('id', job.batch_id).single();
  dbError(be);
  const { data: client, error: ce } = await supabase.from('direct_clients').select('id, legal_name, rnc, cedula').eq('id', batch.client_id).single();
  dbError(ce);
  const { data: cs } = await supabase.from('nala_client_settings').select('settings').eq('tenant_id', job.tenant_id).eq('client_id', batch.client_id).maybeSingle();
  const cset = cs?.settings || {};
  const blank = v => v === null || v === undefined || String(v).trim() === '';
  const defMoneda = /^[A-Z]{3}$/.test(String(cset.default_moneda || '').toUpperCase()) ? String(cset.default_moneda).toUpperCase() : null;
  const defFpago = /^\d{1,2}$/.test(String(cset.default_forma_pago || '')) ? String(cset.default_forma_pago).padStart(2, '0') : null;
  const defSplit = ['bienes', 'servicios'].includes(cset.default_split) ? cset.default_split : null;
  const { data: invoices, error: ie } = await supabase.from('nala_invoices').select('*').eq('batch_id', batch.id).in('status', ['pending_review', 'reviewed']);
  dbError(ie);
  let updated = 0;
  for (const inv of invoices || []) {
    const corrected = new Set(inv.corrected_fields || []);
    const fields = { ...inv.fields };
    // Aplica valores por defecto del cliente sólo donde falta y no fue corregido a mano.
    const setDefault = (k, v) => { if (v && blank(fields[k]) && !corrected.has(k)) fields[k] = v; };
    setDefault('moneda', defMoneda);
    setDefault('forma_pago', defFpago);
    if (batch.format === '606' && defSplit && blank(fields.monto_bienes) && blank(fields.monto_servicios) && !blank(fields.total) && money.isValid(fields.total)) {
      const taxes = money.sum([fields.itbis, fields.isc, fields.otros_impuestos, fields.propina]) || '0.00';
      let base = null;
      try { base = money.sub(money.normalize(fields.total), taxes); } catch { base = null; }
      const splitKey = defSplit === 'bienes' ? 'monto_bienes' : 'monto_servicios';
      if (base !== null && money.isValid(base) && !corrected.has(splitKey)) fields[splitKey] = base;
    }
    applyClientSide(fields, batch.format, client, corrected);
    // Los valores por defecto configurados y el lado del cliente se aceptan como
    // política: no generan avisos de "confírmelo" ni de baja confianza.
    const clientSide = batch.format === '606' ? ['receptor_id', 'receptor_nombre'] : ['emisor_id', 'emisor_nombre'];
    const stripSug = new Set(['moneda', 'forma_pago', 'monto_bienes', 'monto_servicios', ...clientSide]);
    const prevMeta = inv.extraction_meta || {};
    const meta = { ...prevMeta,
      suggested: (prevMeta.suggested || []).filter(k => !stripSug.has(k)),
      lowConfidence: (prevMeta.lowConfidence || []).filter(k => !clientSide.includes(k)) };
    const evaluated = stripComputed(await evaluate(batch.tenant_id, { ...inv, fields, extraction_meta: meta }, { client, settings }));
    const { error } = await supabase.from('nala_invoices').update({ ...evaluated, fields, extraction_meta: meta, version: inv.version + 1, updated_at: new Date().toISOString() })
      .eq('id', inv.id).eq('version', inv.version);
    dbError(error);
    updated++;
  }
  return { note: `revalidated:${updated}` };
}

// Marks a document processed/failed when none of its jobs remain open.
async function settleDocument(documentId) {
  if (!documentId) return;
  const { data: jobs, error } = await supabase.from('nala_jobs').select('kind, status, last_error').eq('document_id', documentId);
  dbError(error);
  if (!jobs?.length || jobs.some(j => ['queued', 'running'].includes(j.status))) return;
  const doc = await loadDocument(documentId);
  if (['duplicate', 'unsupported', 'purged'].includes(doc.status) || doc.kind === 'zip') {
    if (doc.kind === 'zip' && jobs.some(j => j.status === 'failed')) await updateDocument(documentId, { status: 'failed', error: jobs.find(j => j.status === 'failed').last_error });
    return;
  }
  const failed = jobs.filter(j => j.status === 'failed');
  const { count } = await supabase.from('nala_invoices').select('id', { count: 'exact', head: true }).eq('document_id', documentId);
  if (failed.length) await updateDocument(documentId, { status: 'failed', error: failed.map(f => f.last_error).filter(Boolean)[0] || 'Falló el procesamiento.' });
  else await updateDocument(documentId, { status: 'processed', processed_at: new Date().toISOString(), error: count ? null : 'No se detectaron comprobantes en este documento.' });
}

async function processJob(job, workerId, timeoutMs = JOB_TIMEOUT_MS) {
  const settings = await settingsStore.load(job.tenant_id);
  const started = Date.now();
  let ok = true; let message = null; let info = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(5000, timeoutMs));
  try {
    info = job.kind === 'prepare' ? await prepare(job, settings)
      : job.kind === 'revalidate' ? await revalidate(job, settings)
      : await extract(job, settings, { signal: controller.signal });
  } catch (error) {
    ok = false;
    message = error.message || String(error);
    if (error instanceof JobError && !error.retryable) {
      // Non-retryable: exhaust attempts so the job fails immediately.
      await supabase.from('nala_jobs').update({ max_attempts: job.attempts }).eq('id', job.id).eq('locked_by', workerId);
    }
  } finally { clearTimeout(timer); }
  const { data: finished, error } = await supabase.rpc('nala_finish_job', { p_job: job.id, p_worker: workerId, p_ok: ok, p_error: message, p_retry_seconds: Number(process.env.NALA_RETRY_BASE_SECONDS) || 20 });
  dbError(error);
  if (finished?.status === 'failed') {
    await event(job.tenant_id, { entity: 'job', entity_id: job.id, batch_id: job.batch_id, action: 'job_failed', details: { kind: job.kind, attempts: job.attempts, error: message } });
  }
  await settleDocument(job.document_id);
  const { error: re } = await supabase.rpc('nala_refresh_batch', { p_batch: job.batch_id });
  dbError(re);
  return { id: job.id, kind: job.kind, ok, error: message, info, status: finished?.status || 'discarded', ms: Date.now() - started };
}

// Runs jobs until the time budget is spent. A new round is claimed only when
// a whole job still fits before the deadline (Vercel stops the function at
// maxDuration), and each job is aborted at the remaining time; an interrupted
// job is recovered later through its lease. tenantId=null processes every
// tenant (scheduled worker); otherwise only the caller's tenant.
const JOB_TIMEOUT_MS = 45000;
async function runJobs({ tenantId = null, budgetMs = 55000, workerId = `w-${crypto.randomBytes(6).toString('hex')}`, concurrency = 3 } = {}) {
  const deadline = Date.now() + budgetMs;
  const results = [];
  while (deadline - Date.now() > Math.min(JOB_TIMEOUT_MS, budgetMs / 2) + 2000) {
    const { data: jobs, error } = await supabase.rpc('nala_claim_jobs', { p_worker: workerId, p_limit: concurrency, p_tenant: tenantId, p_lease_seconds: 120 });
    dbError(error);
    if (!jobs?.length) break;
    const remaining = deadline - Date.now() - 1500;
    results.push(...await Promise.all(jobs.map(job => processJob(job, workerId, Math.min(JOB_TIMEOUT_MS, remaining)))));
  }
  return { worker: workerId, processed: results.length, results };
}

module.exports = { runJobs, processJob, prepare, extract, revalidate, sniff, enqueue, settleDocument, safeName, docPath, JobError, KIND_BY_EXT, MIME_BY_EXT };
