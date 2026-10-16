// Shared data access for NALA. Every query is filtered by the tenant taken
// from the authenticated profile.
const supabase = require('../supabase');
const { fail, dbError } = require('./http');
const money = require('./money');
const { validate, derive, dopAmount } = require('./validate');

async function logEvent(ctx, event) {
  const { error } = await supabase.from('nala_events').insert({
    tenant_id: ctx.tenantId, actor: ctx.userId || null, entity: event.entity, entity_id: event.entity_id ? String(event.entity_id) : null,
    batch_id: event.batch_id || null, invoice_id: event.invoice_id || null, client_id: event.client_id || null,
    action: event.action, reason: event.reason || null, details: event.details || {},
  });
  dbError(error);
}

async function getClient(ctx, clientId, { withSettings = true } = {}) {
  ctx.requireClient(clientId);
  const { data, error } = await supabase.from('direct_clients').select('id, legal_name, rnc, cedula, email, phone, status, source, created_at, updated_at')
    .eq('tenant_id', ctx.tenantId).eq('id', clientId).maybeSingle();
  dbError(error);
  if (!data) fail(404, 'Empresa cliente no encontrada.');
  if (withSettings) {
    const { data: s, error: e2 } = await supabase.from('nala_client_settings').select('settings').eq('tenant_id', ctx.tenantId).eq('client_id', clientId).maybeSingle();
    dbError(e2);
    data.settings = s?.settings || {};
  }
  return data;
}

async function getBatch(ctx, batchId) {
  const { data, error } = await supabase.from('nala_batches').select('*').eq('tenant_id', ctx.tenantId).eq('id', batchId).maybeSingle();
  dbError(error);
  if (!data) fail(404, 'Lote no encontrado.');
  ctx.requireClient(data.client_id);
  return data;
}

async function getInvoice(ctx, invoiceId) {
  const { data, error } = await supabase.from('nala_invoices').select('*').eq('tenant_id', ctx.tenantId).eq('id', invoiceId).maybeSingle();
  dbError(error);
  if (!data) fail(404, 'Comprobante no encontrado.');
  ctx.requireClient(data.client_id);
  return data;
}

// Other active invoices of the same client/format with the same NCF and
// counterpart are duplicates, wherever they were uploaded.
const ddmmyyyy = iso => (iso ? new Date(iso).toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Santo_Domingo' }) : '');
const EXPORT_STATUS = { generated: 'generado', submitted: 'enviado a la DGII', accepted: 'aceptado por la DGII', rejected: 'rechazado por la DGII' };

// Other active invoices of the same client/format with the same NCF and
// counterpart are duplicates, wherever they were uploaded. Each one says
// whether it was processed *before* this invoice (then this one is the
// repeated copy) and where it is, so the message can be specific.
async function findDuplicates(tenantId, invoice, computed) {
  const ncf = String(invoice.fields?.ncf || '').trim().toUpperCase();
  if (!ncf) return [];
  let query = supabase.from('nala_invoices').select('id, status, batch_id, document_id, page_from, period, counterpart_id, created_at, approved_at')
    .eq('tenant_id', tenantId).eq('client_id', invoice.client_id).eq('format', invoice.format).eq('ncf', ncf).neq('status', 'excluded');
  if (invoice.id) query = query.neq('id', invoice.id);
  const { data, error } = await query.limit(20);
  dbError(error);
  const counterpart = computed.counterpartId || null;
  const peers = (data || []).filter(d => !counterpart || !d.counterpart_id || d.counterpart_id === counterpart);
  if (!peers.length) return [];
  const [{ data: batches, error: be }, { data: lines, error: le }, { data: docs, error: de }] = await Promise.all([
    supabase.from('nala_batches').select('id, name').in('id', [...new Set(peers.map(p => p.batch_id))]),
    supabase.from('nala_export_lines').select('invoice_id, nala_exports!inner(file_name, status, tenant_id)').in('invoice_id', peers.map(p => p.id)).eq('nala_exports.tenant_id', tenantId),
    supabase.from('nala_documents').select('id, original_name').in('id', [...new Set(peers.map(p => p.document_id).filter(Boolean))]),
  ]);
  dbError(be); dbError(le); dbError(de);
  const batchName = Object.fromEntries((batches || []).map(b => [b.id, b.name]));
  const docName = Object.fromEntries((docs || []).map(x => [x.id, x.original_name]));
  const mine = invoice.created_at || null;
  return peers.map(d => {
    const exp = (lines || []).filter(l => l.invoice_id === d.id && l.nala_exports.status !== 'superseded')
      .sort((a, b) => ['accepted', 'submitted', 'generated', 'rejected'].indexOf(a.nala_exports.status) - ['accepted', 'submitted', 'generated', 'rejected'].indexOf(b.nala_exports.status))[0];
    const fileRef = d.document_id && docName[d.document_id] ? `, archivo "${docName[d.document_id]}"${d.page_from ? `, pág. ${d.page_from}` : ''}` : '';
    return {
      id: d.id, status: d.status, created_at: d.created_at,
      previous: !mine || d.created_at < mine || (d.created_at === mine && d.id < (invoice.id || '')),
      where: `el lote «${batchName[d.batch_id] || String(d.batch_id).slice(0, 8)}» (${d.period.slice(4)}/${d.period.slice(0, 4)})${fileRef}`,
      state: d.status === 'approved' ? `aprobada el ${ddmmyyyy(d.approved_at)}` : `en revisión desde el ${ddmmyyyy(d.created_at)}`,
      export: exp ? `${exp.nala_exports.file_name} (${EXPORT_STATUS[exp.nala_exports.status] || exp.nala_exports.status})` : null,
    };
  });
}

// Recomputes validation and the indexed columns of an invoice row (not saved).
async function evaluate(tenantId, invoice, { client, settings }) {
  const computed = derive(invoice.format, invoice.fields || {});
  const duplicates = await findDuplicates(tenantId, invoice, computed);
  const meta = invoice.extraction_meta || {};
  const result = validate({
    format: invoice.format, period: invoice.period, fields: invoice.fields || {}, client, settings: settings.rules, duplicates,
    extraction: { suggested: meta.suggested || [], lowConfidence: meta.lowConfidence || [], truncated: meta.truncated },
    correctedFields: invoice.corrected_fields || [],
  });
  const f = invoice.fields || {};
  return {
    issues: result.issues, critical_count: result.critical_count, warning_count: result.warning_count, rules_version: result.rules_version,
    ncf: f.ncf ? String(f.ncf).trim().toUpperCase() : null,
    counterpart_id: computed.counterpartId || null,
    counterpart_name: computed.counterpartName || null,
    invoice_date: /^\d{4}-\d{2}-\d{2}$/.test(f.fecha_comprobante || '') ? f.fecha_comprobante : null,
    currency: computed.currency,
    subtotal_dop: invoice.format === '606' ? sumDop(invoice.format, f, ['monto_servicios', 'monto_bienes']) : dopAmount(invoice.format, f, 'monto_facturado'),
    itbis_dop: dopAmount(invoice.format, f, 'itbis'),
    total_dop: totalDop(invoice.format, f),
    _computed: result.computed,
    _duplicates: duplicates,
  };
}

function sumDop(format, fields, keys) {
  const values = keys.map(k => dopAmount(format, fields, k));
  return money.sum(values);
}

function totalDop(format, fields) {
  const sub = format === '606' ? sumDop(format, fields, ['monto_servicios', 'monto_bienes']) : dopAmount(format, fields, 'monto_facturado');
  if (sub === null) return null;
  return money.sum([sub, dopAmount(format, fields, 'itbis'), dopAmount(format, fields, 'isc'), dopAmount(format, fields, 'otros_impuestos'), dopAmount(format, fields, 'propina')]);
}

const stripComputed = e => { const { _computed, _duplicates, ...rest } = e; return rest; };

// Refreshes the duplicate flag on invoices that share the NCF, after a change.
async function refreshPeers(tenantId, invoice, contextFor) {
  const ncf = String(invoice.ncf || invoice.fields?.ncf || '').trim().toUpperCase();
  if (!ncf) return;
  const { data, error } = await supabase.from('nala_invoices').select('*').eq('tenant_id', tenantId).eq('client_id', invoice.client_id)
    .eq('format', invoice.format).eq('ncf', ncf).neq('id', invoice.id).in('status', ['pending_review', 'reviewed']).limit(20);
  dbError(error);
  for (const peer of data || []) {
    const { client, settings } = await contextFor(peer.client_id);
    const evaluated = stripComputed(await evaluate(tenantId, peer, { client, settings }));
    const { error: e2 } = await supabase.from('nala_invoices').update(evaluated).eq('id', peer.id).eq('tenant_id', tenantId);
    dbError(e2);
  }
}

module.exports = { logEvent, getClient, getBatch, getInvoice, findDuplicates, evaluate, stripComputed, refreshPeers };
