// Exportación DGII 606/607: vista previa, generación con instantánea inmutable
// (la misma para pantalla, TXT y Excel), descargas por enlace temporal y
// seguimiento generado → enviado → aceptado/rechazado.
const crypto = require('crypto');
const supabase = require('../../supabase');
const storage = require('../storage');
const settingsStore = require('../settings');
const formats = require('../formats');
const excel = require('../excel');
const { logEvent, getClient, findDuplicates } = require('../store');
const { derive } = require('../validate');
const h = require('../http');
const templates = require('./templates');

async function scopeInvoices(ctx, body) {
  const client = await getClient(ctx, h.uuid(body.client_id, 'Empresa'), { withSettings: false });
  const format = h.format(body.format);
  const period = h.period(body.period);
  const batchIds = Array.isArray(body.batch_ids) && body.batch_ids.length ? body.batch_ids.map(b => h.uuid(b, 'Lote')) : null;
  let query = supabase.from('nala_invoices').select('id, client_id, batch_id, document_id, format, period, status, fields, corrected_fields, ncf, counterpart_id, version')
    .eq('tenant_id', ctx.tenantId).eq('client_id', client.id).eq('format', format).eq('period', period).neq('status', 'excluded').limit(70000);
  if (batchIds) query = query.in('batch_id', batchIds);
  const { data, error } = await query;
  h.dbError(error);
  const invoices = data || [];
  for (const invoice of invoices.filter(i => i.status === 'approved')) {
    invoice.duplicates = (await findDuplicates(ctx.tenantId, invoice, derive(format, invoice.fields))).filter(d => d.status === 'approved');
  }
  const pendingCount = invoices.filter(i => i.status !== 'approved').length;
  const settings = await settingsStore.load(ctx.tenantId);
  const txtStyle = settings.dgii_templates?.[format]?.txt_style || null;
  const snapshot = formats.buildSnapshot({ format, period, client, invoices, pendingCount, settings: settings.rules, scope: batchIds ? 'batches' : 'period', batchIds, txtStyle });
  return { client, snapshot, invoices, settings };
}

const fingerprintOf = snapshot => crypto.createHash('sha256').update(JSON.stringify(snapshot.lines.map(l => [l.invoice_id, l.values]))).digest('hex');

async function preview(ctx, body) {
  ctx.require('view');
  const { snapshot } = await scopeInvoices(ctx, body);
  const txt = snapshot.errors.length ? null : formats.toTxt(snapshot);
  return { snapshot, dgii_tool: formats.toolRows(snapshot), fingerprint: fingerprintOf(snapshot), txt_preview: txt ? txt.split('\r\n').slice(0, 6).join('\n') : null, txt_check: txt ? formats.validateTxt(snapshot.format, txt, snapshot.txt_style) : null };
}

async function create(ctx, body) {
  ctx.require('export');
  const { client, snapshot, invoices } = await scopeInvoices(ctx, body);
  if (snapshot.errors.length) h.fail(422, 'La exportación tiene errores críticos que deben corregirse.', { errors: snapshot.errors });
  // Every warning must be explicitly accepted, and the acceptance is recorded.
  const accepted = new Set(Array.isArray(body.accepted_warnings) ? body.accepted_warnings.map(String) : []);
  const missing = snapshot.warnings.filter(w => !accepted.has(w.code));
  const reason = h.text(body.reason, { max: 500 });
  if (missing.length) h.fail(422, 'Debe aceptar cada advertencia antes de exportar.', { warnings: missing });
  if (snapshot.warnings.length && reason.length < 5) h.fail(422, 'Indique el motivo para exportar con advertencias.');
  // The client can compare the snapshot it previewed; if data changed since,
  // it must preview again so screen, TXT and Excel stay identical.
  const fingerprint = fingerprintOf(snapshot);
  if (body.preview_fingerprint && body.preview_fingerprint !== fingerprint) h.fail(409, 'Los datos cambiaron desde la vista previa. Vuelva a previsualizar.');
  const txt = formats.toTxt(snapshot);
  const check = formats.validateTxt(snapshot.format, txt, snapshot.txt_style);
  if (!check.valid) h.fail(500, 'El TXT generado no superó la validación estructural.', { problems: check.problems });
  const txtBuffer = Buffer.from(txt, 'ascii');
  const txtSha = crypto.createHash('sha256').update(txtBuffer).digest('hex');
  const exportId = crypto.randomUUID();
  const generatedAt = new Date().toISOString();
  const base = `${ctx.tenantId}/exports/${exportId}`;
  const xlsx = await excel.buildOfficial(snapshot, { exportId, txtSha256: txtSha, generatedAt });
  await storage.upload(`${base}/${snapshot.file_name}`, txtBuffer, 'text/plain');
  await storage.upload(`${base}/${snapshot.file_name.replace(/\.txt$/i, '')}.xlsx`, xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const row = {
    id: exportId, tenant_id: ctx.tenantId, client_id: client.id, format: snapshot.format, period: snapshot.period, scope: snapshot.scope, batch_ids: snapshot.batch_ids,
    status: 'generated', schema_version: snapshot.schema_version, rules_version: snapshot.rules_version, line_count: snapshot.lines.length, totals: snapshot.totals,
    snapshot: { ...snapshot, fingerprint, generated_at: generatedAt }, warnings: snapshot.warnings, accepted_warnings: [...accepted], acceptance_reason: snapshot.warnings.length ? reason : null,
    file_name: snapshot.file_name, txt_path: `${base}/${snapshot.file_name}`, txt_sha256: txtSha, xlsx_path: `${base}/${snapshot.file_name.replace(/\.txt$/i, '')}.xlsx`, created_by: ctx.userId,
  };
  const { error } = await supabase.from('nala_exports').insert(row);
  h.dbError(error);
  for (let i = 0; i < snapshot.lines.length; i += 500) {
    const { error: le } = await supabase.from('nala_export_lines').insert(snapshot.lines.slice(i, i + 500).map(l => ({ export_id: exportId, line_no: l.line_no, invoice_id: l.invoice_id })));
    h.dbError(le);
  }
  await logEvent(ctx, { entity: 'export', entity_id: exportId, client_id: client.id, action: 'export_generated', reason: row.acceptance_reason,
    details: { format: snapshot.format, period: snapshot.period, lines: snapshot.lines.length, txt_sha256: txtSha, accepted_warnings: [...accepted], scope: snapshot.scope, batch_ids: snapshot.batch_ids } });
  for (const line of snapshot.lines) {
    const inv = invoices.find(i => i.id === line.invoice_id);
    await logEvent(ctx, { entity: 'invoice', entity_id: line.invoice_id, invoice_id: line.invoice_id, batch_id: inv?.batch_id, client_id: client.id, action: 'exported', details: { export_id: exportId, line_no: line.line_no } });
  }
  return { export: { ...row, snapshot: undefined }, fingerprint };
}

async function list(ctx, q) {
  ctx.require('view');
  let query = supabase.from('nala_exports').select('id, client_id, format, period, scope, batch_ids, status, line_count, totals, file_name, txt_sha256, created_by, created_at, submitted_at, submission_reference, result_at, result_notes, superseded_reason, accepted_warnings, acceptance_reason')
    .eq('tenant_id', ctx.tenantId).order('created_at', { ascending: false }).limit(200);
  if (q.client_id) { ctx.requireClient(h.uuid(q.client_id)); query = query.eq('client_id', q.client_id); }
  else if (ctx.scopeArray()) query = query.in('client_id', ctx.scopeArray().length ? ctx.scopeArray() : ['00000000-0000-0000-0000-000000000000']);
  if (q.period) query = query.eq('period', h.period(q.period));
  if (q.format) query = query.eq('format', h.format(q.format));
  const { data, error } = await query;
  h.dbError(error);
  return { exports: data || [] };
}

async function getExport(ctx, id) {
  const { data, error } = await supabase.from('nala_exports').select('*').eq('tenant_id', ctx.tenantId).eq('id', h.uuid(id)).maybeSingle();
  h.dbError(error);
  if (!data) h.fail(404, 'Exportación no encontrada.');
  ctx.requireClient(data.client_id);
  return data;
}

async function detail(ctx, id) {
  ctx.require('view');
  const exp = await getExport(ctx, id);
  return { export: exp, dgii_tool: exp.snapshot ? formats.toolRows(exp.snapshot) : null };
}

async function download(ctx, id, q) {
  ctx.require('view');
  const exp = await getExport(ctx, id);
  const type = String(q.type || 'txt');
  if (type === 'txt') return { url: await storage.signedDownload(exp.txt_path, 120, exp.file_name), file_name: exp.file_name, sha256: exp.txt_sha256 };
  if (type === 'xlsx') return { url: await storage.signedDownload(exp.xlsx_path, 120, exp.xlsx_path.split('/').pop()), file_name: exp.xlsx_path.split('/').pop() };
  if (type === 'custom') {
    const columns = String(q.columns || '').split(',').filter(Boolean);
    const buffer = await excel.buildCustom(exp.snapshot, columns, { exportId: exp.id, txtSha256: exp.txt_sha256, generatedAt: exp.snapshot.generated_at });
    return { base64: buffer.toString('base64'), file_name: `NALA_${exp.format}_${exp.period}_personalizado.xlsx` };
  }
  if (type === 'template') return templates.filledWorkbook(ctx, exp, exp.snapshot ? formats.toolRows(exp.snapshot) : null);
  h.fail(400, 'Tipo de descarga no válido.');
}

const TRANSITIONS = { generated: ['submitted', 'superseded'], submitted: ['accepted', 'rejected'], rejected: ['superseded'], accepted: [], superseded: [] };

async function setStatus(ctx, id, body) {
  ctx.require('submit');
  const exp = await getExport(ctx, id);
  const next = String(body.status || '');
  if (!(TRANSITIONS[exp.status] || []).includes(next)) h.fail(409, `No se puede pasar de "${exp.status}" a "${next}".`);
  const patch = { status: next };
  if (next === 'submitted') {
    patch.submitted_by = ctx.userId; patch.submitted_at = body.submitted_at && /^\d{4}-\d{2}-\d{2}/.test(body.submitted_at) ? new Date(body.submitted_at).toISOString() : new Date().toISOString();
    patch.submission_reference = h.text(body.reference, { max: 120 }) || null;
  } else if (next === 'accepted' || next === 'rejected') {
    patch.result_by = ctx.userId; patch.result_at = new Date().toISOString();
    patch.result_notes = h.text(body.notes, { max: 1000, min: next === 'rejected' ? 5 : 0, label: 'El detalle del rechazo' }) || null;
  } else if (next === 'superseded') {
    patch.superseded_reason = h.text(body.notes, { max: 500, min: 5, label: 'El motivo' });
  }
  const { data, error } = await supabase.from('nala_exports').update(patch).eq('id', exp.id).eq('tenant_id', ctx.tenantId).eq('status', exp.status).select('id, status, submitted_at, submission_reference, result_at, result_notes').maybeSingle();
  h.dbError(error);
  if (!data) h.fail(409, 'La exportación cambió. Recargue.');
  await logEvent(ctx, { entity: 'export', entity_id: exp.id, client_id: exp.client_id, action: `export_${next}`, reason: patch.result_notes || patch.superseded_reason || null, details: { reference: patch.submission_reference || null } });
  return { export: data };
}

// ── Listos para exportar ───────────────────────────────────────────────────
// Por empresa, formato y período: cuántos comprobantes están aprobados y cuántos
// faltan por auditar, más el último archivo generado (consolidado del mes). Con
// «auditoría completa» (aprobados > 0 y ninguno pendiente) se puede sacar el TXT o
// el Excel con un clic. La huella del último archivo permite reutilizarlo si nada cambió.
async function ready(ctx, q) {
  ctx.require('view');
  const clientId = q.client_id ? h.uuid(q.client_id, 'Empresa') : null;
  const period = h.optPeriod(q.period);
  const format = h.optFormat(q.format);
  const scoped = query => {
    if (clientId) { ctx.requireClient(clientId); query = query.eq('client_id', clientId); }
    else if (ctx.scopeArray()) query = query.in('client_id', ctx.scopeArray().length ? ctx.scopeArray() : ['00000000-0000-0000-0000-000000000000']);
    if (period) query = query.eq('period', period);
    if (format) query = query.eq('format', format);
    return query;
  };
  const [inv, exp] = await Promise.all([
    scoped(supabase.from('nala_invoices').select('client_id, format, period, status').eq('tenant_id', ctx.tenantId).neq('status', 'excluded').limit(70000)),
    scoped(supabase.from('nala_exports').select('id, client_id, format, period, status, file_name, line_count, created_at, fingerprint:snapshot->>fingerprint')
      .eq('tenant_id', ctx.tenantId).eq('scope', 'period').neq('status', 'superseded').order('created_at', { ascending: false }).limit(2000)),
  ]);
  h.dbError(inv.error); h.dbError(exp.error);
  const groups = new Map();
  for (const r of inv.data || []) {
    const key = `${r.client_id}|${r.format}|${r.period}`;
    const g = groups.get(key) || { client_id: r.client_id, format: r.format, period: r.period, approved: 0, open: 0, last_export: null };
    if (r.status === 'approved') g.approved += 1; else g.open += 1;
    groups.set(key, g);
  }
  for (const e of exp.data || []) {
    const g = groups.get(`${e.client_id}|${e.format}|${e.period}`);
    if (g && !g.last_export) g.last_export = { id: e.id, status: e.status, file_name: e.file_name, line_count: e.line_count, created_at: e.created_at, fingerprint: e.fingerprint || null };
  }
  const items = [...groups.values()].map(g => ({ ...g, ready: g.approved > 0 && g.open === 0 }))
    .sort((a, b) => (b.ready - a.ready) || b.period.localeCompare(a.period) || a.format.localeCompare(b.format) || a.client_id.localeCompare(b.client_id));
  return { items };
}

// ── Informativo en cero ────────────────────────────────────────────────────
// Sin operaciones en el período, la DGII pide remitir los formatos 606, 607 y 608
// «de manera informativa» (Oficina Virtual → Declaraciones en Cero). No hay
// archivo: se guarda el código de referencia como evento inmutable (nala_events).
const ZERO_FORMATS = ['606', '607', '608'];

async function periodCounts(ctx, clientId, period) {
  const base = () => supabase.from('nala_invoices').select('id', { count: 'exact', head: true })
    .eq('tenant_id', ctx.tenantId).eq('client_id', clientId).eq('period', period);
  const out = {};
  await Promise.all(['606', '607'].map(async fmt => {
    const [approved, open] = await Promise.all([
      base().eq('format', fmt).eq('status', 'approved'),
      base().eq('format', fmt).in('status', ['pending_review', 'reviewed']),
    ]);
    h.dbError(approved.error); h.dbError(open.error);
    out[fmt] = { approved: approved.count || 0, open: open.count || 0 };
  }));
  return out;
}

async function zeroList(ctx, q) {
  ctx.require('view');
  const clientId = h.uuid(q.client_id, 'Empresa');
  ctx.requireClient(clientId);
  const period = h.optPeriod(q.period);
  let query = supabase.from('nala_events').select('id, details, created_at').eq('tenant_id', ctx.tenantId)
    .eq('client_id', clientId).eq('entity', 'client').eq('action', 'zero_filed').order('id', { ascending: false }).limit(100);
  if (period) query = query.eq('details->>period', period);
  const { data, error } = await query;
  h.dbError(error);
  const filings = (data || []).map(e => ({ id: e.id, format: e.details?.format, period: e.details?.period, reference: e.details?.reference, submitted_at: e.details?.submitted_at || e.created_at }));
  return { filings, counts: period ? await periodCounts(ctx, clientId, period) : null };
}

async function zeroCreate(ctx, body) {
  ctx.require('submit');
  const clientId = h.uuid(body.client_id, 'Empresa');
  ctx.requireClient(clientId);
  const format = String(body.format || '');
  if (!ZERO_FORMATS.includes(format)) h.fail(400, 'El formato debe ser 606, 607 o 608.');
  const period = h.period(body.period);
  const reference = h.text(body.reference, { max: 60, min: 4, label: 'El código de referencia' });
  const submittedAt = body.submitted_at && /^\d{4}-\d{2}-\d{2}/.test(body.submitted_at) ? new Date(body.submitted_at).toISOString() : new Date().toISOString();
  await getClient(ctx, clientId, { withSettings: false });
  // El 608 (anulados) no se maneja en NALA; 606 y 607 solo se declaran en cero si no hay operaciones.
  if (format !== '608') {
    const c = (await periodCounts(ctx, clientId, period))[format];
    if (c.approved) h.fail(409, `Este período tiene ${c.approved} comprobante(s) aprobado(s) en el ${format}: se remite el archivo con las operaciones, no el informativo en cero.`);
    if (c.open) h.fail(409, `Este período tiene ${c.open} comprobante(s) sin aprobar en el ${format}. Apruébalos o exclúyelos antes de declarar el período en cero.`);
  }
  const { data: dup, error } = await supabase.from('nala_events').select('id').eq('tenant_id', ctx.tenantId).eq('client_id', clientId)
    .eq('entity', 'client').eq('action', 'zero_filed').eq('details->>format', format).eq('details->>period', period).eq('details->>reference', reference).limit(1);
  h.dbError(error);
  if (dup?.length) h.fail(409, 'Ese código de referencia ya está registrado para este período.');
  await logEvent(ctx, { entity: 'client', entity_id: clientId, client_id: clientId, action: 'zero_filed', details: { format, period, reference, submitted_at: submittedAt } });
  return { filing: { format, period, reference, submitted_at: submittedAt } };
}

module.exports = { preview, create, list, detail, download, setStatus, ready, zeroList, zeroCreate };
