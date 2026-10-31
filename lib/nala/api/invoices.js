// Auditoría fiscal: consulta (por lote o unificada), edición con control de
// versión y bloqueo, aprobación separada del guardado, reversión, reubicación
// y exclusión. Todo cambio queda en nala_events.
const supabase = require('../../supabase');
const settingsStore = require('../settings');
const rules = require('../rules');
const { logEvent, getClient, getBatch, getInvoice, evaluate, stripComputed, refreshPeers } = require('../store');
const h = require('../http');

const money = require('../money');

// numeric(18,2) columns arrive from PostgREST as JSON numbers; expose them as
// exact two-decimal strings like every other amount in NALA.
function present(invoice) {
  if (!invoice) return invoice;
  const out = { ...invoice };
  for (const key of ['subtotal_dop', 'itbis_dop', 'total_dop']) out[key] = out[key] === null || out[key] === undefined ? null : money.normalize(String(out[key]));
  return out;
}
const LIST_COLUMNS = 'id, client_id, batch_id, document_id, page_from, page_to, format, period, status, fields, corrected_fields, issues, critical_count, warning_count, ncf, counterpart_id, counterpart_name, invoice_date, currency, subtotal_dop, itbis_dop, total_dop, version, approved_by, approved_at, edit_lock_user, edit_lock_until, updated_at';

function applyFilters(ctx, query, q) {
  if (q.client_id) { ctx.requireClient(h.uuid(q.client_id)); query = query.eq('client_id', q.client_id); }
  else if (ctx.scopeArray()) query = query.in('client_id', ctx.scopeArray().length ? ctx.scopeArray() : ['00000000-0000-0000-0000-000000000000']);
  if (q.batch_id) query = query.eq('batch_id', h.uuid(q.batch_id));
  if (q.period) query = query.eq('period', h.period(q.period));
  if (q.format) query = query.eq('format', h.format(q.format));
  if (q.status) query = query.in('status', String(q.status).split(',').filter(s => ['pending_review', 'reviewed', 'approved', 'excluded'].includes(s)));
  else query = query.neq('status', 'excluded');
  if (q.has === 'errors') query = query.gt('critical_count', 0);
  if (q.has === 'warnings') query = query.gt('warning_count', 0);
  if (q.has === 'duplicates') query = query.contains('issues', JSON.stringify([{ code: 'DUPLICADO' }]));
  if (q.has === 'foreign') query = query.not('currency', 'is', null).neq('currency', 'DOP');
  if (q.q) {
    const term = String(q.q).replace(/[%,()]/g, ' ').trim().slice(0, 60);
    if (term) query = query.or(`ncf.ilike.%${term}%,counterpart_id.ilike.%${term}%,counterpart_name.ilike.%${term}%`);
  }
  return query;
}

async function list(ctx, q) {
  ctx.require('view');
  const limit = Math.min(Number(q.limit) || 500, 1000);
  let query = supabase.from('nala_invoices').select(LIST_COLUMNS, { count: 'exact' }).eq('tenant_id', ctx.tenantId);
  // Orden de archivo: por documento y posición de página (como vienen en el PDF/lote),
  // luego por fecha como desempate en la vista consolidada de varios documentos.
  query = applyFilters(ctx, query, q).order('document_id', { ascending: true, nullsFirst: false }).order('page_from', { ascending: true, nullsFirst: false }).order('page_to', { ascending: true, nullsFirst: false }).order('invoice_date', { ascending: true, nullsFirst: false }).order('id').limit(limit);
  const { data, error, count } = await query;
  h.dbError(error);
  return { invoices: (data || []).map(present), total: count ?? (data || []).length };
}

async function contextFor(ctx, settings) {
  const cache = new Map();
  return async clientId => {
    if (!cache.has(clientId)) {
      const { data } = await supabase.from('direct_clients').select('id, legal_name, rnc, cedula').eq('tenant_id', ctx.tenantId).eq('id', clientId).single();
      cache.set(clientId, { client: data, settings });
    }
    return cache.get(clientId);
  };
}

async function detail(ctx, id) {
  ctx.require('view');
  const invoice = await getInvoice(ctx, h.uuid(id));
  const [client, batch, { data: doc }, { data: events, error: ee }, { data: lines, error: le }] = await Promise.all([
    getClient(ctx, invoice.client_id, { withSettings: false }),
    supabase.from('nala_batches').select('id, name, client_id, format, period, status').eq('id', invoice.batch_id).single().then(r => r.data),
    invoice.document_id ? supabase.from('nala_documents').select('id, original_name, mime_type, kind, page_count, sha256, status, size_bytes, uploaded_at, uploaded_by').eq('id', invoice.document_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from('nala_events').select('id, action, actor, reason, details, created_at').eq('tenant_id', ctx.tenantId).eq('invoice_id', invoice.id).order('id', { ascending: false }).limit(200),
    supabase.from('nala_export_lines').select('line_no, export_id, nala_exports!inner(id, status, created_at, file_name, tenant_id)').eq('invoice_id', invoice.id).eq('nala_exports.tenant_id', ctx.tenantId),
  ]);
  h.dbError(ee); h.dbError(le);
  const settings = await settingsStore.load(ctx.tenantId);
  const computed = (await evaluate(ctx.tenantId, invoice, { client, settings }))._computed;
  return {
    invoice: present(invoice), client, batch, document: doc, events: events || [], computed,
    exports: (lines || []).map(l => ({ export_id: l.export_id, line_no: l.line_no, status: l.nala_exports.status, file_name: l.nala_exports.file_name, created_at: l.nala_exports.created_at })),
    lock: { locked_by_other: false }, // sin bloqueo de edición: varios usuarios pueden abrir el mismo comprobante; la versión evita pisar cambios
    fields_order: rules.FORMAT_FIELDS[invoice.format], field_defs: rules.FIELD_DEFS,
    reallocated: batch && batch.client_id !== invoice.client_id,
  };
}

// Sin bloqueo de edición: se conserva la ruta por compatibilidad con pantallas ya abiertas.
async function lock(ctx, id) {
  ctx.require('edit');
  await getInvoice(ctx, h.uuid(id));
  return { lock: null };
}

function assertEditable(ctx, invoice) {
  if (invoice.status === 'approved') h.fail(409, 'El comprobante está aprobado: revierta la aprobación para editarlo.');
  if (invoice.status === 'excluded') h.fail(409, 'El comprobante está excluido: restáurelo para editarlo.');
}

async function save(ctx, id, body) {
  ctx.require('edit');
  const invoice = await getInvoice(ctx, h.uuid(id));
  assertEditable(ctx, invoice);
  if (Number(body.version) !== invoice.version) h.fail(409, 'El comprobante fue modificado por otra persona. Recargue para ver la versión actual.', { current_version: invoice.version });
  const allowed = new Set(rules.FORMAT_FIELDS[invoice.format]);
  const incoming = body.fields && typeof body.fields === 'object' ? body.fields : {};
  const fields = { ...invoice.fields };
  const changes = {};
  for (const [key, raw] of Object.entries(incoming)) {
    if (!allowed.has(key)) h.fail(400, `Campo no editable: ${key}`);
    let value = raw === null || raw === undefined ? null : String(raw).trim().slice(0, 200);
    if (value === '') value = null;
    const def = rules.FIELD_DEFS[key];
    if (value !== null && def.type === 'amount') value = value.replace(/,/g, '');
    if (value !== null && ['id'].includes(def.type)) value = value.replace(/[\s-]/g, '');
    if (value !== null && ['ncf', 'currency'].includes(def.type)) value = value.toUpperCase().replace(/\s+/g, '');
    if ((fields[key] ?? null) !== value) { changes[key] = [fields[key] ?? null, value]; fields[key] = value; }
  }
  fields.moneda = 'DOP'; // la moneda es siempre pesos (obligatorio)
  // Every field the auditor submits counts as reviewed by a human (including
  // confirming a suggested value unchanged), so re-extraction never replaces it.
  const confirmed = Object.keys(incoming);
  const corrected = [...new Set([...(invoice.corrected_fields || []), ...confirmed])];
  if (!Object.keys(changes).length && invoice.status !== 'pending_review' && corrected.length === (invoice.corrected_fields || []).length) return { invoice: present(invoice), unchanged: true };
  const settings = await settingsStore.load(ctx.tenantId);
  const client = await getClient(ctx, invoice.client_id, { withSettings: false });
  const evaluated = stripComputed(await evaluate(ctx.tenantId, { ...invoice, fields, corrected_fields: corrected }, { client, settings }));
  const { data, error } = await supabase.from('nala_invoices').update({ fields, corrected_fields: corrected, ...evaluated, status: 'reviewed', version: invoice.version + 1, updated_at: new Date().toISOString(), updated_by: ctx.userId })
    .eq('id', invoice.id).eq('tenant_id', ctx.tenantId).eq('version', invoice.version).select('*').maybeSingle();
  h.dbError(error);
  if (!data) h.fail(409, 'El comprobante fue modificado por otra persona. Recargue para ver la versión actual.');
  await logEvent(ctx, { entity: 'invoice', entity_id: invoice.id, invoice_id: invoice.id, batch_id: invoice.batch_id, client_id: invoice.client_id, action: 'saved', details: { changes, confirmed, version: data.version } });
  const peersFor = await contextFor(ctx, settings);
  await refreshPeers(ctx.tenantId, data, peersFor);
  if (invoice.ncf && invoice.ncf !== data.ncf) await refreshPeers(ctx.tenantId, invoice, peersFor);
  return { invoice: present(data) };
}

async function approve(ctx, id, body) {
  ctx.require('approve');
  const invoice = await getInvoice(ctx, h.uuid(id));
  assertEditable(ctx, invoice);
  if (Number(body.version) !== invoice.version) h.fail(409, 'Hay cambios más recientes. Recargue antes de aprobar.', { current_version: invoice.version });
  const settings = await settingsStore.load(ctx.tenantId);
  const client = await getClient(ctx, invoice.client_id, { withSettings: false });
  const evaluated = stripComputed(await evaluate(ctx.tenantId, invoice, { client, settings }));
  if (evaluated.critical_count > 0) {
    await supabase.from('nala_invoices').update(evaluated).eq('id', invoice.id).eq('version', invoice.version);
    h.fail(422, 'No se puede aprobar: hay errores críticos.', { issues: evaluated.issues.filter(i => i.severity === 'critical') });
  }
  const warnings = evaluated.issues.filter(i => i.severity === 'warning');
  const reason = h.text(body.reason, { max: 500 }) || null;
  if (warnings.length && (body.accept_warnings !== true || !reason || reason.length < 5)) h.fail(422, 'Aprobar con advertencias requiere confirmarlas e indicar el motivo.', { warnings });
  // Al aprobar, las advertencias quedan aceptadas: se quitan de los avisos
  // abiertos (warning_count 0, sin issues de tipo warning) para que el
  // comprobante quede "listo". Se conservan en approval_warnings y en el
  // historial. Al revertir se recalculan.
  const { data, error } = await supabase.from('nala_invoices').update({ ...evaluated,
    issues: evaluated.issues.filter(i => i.severity !== 'warning'), warning_count: 0,
    status: 'approved', approved_by: ctx.userId, approved_at: new Date().toISOString(), approval_reason: reason,
    approval_warnings: warnings.map(w => ({ code: w.code, message: w.message, field: w.field })), version: invoice.version + 1, updated_at: new Date().toISOString(), updated_by: ctx.userId, edit_lock_user: null, edit_lock_until: null })
    .eq('id', invoice.id).eq('tenant_id', ctx.tenantId).eq('version', invoice.version).in('status', ['pending_review', 'reviewed']).select('*').maybeSingle();
  if (error?.code === '23505') h.fail(409, 'Ya existe un comprobante aprobado con el mismo NCF y contraparte para esta empresa.');
  h.dbError(error);
  if (!data) h.fail(409, 'El comprobante cambió mientras se aprobaba. Recargue.');
  await logEvent(ctx, { entity: 'invoice', entity_id: invoice.id, invoice_id: invoice.id, batch_id: invoice.batch_id, client_id: invoice.client_id, action: 'approved', reason,
    details: { warnings: data.approval_warnings, rules_version: data.rules_version, total_dop: data.total_dop } });
  await supabase.rpc('nala_refresh_batch', { p_batch: invoice.batch_id });
  return { invoice: present(data) };
}

// Aprobación masiva desde la lista: aprueba sólo los comprobantes que, tras
// re-evaluarse en el servidor, salen "con cotejo verde" (sin errores críticos
// NI advertencias). Cualquier seleccionado que no lo esté se omite y se informa;
// nunca aprueba con advertencias (eso sigue siendo uno por uno, con motivo).
async function approveBulk(ctx, body) {
  ctx.require('approve');
  const ids = Array.isArray(body?.ids) ? [...new Set(body.ids.map(String))] : [];
  if (!ids.length) h.fail(400, 'No se seleccionaron comprobantes.');
  if (ids.length > 300) h.fail(400, 'Seleccione como máximo 300 comprobantes por tanda.');
  const settings = await settingsStore.load(ctx.tenantId);
  const approved = []; const skipped = []; const batches = new Set();
  for (const rawId of ids) {
    try {
      const invoice = await getInvoice(ctx, h.uuid(rawId));
      if (invoice.status === 'approved') { skipped.push({ id: invoice.id, ncf: invoice.ncf, reason: 'Ya estaba aprobado.' }); continue; }
      if (invoice.status === 'excluded') { skipped.push({ id: invoice.id, ncf: invoice.ncf, reason: 'Está excluido.' }); continue; }
      const client = await getClient(ctx, invoice.client_id, { withSettings: false });
      const evaluated = stripComputed(await evaluate(ctx.tenantId, invoice, { client, settings }));
      if (evaluated.critical_count > 0 || evaluated.warning_count > 0) {
        // Dejar el conteo recalculado, pero no aprobar: no tiene cotejo verde.
        await supabase.from('nala_invoices').update(evaluated).eq('id', invoice.id).eq('tenant_id', ctx.tenantId).eq('version', invoice.version);
        skipped.push({ id: invoice.id, ncf: invoice.ncf, reason: evaluated.critical_count > 0 ? 'Tiene errores por corregir.' : 'Tiene advertencias: apruébelo individualmente.' });
        continue;
      }
      const { data, error } = await supabase.from('nala_invoices').update({ ...evaluated, status: 'approved', approved_by: ctx.userId, approved_at: new Date().toISOString(), approval_reason: null,
        approval_warnings: [], version: invoice.version + 1, updated_at: new Date().toISOString(), updated_by: ctx.userId, edit_lock_user: null, edit_lock_until: null })
        .eq('id', invoice.id).eq('tenant_id', ctx.tenantId).eq('version', invoice.version).in('status', ['pending_review', 'reviewed']).select('*').maybeSingle();
      if (error?.code === '23505') { skipped.push({ id: invoice.id, ncf: invoice.ncf, reason: 'Ya hay otro aprobado con el mismo NCF y contraparte.' }); continue; }
      if (error) { skipped.push({ id: invoice.id, ncf: invoice.ncf, reason: 'No se pudo guardar.' }); continue; }
      if (!data) { skipped.push({ id: invoice.id, ncf: invoice.ncf, reason: 'Cambió mientras se aprobaba; recargue.' }); continue; }
      await logEvent(ctx, { entity: 'invoice', entity_id: invoice.id, invoice_id: invoice.id, batch_id: invoice.batch_id, client_id: invoice.client_id, action: 'approved', reason: null,
        details: { bulk: true, rules_version: data.rules_version, total_dop: data.total_dop } });
      approved.push({ id: invoice.id, ncf: invoice.ncf });
      if (invoice.batch_id) batches.add(invoice.batch_id);
    } catch (e) {
      if (e && e.status === 404) { skipped.push({ id: rawId, reason: 'No encontrado.' }); continue; }
      throw e;
    }
  }
  for (const b of batches) await supabase.rpc('nala_refresh_batch', { p_batch: b });
  return { approved_count: approved.length, skipped_count: skipped.length, approved, skipped };
}

async function revert(ctx, id, body) {
  ctx.require('revert');
  const invoice = await getInvoice(ctx, h.uuid(id));
  if (invoice.status !== 'approved') h.fail(409, 'Sólo se revierten comprobantes aprobados.');
  // Editar una factura aprobada no exige justificación: sin motivo queda registrado como «Reabierta para editar».
  const reason = h.text(body.reason, { max: 500, min: 0, label: 'El motivo de la reversión' }) || 'Reabierta para editar';
  const { data: lines, error: le } = await supabase.from('nala_export_lines').select('export_id, nala_exports!inner(id, status, tenant_id)').eq('invoice_id', invoice.id).eq('nala_exports.tenant_id', ctx.tenantId);
  h.dbError(le);
  const locked = (lines || []).filter(l => ['submitted', 'accepted'].includes(l.nala_exports.status));
  if (locked.length) h.fail(409, 'El comprobante está en una exportación enviada o aceptada por la DGII; registre una rectificación en lugar de revertir.', { exports: locked.map(l => l.export_id) });
  const generated = [...new Set((lines || []).filter(l => l.nala_exports.status === 'generated').map(l => l.export_id))];
  if (generated.length) {
    const { error } = await supabase.from('nala_exports').update({ status: 'superseded', superseded_reason: `Reversión de aprobación: ${reason}` }).in('id', generated).eq('tenant_id', ctx.tenantId);
    h.dbError(error);
  }
  // Al revertir se recalculan los avisos (las advertencias que se habían
  // aceptado al aprobar vuelven a aparecer para su revisión).
  const settings = await settingsStore.load(ctx.tenantId);
  const client = await getClient(ctx, invoice.client_id, { withSettings: false });
  const evaluated = stripComputed(await evaluate(ctx.tenantId, invoice, { client, settings }));
  const { data, error } = await supabase.from('nala_invoices').update({ ...evaluated, status: 'reviewed', approved_by: null, approved_at: null, approval_reason: null, approval_warnings: null, version: invoice.version + 1, updated_at: new Date().toISOString(), updated_by: ctx.userId })
    .eq('id', invoice.id).eq('tenant_id', ctx.tenantId).eq('status', 'approved').select('*').maybeSingle();
  h.dbError(error);
  if (!data) h.fail(409, 'El comprobante cambió. Recargue.');
  await logEvent(ctx, { entity: 'invoice', entity_id: invoice.id, invoice_id: invoice.id, batch_id: invoice.batch_id, client_id: invoice.client_id, action: 'approval_reverted', reason, details: { superseded_exports: generated } });
  await supabase.rpc('nala_refresh_batch', { p_batch: invoice.batch_id });
  return { invoice: present(data), superseded_exports: generated };
}

async function relocate(ctx, id, body) {
  ctx.require('relocate');
  const invoice = await getInvoice(ctx, h.uuid(id));
  assertEditable(ctx, invoice);
  const targetClient = await getClient(ctx, h.uuid(body.client_id, 'Empresa destino'), { withSettings: false });
  const targetPeriod = h.period(body.period, 'período destino');
  const reason = h.text(body.reason, { max: 500, min: 5, label: 'El motivo de la reubicación' });
  if (targetClient.id === invoice.client_id && targetPeriod === invoice.period) h.fail(400, 'Indique una empresa o período distinto.');
  if (targetClient.status === 'inactive') h.fail(409, 'La empresa destino está inactiva.');
  const settings = await settingsStore.load(ctx.tenantId);
  const moved = { ...invoice, client_id: targetClient.id, period: targetPeriod };
  const evaluated = stripComputed(await evaluate(ctx.tenantId, moved, { client: targetClient, settings }));
  const { data, error } = await supabase.from('nala_invoices').update({ client_id: targetClient.id, period: targetPeriod, ...evaluated, status: 'reviewed', version: invoice.version + 1, updated_at: new Date().toISOString(), updated_by: ctx.userId })
    .eq('id', invoice.id).eq('tenant_id', ctx.tenantId).eq('version', invoice.version).select('*').maybeSingle();
  h.dbError(error);
  if (!data) h.fail(409, 'El comprobante cambió. Recargue.');
  const from = { client_id: invoice.client_id, period: invoice.period };
  await logEvent(ctx, { entity: 'invoice', entity_id: invoice.id, invoice_id: invoice.id, batch_id: invoice.batch_id, client_id: targetClient.id, action: 'relocated', reason, details: { from, to: { client_id: targetClient.id, period: targetPeriod } } });
  const peersFor = await contextFor(ctx, settings);
  await refreshPeers(ctx.tenantId, invoice, peersFor);
  await refreshPeers(ctx.tenantId, data, peersFor);
  await supabase.rpc('nala_refresh_batch', { p_batch: invoice.batch_id });
  return { invoice: present(data) };
}

async function setExcluded(ctx, id, body, exclude) {
  ctx.require('exclude');
  let invoice = await getInvoice(ctx, h.uuid(id));
  if (exclude && invoice.status === 'approved') {
    // Eliminar un comprobante ya aprobado (p. ej. la DGII lo rechazó al enviar): se revierte la
    // aprobación en el mismo paso (con sus protecciones: no si ya fue enviado/aceptado) y se excluye.
    ctx.require('revert');
    const why = h.text(body.reason, { max: 450, min: 5, label: 'El motivo' });
    await revert(ctx, id, { reason: `Reabierta para excluir: ${why}` });
    invoice = await getInvoice(ctx, h.uuid(id));
  }
  if (exclude && invoice.status === 'excluded') return { invoice: present(invoice) };
  if (!exclude && invoice.status !== 'excluded') return { invoice: present(invoice) };
  const reason = h.text(body.reason, { max: 500, min: exclude ? 5 : 0, label: 'El motivo' });
  const settings = await settingsStore.load(ctx.tenantId);
  const client = await getClient(ctx, invoice.client_id, { withSettings: false });
  const patch = { status: exclude ? 'excluded' : 'reviewed', version: invoice.version + 1, updated_at: new Date().toISOString(), updated_by: ctx.userId };
  if (!exclude) Object.assign(patch, stripComputed(await evaluate(ctx.tenantId, { ...invoice, status: 'reviewed' }, { client, settings })));
  const { data, error } = await supabase.from('nala_invoices').update(patch).eq('id', invoice.id).eq('tenant_id', ctx.tenantId).eq('version', invoice.version).select('*').maybeSingle();
  h.dbError(error);
  if (!data) h.fail(409, 'El comprobante cambió. Recargue.');
  await logEvent(ctx, { entity: 'invoice', entity_id: invoice.id, invoice_id: invoice.id, batch_id: invoice.batch_id, client_id: invoice.client_id, action: exclude ? 'excluded' : 'restored', reason });
  await refreshPeers(ctx.tenantId, data, await contextFor(ctx, settings));
  await supabase.rpc('nala_refresh_batch', { p_batch: invoice.batch_id });
  return { invoice: present(data) };
}

module.exports = { list, detail, lock, save, approve, approveBulk, revert, relocate, setExcluded, applyFilters };
