// Auditoría fiscal: consulta (por lote o unificada), edición con control de
// versión y bloqueo, aprobación separada del guardado, reversión, reubicación
// y exclusión. Todo cambio queda en nala_events.
const supabase = require('../../supabase');
const settingsStore = require('../settings');
const rules = require('../rules');
const { logEvent, getClient, getBatch, getInvoice, evaluate, stripComputed, refreshPeers } = require('../store');
const h = require('../http');

const money = require('../money');
const b11 = require('../b11');
const ventas607 = require('../ventas607');
const crypto = require('crypto');

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

// Cambiar SOLO el nombre de la contraparte (proveedor en 606, cliente en 607) en cualquier estado,
// por si la lectura llegó mal. No cambia el estado (una aprobada sigue aprobada): el nombre no va en el TXT de la DGII.
async function renameCounterpart(ctx, id, body) {
  ctx.require('edit');
  const invoice = await getInvoice(ctx, h.uuid(id));
  if (Number(body.version) !== invoice.version) h.fail(409, 'El comprobante fue modificado por otra persona. Recargue para ver la versión actual.', { current_version: invoice.version });
  const key = invoice.format === '606' ? 'emisor_nombre' : 'receptor_nombre';
  const name = h.text(body.name, { max: 200, min: 2, label: 'El nombre' });
  const before = invoice.fields[key] ?? null;
  if (before === name) return { invoice: present(invoice), unchanged: true };
  const fields = { ...invoice.fields, [key]: name };
  const corrected = [...new Set([...(invoice.corrected_fields || []), key])];
  const { data, error } = await supabase.from('nala_invoices').update({ fields, corrected_fields: corrected, counterpart_name: name, version: invoice.version + 1, updated_at: new Date().toISOString(), updated_by: ctx.userId })
    .eq('id', invoice.id).eq('tenant_id', ctx.tenantId).eq('version', invoice.version).select('*').maybeSingle();
  h.dbError(error);
  if (!data) h.fail(409, 'El comprobante fue modificado por otra persona. Recargue para ver la versión actual.');
  await logEvent(ctx, { entity: 'invoice', entity_id: invoice.id, invoice_id: invoice.id, batch_id: invoice.batch_id, client_id: invoice.client_id, action: 'saved', details: { changes: { [key]: [before, name] }, confirmed: [key], version: data.version, only: 'counterpart_name' } });
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
  // Aprobar con advertencias ya no exige confirmar ni escribir un comentario: quedan registradas en approval_warnings.
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


// Comprobantes B11 (compras a informales) pegados desde Excel: crea comprobantes del lote
// 606 sin documento escaneado. Quedan «pendientes de revisión» como cualquier otro.
async function importB11(ctx, batchId, body) {
  ctx.require('upload');
  const batch = await getBatch(ctx, h.uuid(batchId));
  return importB11Into(ctx, batch, body);
}

// Desde «Exportar» o la lista: se sube el IR-17/B11 de una empresa y período sin elegir
// lote. Usa el lote 606 más reciente de ese período; si no hay, crea uno «IR-17 / B11».
async function importB11ForPeriod(ctx, body) {
  ctx.require('upload');
  const clientId = h.uuid(body.client_id, 'Empresa');
  const period = h.period(body.period, 'período');
  await getClient(ctx, clientId, { withSettings: false });
  const { data: found, error } = await supabase.from('nala_batches').select('*').eq('tenant_id', ctx.tenantId).eq('client_id', clientId).eq('format', '606').eq('period', period)
    .order('created_at', { ascending: false }).limit(1);
  h.dbError(error);
  let batch = found && found[0];
  if (!batch) {
    const ins = await supabase.from('nala_batches').insert({ tenant_id: ctx.tenantId, client_id: clientId, format: '606', period, name: `IR-17 / B11 ${period}`, created_by: ctx.userId }).select('*').single();
    h.dbError(ins.error);
    batch = ins.data;
    await logEvent(ctx, { entity: 'batch', entity_id: batch.id, batch_id: batch.id, client_id: clientId, action: 'batch_created', details: { format: '606', period, name: batch.name } });
  }
  const out = await importB11Into(ctx, batch, body);
  return { ...out, batch_id: batch.id };
}

async function importB11Into(ctx, batch, body) {
  if (batch.format !== '606') h.fail(409, 'Los comprobantes B11 (compras a personas informales) son del 606.');
  const client = await getClient(ctx, batch.client_id);
  const settings = await settingsStore.load(ctx.tenantId);
  let text = String(body.text || '');
  let sheet = null;
  if (body.file_base64) {
    const buf = Buffer.from(String(body.file_base64), 'base64');
    if (buf.length > 4 * 1024 * 1024) h.fail(413, 'El archivo es muy grande (máx. 4 MB).');
    const name = String(body.file_name || '').toLowerCase();
    try { text = /\.(csv|txt)$/.test(name) ? buf.toString('utf8') : await b11.workbookToText(buf, { period: batch.period }); sheet = /\.(csv|txt)$/.test(name) ? null : b11.workbookToText.lastSheet; }
    catch { h.fail(400, 'No pude leer el archivo. Suba un Excel (.xlsx), CSV o texto.'); }
  }
  const isrTipo = body.isr_tipo ? String(body.isr_tipo) : '03';
  if (!rules.CURRENT.tipoRetencionIsr[isrTipo]) h.fail(400, 'Tipo de retención de ISR inválido.');
  const parsed = b11.parse(text.slice(0, 400000), { retentionRate: body.retention_rate, itbis: body.itbis !== false, isrTipo, tipoBienes: '09', period: batch.period });
  if (!parsed.rows.length) h.fail(400, parsed.errors.length ? `No se pudo leer ninguna fila: ${parsed.errors.slice(0, 3).map(e => `línea ${e.line}: ${e.error}`).join('; ')}` : 'No encontré filas. Copie del Excel las columnas Fecha, NCF, Cédula, Nombre, Monto y Retención y péguelas.');
  if (parsed.rows.length > 500) h.fail(413, 'Máximo 500 filas por vez.');
  const clientRnc = String(client.rnc || client.cedula || '').replace(/\D/g, '');
  // NCF que el cliente ya tiene en el 606 (no se duplican al volver a subir el mismo Excel).
  const ncfs = parsed.rows.map(r => r.fields.ncf).filter(Boolean);
  const existing = new Set();
  if (ncfs.length) {
    const { data: have, error: he } = await supabase.from('nala_invoices').select('ncf').eq('tenant_id', ctx.tenantId).eq('client_id', batch.client_id).eq('format', '606').neq('status', 'excluded').in('ncf', ncfs);
    h.dbError(he);
    for (const x of have || []) existing.add(String(x.ncf).toUpperCase());
  }
  let created = 0; let withErrors = 0; const already = [];
  for (const r of parsed.rows) {
    if (r.fields.ncf && existing.has(r.fields.ncf)) { already.push(r.fields.ncf); continue; }
    const fields = { ...r.fields, receptor_id: clientRnc || null, receptor_nombre: client.legal_name || null };
    const now = new Date().toISOString();
    // Lo que viene del Excel del IR-17 ya fue revisado allá: entra APROBADO y con tipo de bien/servicio 09
    // (NALA solo lo prepara para enviarlo a la DGII).
    const row = { tenant_id: ctx.tenantId, client_id: batch.client_id, batch_id: batch.id, document_id: null, extraction_key: `b11:${crypto.randomUUID()}`,
      format: '606', period: batch.period, status: 'pending_review', fields: { ...fields, tipo_bienes_servicios: '09' }, extracted: {}, extraction_meta: { source: 'excel_b11' }, corrected_fields: [] };
    const evaluated = stripComputed(await evaluate(ctx.tenantId, row, { client, settings }));
    const warnings = evaluated.issues.filter(i => i.severity === 'warning');
    const approvedRow = { ...row, ...evaluated, issues: evaluated.issues.filter(i => i.severity !== 'warning'), warning_count: 0, status: 'approved', approved_by: ctx.userId, approved_at: now,
      approval_reason: 'Importado del Excel del IR-17 (ya revisado)', approval_warnings: warnings.map(w => ({ code: w.code, message: w.message, field: w.field })) };
    const { data, error } = await supabase.from('nala_invoices').insert(approvedRow).select('id').single();
    if (error?.code === '23505') { already.push(r.fields.ncf || `línea ${r.line}`); continue; }
    h.dbError(error);
    created++;
    if (evaluated.critical_count > 0) withErrors++;
    await logEvent(ctx, { entity: 'invoice', entity_id: data.id, invoice_id: data.id, batch_id: batch.id, client_id: batch.client_id, action: 'created_b11', details: { source: 'excel_b11', line: r.line, auto_approved: true } });
  }
  return { created, with_errors: withErrors, already: already.length, skipped: parsed.skipped, errors: parsed.errors, sheet };
}

// Ventas del 607 desde Excel (.xls/.xlsx/.csv) o pegadas: crea comprobantes del lote 607 sin documento
// escaneado, «pendientes de revisión» como cualquier otro. No duplica NCF que el cliente ya tiene.
async function importVentas607(ctx, batchId, body) {
  ctx.require('upload');
  const batch = await getBatch(ctx, h.uuid(batchId));
  return importVentas607Into(ctx, batch, body);
}

// Desde «Nuevo lote» (sin lote previo): usa el lote 607 más reciente de esa empresa y período; si no hay, crea uno «Ventas 607 AAAAMM».
async function importVentas607ForPeriod(ctx, body) {
  ctx.require('upload');
  const clientId = h.uuid(body.client_id, 'Empresa');
  const period = h.period(body.period, 'período');
  await getClient(ctx, clientId, { withSettings: false });
  const { data: found, error } = await supabase.from('nala_batches').select('*').eq('tenant_id', ctx.tenantId).eq('client_id', clientId).eq('format', '607').eq('period', period)
    .order('created_at', { ascending: false }).limit(1);
  h.dbError(error);
  let batch = found && found[0];
  if (!batch) {
    const ins = await supabase.from('nala_batches').insert({ tenant_id: ctx.tenantId, client_id: clientId, format: '607', period, name: `Ventas 607 ${period}`, created_by: ctx.userId }).select('*').single();
    h.dbError(ins.error);
    batch = ins.data;
    await logEvent(ctx, { entity: 'batch', entity_id: batch.id, batch_id: batch.id, client_id: clientId, action: 'batch_created', details: { format: '607', period, name: batch.name } });
  }
  const out = await importVentas607Into(ctx, batch, body);
  return { ...out, batch_id: batch.id };
}

async function importVentas607Into(ctx, batch, body) {
  if (batch.format !== '607') h.fail(409, 'Las ventas desde Excel son del 607.');
  const client = await getClient(ctx, batch.client_id);
  const settings = await settingsStore.load(ctx.tenantId);
  let text = String(body.text || ''); let sheet = null;
  if (body.file_base64) {
    const buf = Buffer.from(String(body.file_base64), 'base64');
    if (buf.length > 4 * 1024 * 1024) h.fail(413, 'El archivo es muy grande (máx. 4 MB).');
    const name = String(body.file_name || '').toLowerCase();
    try { if (/\.(csv|txt)$/.test(name)) text = buf.toString('utf8'); else { text = ventas607.workbookToText(buf); sheet = ventas607.workbookToText.lastSheet; } }
    catch { h.fail(400, 'No pude leer el archivo. Suba un Excel (.xls, .xlsx), CSV o texto.'); }
  }
  const tipoIngreso = String(body.tipo_ingreso || '01');
  if (!rules.CURRENT.tipoIngreso[tipoIngreso]) h.fail(400, 'Tipo de ingreso inválido.');
  const parsed = ventas607.parse(text.slice(0, 400000), { tipoIngreso, formaPago: body.forma_pago, period: batch.period });
  if (!parsed.rows.length) h.fail(400, parsed.errors.length ? `No se pudo leer ninguna fila: ${parsed.errors.slice(0, 3).map(e => `línea ${e.line}: ${e.error}`).join('; ')}` : 'No encontré filas de ventas.');
  if (parsed.rows.length > 1000) h.fail(413, 'Máximo 1000 filas por vez.');
  const clientRnc = String(client.rnc || client.cedula || '').replace(/\D/g, '');
  const ncfs = parsed.rows.map(r => r.fields.ncf);
  const existing = new Set();
  const { data: have, error: he } = await supabase.from('nala_invoices').select('ncf').eq('tenant_id', ctx.tenantId).eq('client_id', batch.client_id).eq('format', '607').neq('status', 'excluded').in('ncf', ncfs);
  h.dbError(he);
  for (const x of have || []) existing.add(String(x.ncf).toUpperCase());
  let created = 0; let withErrors = 0; const already = [];
  for (const r of parsed.rows) {
    if (existing.has(r.fields.ncf)) { already.push(r.fields.ncf); continue; }
    existing.add(r.fields.ncf);
    const fields = { ...r.fields, emisor_id: clientRnc || null, emisor_nombre: client.legal_name || null };
    const row = { tenant_id: ctx.tenantId, client_id: batch.client_id, batch_id: batch.id, document_id: null, extraction_key: `v607:${crypto.randomUUID()}`,
      format: '607', period: batch.period, status: 'pending_review', fields, extracted: {}, extraction_meta: { source: 'excel_607' }, corrected_fields: [] };
    const evaluated = stripComputed(await evaluate(ctx.tenantId, row, { client, settings }));
    const { data, error } = await supabase.from('nala_invoices').insert({ ...row, ...evaluated }).select('id').single();
    if (error?.code === '23505') { already.push(r.fields.ncf); continue; }
    h.dbError(error);
    created++;
    if (evaluated.critical_count > 0) withErrors++;
    await logEvent(ctx, { entity: 'invoice', entity_id: data.id, invoice_id: data.id, batch_id: batch.id, client_id: batch.client_id, action: 'created_excel_607', details: { source: 'excel_607', line: r.line } });
  }
  return { created, with_errors: withErrors, already: already.length, skipped: parsed.skipped, errors: parsed.errors, sheet };
}

// Cambia campos de un B11 importado del Excel sin sacarlo de «aprobado».
async function setApprovedField(ctx, inv, patch) {
  const invoice = await getInvoice(ctx, inv.id);
  const fields = { ...invoice.fields, ...patch };
  const settings = await settingsStore.load(ctx.tenantId);
  const client = await getClient(ctx, invoice.client_id, { withSettings: false });
  const evaluated = stripComputed(await evaluate(ctx.tenantId, { ...invoice, fields }, { client, settings }));
  const { data, error } = await supabase.from('nala_invoices').update({ fields, ...evaluated, issues: evaluated.issues.filter(i => i.severity !== 'warning'), warning_count: 0, version: invoice.version + 1, updated_at: new Date().toISOString(), updated_by: ctx.userId })
    .eq('id', invoice.id).eq('tenant_id', ctx.tenantId).eq('version', invoice.version).select('id').maybeSingle();
  h.dbError(error);
  if (!data) throw new Error('cambió');
  await logEvent(ctx, { entity: 'invoice', entity_id: invoice.id, invoice_id: invoice.id, batch_id: invoice.batch_id, client_id: invoice.client_id, action: 'saved', details: { changes: Object.fromEntries(Object.keys(patch).map(k => [k, [invoice.fields?.[k] ?? null, patch[k]]])), approved_b11: true } });
}

// Cambia de una vez el tipo de retención de ISR de los comprobantes de un lote 606.
// scope: 'b11' (NCF B11), 'with_isr' (los que tienen retención de renta) o 'all'.
async function setRetention(ctx, batchId, body) {
  ctx.require('edit');
  const batch = await getBatch(ctx, h.uuid(batchId));
  if (batch.format !== '606') h.fail(409, 'El tipo de retención de ISR es del 606.');
  const tipo = String(body.tipo || '');
  if (!rules.CURRENT.tipoRetencionIsr[tipo]) h.fail(400, 'Tipo de retención de ISR inválido.');
  const scope = ['b11', 'with_isr', 'all'].includes(body.scope) ? body.scope : 'b11';
  const { data, error } = await supabase.from('nala_invoices').select('id, status, version, fields, extraction_meta').eq('tenant_id', ctx.tenantId).eq('batch_id', batch.id).neq('status', 'excluded').limit(1000);
  h.dbError(error);
  const pick = (data || []).filter(i => {
    const f = i.fields || {};
    if (scope === 'b11') return String(f.ncf || '').toUpperCase().startsWith('B11');
    if (scope === 'with_isr') return Number(f.isr_retenido) > 0;
    return true;
  });
  // Los B11 que vienen del Excel del IR-17 entran aprobados: aquí sí se pueden cambiar sin revertir.
  const editable = i => ['pending_review', 'reviewed'].includes(i.status) || (i.status === 'approved' && i.extraction_meta?.source === 'excel_b11');
  const approved = pick.filter(i => i.status === 'approved' && !editable(i)).length;
  const todo = pick.filter(i => editable(i) && (i.fields?.isr_tipo_retencion ?? null) !== tipo);
  const same = pick.filter(editable).length - todo.length;
  if (todo.length > 400) h.fail(413, 'Demasiados comprobantes a la vez (máx. 400).');
  let changed = 0; const failed = [];
  for (let i = 0; i < todo.length; i += 8) {
    await Promise.all(todo.slice(i, i + 8).map(async inv => {
      try {
        if (inv.status === 'approved') await setApprovedField(ctx, inv, { isr_tipo_retencion: tipo });
        else await save(ctx, inv.id, { version: inv.version, fields: { isr_tipo_retencion: tipo } });
        changed++;
      } catch (e) { failed.push(inv.id); }
    }));
  }
  return { changed, same, approved_skipped: approved, failed: failed.length };
}

module.exports = { renameCounterpart, setRetention, importVentas607, importVentas607ForPeriod, importB11, importB11ForPeriod, list, detail, lock, save, approve, approveBulk, revert, relocate, setExcluded, applyFilters };
