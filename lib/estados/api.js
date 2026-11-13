// Estados Financieros — lógica de servidor. Todo se filtra por tenant (y por empresa asignada) en el
// servidor; el navegador nunca toca las tablas. Nada se borra: lo que se «elimina» queda inactivo, cada
// cambio crea una versión y cada acción queda en fin_events.
const supabase = require('../supabase');
const h = require('../nala/http');
const rules = require('./rules');
const imp = require('./import');
const { assess, accountSummary } = require('./completeness');
const excel = require('./excel');

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const BUCKET = process.env.NALA_STORAGE_BUCKET || 'nala-documents';
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

// ── Utilidades ────────────────────────────────────────────────────────────
function isoDate(value, label, { required = false } = {}) {
  const v = value === undefined || value === null || value === '' ? null : String(value).trim();
  if (!v) { if (required) h.fail(400, `${label} es obligatoria.`); return null; }
  if (!ISO.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z')) || new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) !== v) h.fail(400, `${label} no es una fecha válida (AAAA-MM-DD).`);
  return v;
}
const money = (value, label) => {
  const p = imp.parseAmount(value, { allowNegative: true });
  if (p.error) h.fail(400, `${label}: ${p.error}`);
  return p.value;
};
const modality = v => { if (!rules.MODALITIES[v]) h.fail(400, 'La modalidad debe ser proyectado, interino o anual.'); return v; };

async function loadConfig(ctx) {
  const { data, error } = await supabase.from('fin_config').select('config').eq('tenant_id', ctx.tenantId).maybeSingle();
  h.dbError(error);
  return rules.mergeConfig(data?.config);
}

async function logEvent(ctx, reportId, action, details = {}) {
  const { error } = await supabase.from('fin_events').insert({ tenant_id: ctx.tenantId, report_id: reportId || null, user_id: ctx.userId, action, details });
  if (error) console.error('[estados] evento no registrado', action, error.message);
}

async function usernames(ids) {
  const out = {};
  await Promise.all([...new Set(ids.filter(Boolean))].map(async id => {
    try { const { data } = await supabase.auth.admin.getUserById(id); if (data?.user) out[id] = String(data.user.email || '').replace('@direct.local', ''); } catch { /* sin nombre */ }
  }));
  return out;
}

async function getReport(ctx, id) {
  const { data, error } = await supabase.from('fin_reports').select('*').eq('tenant_id', ctx.tenantId).eq('id', h.uuid(id, 'Informe')).maybeSingle();
  h.dbError(error);
  if (!data) h.fail(404, 'Informe no encontrado.');
  ctx.requireClient(data.client_id);
  return data;
}
async function getClient(ctx, id) {
  const { data, error } = await supabase.from('direct_clients').select('id, legal_name, rnc, cedula, status').eq('tenant_id', ctx.tenantId).eq('id', h.uuid(id, 'Empresa')).maybeSingle();
  h.dbError(error);
  if (!data) h.fail(404, 'Empresa no encontrada.');
  ctx.requireClient(data.id);
  return data;
}

function assertEditable(ctx, report) {
  ctx.require(rules.MODALITIES[report.modality].edit);
  if (rules.LOCKED.includes(report.status)) h.fail(409, 'El informe está aprobado o cerrado: reábralo (con su motivo) para modificarlo.');
}

async function loadData(report) {
  const [en, as, ad, im] = await Promise.all([
    fetchAll(supabase.from('fin_entries').select('id, row_no, entry_date, account_code, account_name, concept, reference, debit, credit, opening_balance, closing_balance, classification, import_id').eq('report_id', report.id).eq('active', true).order('entry_date').order('row_no'), 50000),
    supabase.from('fin_assumptions').select('*').eq('report_id', report.id).eq('active', true).order('created_at'),
    supabase.from('fin_adjustments').select('*').eq('report_id', report.id).eq('active', true).order('adj_date'),
    supabase.from('fin_imports').select('*').eq('report_id', report.id).order('created_at', { ascending: false }),
  ]);
  h.dbError(as.error); h.dbError(ad.error); h.dbError(im.error);
  const num = rows => rows.map(r => ({ ...r, debit: r.debit === undefined ? undefined : Number(r.debit), credit: r.credit === undefined ? undefined : Number(r.credit),
    opening_balance: r.opening_balance == null ? null : Number(r.opening_balance), closing_balance: r.closing_balance == null ? null : Number(r.closing_balance) }));
  return { entries: num(en), assumptions: (as.data || []).map(a => ({ ...a, amount: a.amount == null ? null : Number(a.amount) })), adjustments: num(ad.data || []), imports: im.data || [] };
}
// Lee por páginas (PostgREST limita las respuestas).
async function fetchAll(query, cap = 50000) {
  const out = [];
  for (let from = 0; from < cap; from += 1000) {
    const { data, error } = await query.range(from, from + 999);
    h.dbError(error);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const SNAP_FIELDS = ['title', 'scenario', 'currency', 'prepared_on', 'period_start', 'period_end', 'fiscal_year', 'fiscal_period', 'status', 'notes', 'documents', 'prepared_by', 'reviewed_by', 'approved_by', 'closed_by'];
// Reclama el siguiente número de versión (control de concurrencia) y guarda la instantánea.
async function bump(ctx, report, changeType, note, patch = {}) {
  const next = report.version + 1;
  const row = { ...patch, version: next, updated_by: ctx.userId, updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from('fin_reports').update(row).eq('id', report.id).eq('tenant_id', ctx.tenantId).eq('version', report.version).select('*').maybeSingle();
  h.dbError(error);
  if (!data) h.fail(409, 'El informe cambió mientras lo editaba. Recargue e intente de nuevo.');
  await snapshot(ctx, data, changeType, note);
  return data;
}
async function snapshot(ctx, report, changeType, note) {
  const [as, en, ad] = await Promise.all([
    supabase.from('fin_assumptions').select('kind, name, description, period, account_code, amount, value_text, unit, source, pending').eq('report_id', report.id).eq('active', true),
    supabase.from('fin_entries').select('id', { count: 'exact', head: true }).eq('report_id', report.id).eq('active', true),
    supabase.from('fin_adjustments').select('id', { count: 'exact', head: true }).eq('report_id', report.id).eq('active', true),
  ]);
  const header = Object.fromEntries(SNAP_FIELDS.map(k => [k, report[k] ?? null]));
  const { error } = await supabase.from('fin_versions').insert({ tenant_id: ctx.tenantId, report_id: report.id, version: report.version, change_type: changeType, note: note || null,
    snapshot: { header, assumptions: as.data || [], entries_count: en.count ?? null, adjustments_count: ad.count ?? null }, changed_by: ctx.userId });
  if (error) console.error('[estados] versión no guardada', error.message);
}

// ── Sesión y configuración ────────────────────────────────────────────────
async function me(ctx) {
  const cfg = await loadConfig(ctx);
  return {
    user_id: ctx.userId, username: ctx.username, is_admin: ctx.isAdmin, role: ctx.role, role_label: ctx.roleLabel, permissions: [...ctx.perms],
    permission_labels: rules.PERMISSION_LABELS, config: cfg, state_labels: cfg.labels,
    modalities: Object.fromEntries(Object.entries(rules.MODALITIES).map(([k, v]) => [k, { ...v, fields: rules.FIELDS[k], pending_from_accounting: rules.PENDING_FROM_ACCOUNTING[k], states: cfg.states[k], initial_state: rules.INITIAL_STATE[k] }])),
    locked_states: rules.LOCKED,
  };
}
async function getConfig(ctx) { ctx.require('view'); return { config: await loadConfig(ctx) }; }
async function putConfig(ctx, body) {
  ctx.require('templates_manage');
  const next = rules.mergeConfig(body.config || body);
  const prev = await loadConfig(ctx);
  const { error } = await supabase.from('fin_config').upsert({ tenant_id: ctx.tenantId, config: next, updated_by: ctx.userId, updated_at: new Date().toISOString() }, { onConflict: 'tenant_id' });
  h.dbError(error);
  await logEvent(ctx, null, 'config_updated', { before: prev, after: next });
  return { config: next };
}

async function listClients(ctx) {
  ctx.require('view');
  let query = supabase.from('direct_clients').select('id, legal_name, rnc, cedula, status').eq('tenant_id', ctx.tenantId).order('legal_name').limit(2000);
  if (ctx.scopeArray()) query = query.in('id', ctx.scopeArray().length ? ctx.scopeArray() : ['00000000-0000-0000-0000-000000000000']);
  const { data, error } = await query;
  h.dbError(error);
  return { clients: data || [] };
}

// ── Informes ──────────────────────────────────────────────────────────────
async function listReports(ctx, q) {
  ctx.require('view');
  let query = supabase.from('fin_reports').select('id, client_id, modality, title, scenario, currency, prepared_on, period_start, period_end, fiscal_year, fiscal_period, status, version, prepared_by, reviewed_by, approved_by, created_at, updated_at').eq('tenant_id', ctx.tenantId).order('updated_at', { ascending: false }).limit(500);
  if (q.modality) query = query.eq('modality', modality(q.modality));
  if (q.client_id) { ctx.requireClient(h.uuid(q.client_id, 'Empresa')); query = query.eq('client_id', q.client_id); }
  else if (ctx.scopeArray()) query = query.in('client_id', ctx.scopeArray().length ? ctx.scopeArray() : ['00000000-0000-0000-0000-000000000000']);
  if (q.status) query = query.eq('status', String(q.status).slice(0, 40));
  const { data, error } = await query;
  h.dbError(error);
  const { clients } = await listClients(ctx);
  const names = Object.fromEntries(clients.map(c => [c.id, c.legal_name]));
  const people = await usernames((data || []).flatMap(r => [r.prepared_by]));
  return { reports: (data || []).map(r => ({ ...r, client_name: names[r.client_id] || '—', prepared_by_name: people[r.prepared_by] || null })) };
}

async function createReport(ctx, body) {
  const mod = modality(body.modality);
  ctx.require(rules.MODALITIES[mod].edit);
  const client = await getClient(ctx, body.client_id);
  const cfg = await loadConfig(ctx);
  const title = h.text(body.title, { max: 160, min: 1, label: 'El nombre del informe' });
  const currency = String(body.currency || 'DOP').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) h.fail(400, 'La moneda debe ser un código de 3 letras (DOP, USD…).');
  const period_start = isoDate(body.period_start, 'La fecha de inicio', { required: true });
  const period_end = isoDate(body.period_end, mod === 'proyectado' ? 'La fecha final del período' : 'La fecha de corte', { required: true });
  if (period_end < period_start) h.fail(400, 'La fecha final no puede ser anterior a la de inicio.');
  const row = {
    tenant_id: ctx.tenantId, client_id: client.id, modality: mod, title, currency, period_start, period_end,
    prepared_on: isoDate(body.prepared_on, 'La fecha de preparación') || new Date().toISOString().slice(0, 10),
    status: rules.INITIAL_STATE[mod], prepared_by: ctx.userId, created_by: ctx.userId, updated_by: ctx.userId,
    documents: cfg.documents[mod].map(d => ({ key: d.key, label: d.label, required: d.required, status: 'pendiente', note: '' })),
    notes: h.text(body.notes, { max: 4000 }) || null,
  };
  if (mod === 'proyectado') row.scenario = h.text(body.scenario, { max: 120, min: 1, label: 'El nombre del escenario' });
  if (mod === 'anual') {
    row.fiscal_year = Number(body.fiscal_year);
    if (!Number.isInteger(row.fiscal_year) || row.fiscal_year < 2000 || row.fiscal_year > 2100) h.fail(400, 'Indique el año fiscal (por ejemplo 2026).');
    row.fiscal_period = h.text(body.fiscal_period, { max: 60 }) || null;
  }
  if (mod === 'interino') row.fiscal_period = h.text(body.fiscal_period, { max: 60, min: 1, label: 'El período fiscal al que pertenece' });
  const { data, error } = await supabase.from('fin_reports').insert(row).select('*').single();
  h.dbError(error);
  await snapshot(ctx, data, 'creado', 'Informe creado');
  await logEvent(ctx, data.id, 'report_created', { modality: mod, client_id: client.id, title });
  return { report: data };
}

function transitionsAllowed(ctx, report, cfg) {
  return rules.transitionsFor(report.modality, cfg.states[report.modality]).filter(t => t.from === report.status)
    .filter(t => ctx.can(t.perm === 'edit' ? rules.MODALITIES[report.modality].edit : t.perm))
    .map(t => ({ to: t.to, label: cfg.labels[t.to] || t.to, reason: !!t.reason, reopen: !!t.reopen, needs_complete: rules.NEEDS_COMPLETE.includes(t.to) }));
}

async function reportDetail(ctx, id) {
  ctx.require('view');
  const report = await getReport(ctx, id);
  const cfg = await loadConfig(ctx);
  const client = await getClient(ctx, report.client_id);
  const data = await loadData(report);
  const completeness = assess(report, data, cfg);
  const [versions, events] = await Promise.all([
    supabase.from('fin_versions').select('version, change_type, note, changed_by, changed_at').eq('report_id', report.id).order('version', { ascending: false }).limit(200),
    supabase.from('fin_events').select('action, details, user_id, created_at').eq('report_id', report.id).order('created_at', { ascending: false }).limit(200),
  ]);
  h.dbError(versions.error); h.dbError(events.error);
  const people = await usernames([report.prepared_by, report.reviewed_by, report.approved_by, report.closed_by, report.created_by, ...(versions.data || []).map(v => v.changed_by), ...(events.data || []).map(e => e.user_id), ...data.imports.map(i => i.created_by)]);
  const dates = data.entries.map(e => e.entry_date).sort();
  const debit = r2(data.entries.reduce((s, e) => s + e.debit, 0)); const credit = r2(data.entries.reduce((s, e) => s + e.credit, 0));
  const origin = [
    ...data.imports.filter(i => i.status === 'applied').map(i => ({ type: 'archivo', file_name: i.file_name, sha256: i.sha256, rows: i.row_count, by: people[i.created_by] || null, at: i.created_at, stored: !!i.storage_path })),
    ...(data.adjustments.length ? [{ type: 'manual', description: `${data.adjustments.length} ajuste(s) registrados a mano` }] : []),
  ];
  return {
    report: { ...report, client_name: client.legal_name, client_rnc: client.rnc || client.cedula || null },
    people, status_label: cfg.labels[report.status] || report.status, locked: rules.LOCKED.includes(report.status),
    can_edit: ctx.can(rules.MODALITIES[report.modality].edit) && !rules.LOCKED.includes(report.status),
    transitions: transitionsAllowed(ctx, report, cfg),
    data_through: dates.length ? dates[dates.length - 1] : null, data_from: dates.length ? dates[0] : null,
    totals: { entries: data.entries.length, debit, credit },
    accounts: accountSummary(data.entries, data.adjustments).slice(0, 1000),
    assumptions: data.assumptions, adjustments: data.adjustments, imports: data.imports.map(i => ({ ...i, created_by_name: people[i.created_by] || null })),
    origin, completeness, versions: (versions.data || []).map(v => ({ ...v, changed_by_name: people[v.changed_by] || null })),
    events: (events.data || []).map(e => ({ ...e, user_name: people[e.user_id] || null })),
    config: { compare_enabled: cfg.compare_enabled, balance_rule: cfg.balance_rule, balance_rule_confirmed: cfg.balance_rule_confirmed, legalizacion: cfg.legalizacion },
    generated_at: new Date().toISOString(),
  };
}

async function updateReport(ctx, id, body) {
  const report = await getReport(ctx, id);
  assertEditable(ctx, report);
  const patch = {}; const changes = {};
  const set = (k, v) => { if (v !== undefined && String(v ?? '') !== String(report[k] ?? '')) { patch[k] = v; changes[k] = [report[k] ?? null, v]; } };
  if (body.title !== undefined) set('title', h.text(body.title, { max: 160, min: 1, label: 'El nombre del informe' }));
  if (body.scenario !== undefined && report.modality === 'proyectado') set('scenario', h.text(body.scenario, { max: 120, min: 1, label: 'El nombre del escenario' }));
  if (body.currency !== undefined) {
    const c = String(body.currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) h.fail(400, 'La moneda debe ser un código de 3 letras.');
    if (c !== report.currency) {
      const data = await loadData(report);
      if (data.entries.length) h.fail(409, 'No se puede cambiar la moneda: ya hay registros cargados en la moneda actual.');
    }
    set('currency', c);
  }
  if (body.prepared_on !== undefined) set('prepared_on', isoDate(body.prepared_on, 'La fecha de preparación', { required: true }));
  if (body.period_start !== undefined) set('period_start', isoDate(body.period_start, 'La fecha de inicio', { required: true }));
  if (body.period_end !== undefined) set('period_end', isoDate(body.period_end, 'La fecha final', { required: true }));
  if (body.fiscal_year !== undefined && report.modality === 'anual') { const y = Number(body.fiscal_year); if (!Number.isInteger(y) || y < 2000 || y > 2100) h.fail(400, 'Año fiscal inválido.'); set('fiscal_year', y); }
  if (body.fiscal_period !== undefined) set('fiscal_period', h.text(body.fiscal_period, { max: 60 }) || null);
  if (body.notes !== undefined) set('notes', h.text(body.notes, { max: 4000 }) || null);
  const s = patch.period_start || report.period_start; const e = patch.period_end || report.period_end;
  if (s && e && e < s) h.fail(400, 'La fecha final no puede ser anterior a la de inicio.');
  if (!Object.keys(patch).length) return { report };
  const next = await bump(ctx, report, 'editado', `Cambios: ${Object.keys(changes).join(', ')}`, patch);
  await logEvent(ctx, report.id, 'report_updated', { changes });
  return { report: next };
}

async function transition(ctx, id, body) {
  const report = await getReport(ctx, id);
  const cfg = await loadConfig(ctx);
  const to = String(body.to || '');
  const t = transitionsAllowed(ctx, report, cfg).find(x => x.to === to);
  if (!t) {
    const exists = rules.transitionsFor(report.modality, cfg.states[report.modality]).some(x => x.from === report.status && x.to === to);
    h.fail(exists ? 403 : 409, exists ? 'No tiene permiso para este cambio de estado.' : `No se puede pasar de «${cfg.labels[report.status] || report.status}» a «${cfg.labels[to] || to}».`);
  }
  const note = h.text(body.note, { max: 1000 });
  if (t.reason && note.length < 5) h.fail(400, 'Indique el motivo (mín. 5 caracteres).');
  const data = await loadData(report);
  const completeness = assess(report, data, cfg);
  if (t.needs_complete && completeness.blocking) h.fail(422, 'El informe tiene pendientes y no puede pasar a este estado.', { pending: completeness.items.filter(i => i.severity === 'blocking') });
  const now = new Date().toISOString();
  const patch = { status: to };
  if (to === 'observado') Object.assign(patch, { reviewed_by: ctx.userId, reviewed_at: now });
  if (to === 'aprobado') Object.assign(patch, { approved_by: ctx.userId, approved_at: now });
  if (to === 'cerrado' && report.status === 'aprobado') Object.assign(patch, { closed_by: ctx.userId, closed_at: now });
  if (t.reopen) Object.assign(patch, { approved_by: null, approved_at: null, closed_by: null, closed_at: null });
  const next = await bump(ctx, report, `estado: ${report.status} → ${to}`, note || null, patch);
  await logEvent(ctx, report.id, t.reopen ? 'report_reopened' : `state_${to}`, { from: report.status, to, note: note || null, pending_warnings: completeness.warnings,
    previous: t.reopen ? { approved_by: report.approved_by, approved_at: report.approved_at, closed_by: report.closed_by, closed_at: report.closed_at } : undefined });
  return { report: next };
}

async function updateDocuments(ctx, id, body) {
  const report = await getReport(ctx, id);
  assertEditable(ctx, report);
  const cfg = await loadConfig(ctx);
  const incoming = Array.isArray(body.documents) ? body.documents : [];
  const byKey = Object.fromEntries(incoming.map(d => [String(d.key), d]));
  const docs = (report.documents || []).map(d => ({ ...d, status: ['pendiente', 'incluido'].includes(byKey[d.key]?.status) ? byKey[d.key].status : d.status, note: byKey[d.key]?.note !== undefined ? h.text(byKey[d.key].note, { max: 300 }) : d.note }));
  for (const d of cfg.documents[report.modality]) if (!docs.some(x => x.key === d.key)) docs.push({ key: d.key, label: d.label, required: d.required, status: 'pendiente', note: '' });
  const next = await bump(ctx, report, 'documentos', 'Documentos del informe actualizados', { documents: docs });
  await logEvent(ctx, report.id, 'documents_updated', { documents: docs.map(d => ({ key: d.key, status: d.status })) });
  return { report: next };
}

// ── Supuestos y valores estimados (proyectados) ───────────────────────────
function assumptionRow(body) {
  const kind = body.kind === 'supuesto' || body.kind === 'valor_estimado' ? body.kind : h.fail(400, 'Elija si es un supuesto o un valor estimado.');
  const pending = body.pending === true;
  const amount = body.amount === '' || body.amount === undefined || body.amount === null ? null : money(body.amount, 'Valor');
  const row = { kind, name: h.text(body.name, { max: 200, min: 1, label: 'El concepto' }), description: h.text(body.description, { max: 1000 }) || null,
    period: h.text(body.period, { max: 40 }) || null, account_code: h.text(body.account_code, { max: 60 }) || null, amount, value_text: h.text(body.value_text, { max: 300 }) || null,
    unit: h.text(body.unit, { max: 40 }) || null, source: h.text(body.source, { max: 300 }) || null, pending };
  if (kind === 'valor_estimado' && !pending) {
    if (row.amount === null) h.fail(400, 'Un valor estimado necesita su cifra (o márquelo como pendiente).');
    if (!row.description) h.fail(400, 'Un valor estimado necesita su descripción (o márquelo como pendiente).');
  }
  return row;
}
async function createAssumption(ctx, reportId, body) {
  const report = await getReport(ctx, reportId);
  if (report.modality !== 'proyectado') h.fail(409, 'Los supuestos son de los informes proyectados.');
  assertEditable(ctx, report);
  const row = assumptionRow(body);
  const { data, error } = await supabase.from('fin_assumptions').insert({ ...row, tenant_id: ctx.tenantId, report_id: report.id, created_by: ctx.userId, updated_by: ctx.userId }).select('*').single();
  h.dbError(error);
  await bump(ctx, report, 'supuesto agregado', row.name);
  await logEvent(ctx, report.id, 'assumption_created', { id: data.id, name: row.name, kind: row.kind });
  return { assumption: data };
}
async function getAssumption(ctx, id) {
  const { data, error } = await supabase.from('fin_assumptions').select('*').eq('tenant_id', ctx.tenantId).eq('id', h.uuid(id, 'Supuesto')).eq('active', true).maybeSingle();
  h.dbError(error);
  if (!data) h.fail(404, 'Supuesto no encontrado.');
  return data;
}
async function updateAssumption(ctx, id, body) {
  const old = await getAssumption(ctx, id);
  const report = await getReport(ctx, old.report_id);
  assertEditable(ctx, report);
  const row = assumptionRow({ ...old, amount: old.amount, ...body });
  const { data, error } = await supabase.from('fin_assumptions').update({ ...row, updated_by: ctx.userId, updated_at: new Date().toISOString() }).eq('id', old.id).select('*').single();
  h.dbError(error);
  await bump(ctx, report, 'supuesto editado', row.name);
  await logEvent(ctx, report.id, 'assumption_updated', { id: old.id, before: { amount: old.amount, description: old.description, pending: old.pending, name: old.name }, after: { amount: data.amount, description: data.description, pending: data.pending, name: data.name } });
  return { assumption: data };
}
async function deleteAssumption(ctx, id) {
  const old = await getAssumption(ctx, id);
  const report = await getReport(ctx, old.report_id);
  assertEditable(ctx, report);
  const { error } = await supabase.from('fin_assumptions').update({ active: false, updated_by: ctx.userId, updated_at: new Date().toISOString() }).eq('id', old.id);
  h.dbError(error);
  await bump(ctx, report, 'supuesto retirado', old.name);
  await logEvent(ctx, report.id, 'assumption_removed', { id: old.id, name: old.name, amount: old.amount });
  return { ok: true };
}

// ── Ajustes (interinos y del año) ─────────────────────────────────────────
async function createAdjustment(ctx, reportId, body) {
  const report = await getReport(ctx, reportId);
  if (report.modality === 'proyectado') h.fail(409, 'Los ajustes son de los informes interinos y del año.');
  assertEditable(ctx, report);
  const kind = body.kind === 'cierre' ? 'cierre' : 'ajuste';
  if (kind === 'cierre' && report.modality !== 'anual') h.fail(409, 'Los asientos de cierre son del informe del año.');
  const debit = body.debit === '' || body.debit == null ? 0 : money(body.debit, 'Débito'); const credit = body.credit === '' || body.credit == null ? 0 : money(body.credit, 'Crédito');
  if (debit < 0 || credit < 0) h.fail(400, 'Los importes no pueden ser negativos.');
  if (!debit && !credit) h.fail(400, 'Indique el débito o el crédito.');
  if (debit && credit) h.fail(400, 'Registre el débito y el crédito en líneas separadas.');
  const adj_date = isoDate(body.adj_date, 'La fecha', { required: true });
  if ((report.period_start && adj_date < report.period_start) || (report.period_end && adj_date > report.period_end)) h.fail(400, 'La fecha queda fuera del período del informe.');
  const row = { tenant_id: ctx.tenantId, report_id: report.id, kind, adj_date, reference: h.text(body.reference, { max: 80 }) || null, concept: h.text(body.concept, { max: 500, min: 1, label: 'El concepto' }),
    account_code: h.text(body.account_code, { max: 60, min: 1, label: 'El código de cuenta' }), account_name: h.text(body.account_name, { max: 200 }) || null, debit, credit, created_by: ctx.userId };
  const { data, error } = await supabase.from('fin_adjustments').insert(row).select('*').single();
  h.dbError(error);
  await bump(ctx, report, kind === 'cierre' ? 'asiento de cierre' : 'ajuste', row.concept);
  await logEvent(ctx, report.id, 'adjustment_created', { id: data.id, kind, account_code: row.account_code, debit, credit, reference: row.reference });
  return { adjustment: data };
}
async function deleteAdjustment(ctx, id) {
  const { data: adj, error } = await supabase.from('fin_adjustments').select('*').eq('tenant_id', ctx.tenantId).eq('id', h.uuid(id, 'Ajuste')).eq('active', true).maybeSingle();
  h.dbError(error);
  if (!adj) h.fail(404, 'Ajuste no encontrado.');
  const report = await getReport(ctx, adj.report_id);
  assertEditable(ctx, report);
  const { error: e2 } = await supabase.from('fin_adjustments').update({ active: false }).eq('id', adj.id);
  h.dbError(e2);
  await bump(ctx, report, 'ajuste retirado', adj.concept);
  await logEvent(ctx, report.id, 'adjustment_removed', { id: adj.id, kind: adj.kind, account_code: adj.account_code, debit: adj.debit, credit: adj.credit });
  return { ok: true };
}

// ── Importación ───────────────────────────────────────────────────────────
function readUpload(body) {
  if (!body.file_base64) h.fail(400, 'Suba el archivo (Excel .xlsx o CSV).');
  const buffer = Buffer.from(String(body.file_base64), 'base64');
  if (!buffer.length) h.fail(400, 'El archivo está vacío.');
  if (buffer.length > 3.2 * 1024 * 1024) h.fail(413, 'El archivo es muy grande (máx. 3 MB).');
  return { buffer, name: String(body.file_name || 'archivo').slice(0, 240) };
}
async function parseUpload(ctx, report, body) {
  const { buffer, name } = readUpload(body);
  let table;
  try { table = await imp.readTable(buffer, name, { sheet: body.sheet }); } catch (e) { h.fail(400, e.code === 'format' ? e.message : 'No pude leer el archivo. Suba un Excel .xlsx o un CSV válido.'); }
  if (!table.rows.length) h.fail(400, 'El archivo no tiene datos.');
  const headerIdx = body.header_row ? Math.max(0, Number(body.header_row) - 1) : imp.findHeaderRow(table.rows, report.modality);
  const headers = (table.rows[headerIdx] || []).map(c => String(c || ''));
  const sig = imp.headersSig(headers);
  let saved = null;
  if (!body.mapping) {
    const { data } = await supabase.from('fin_mappings').select('mapping').eq('tenant_id', ctx.tenantId).eq('modality', report.modality).eq('headers_sig', sig).maybeSingle();
    saved = data?.mapping || null;
  }
  const mapping = imp.cleanMapping(body.mapping || saved || imp.suggestMapping(headers, report.modality), headers, report.modality);
  const client = await getClient(ctx, report.client_id);
  let existingKeys = null;
  if (report.modality !== 'proyectado') {
    const existing = await fetchAll(supabase.from('fin_entries').select('entry_date, account_code, reference, concept, debit, credit').eq('report_id', report.id).eq('active', true), 50000);
    existingKeys = new Set(existing.map(e => [e.entry_date, e.account_code, e.reference || '', e.concept || '', Number(e.debit), Number(e.credit)].join('|')));
  }
  const cfg = await loadConfig(ctx);
  const result = imp.validate(table.rows, headerIdx, mapping, { ...report, client_rnc: client.rnc || client.cedula }, { existingKeys, allowDuplicates: body.allow_duplicates === true });
  return { buffer, name, table, headerIdx, headers, sig, mapping, saved: !!saved, result, cfg };
}

async function importPreview(ctx, reportId, body) {
  const report = await getReport(ctx, reportId);
  assertEditable(ctx, report);
  const p = await parseUpload(ctx, report, body);
  const out = {
    file: { name: p.name, size: p.buffer.length, sha256: imp.sha256(p.buffer) }, sheet: p.table.sheet, sheets: p.table.sheets, header_row: p.headerIdx + 1, headers: p.headers,
    preview: p.table.rows.slice(p.headerIdx + 1, p.headerIdx + 16), fields: rules.FIELDS[report.modality], mapping: p.mapping, saved_mapping_used: p.saved,
    valid_rows: p.result.rows.length, total_rows: Math.max(0, p.table.rows.length - p.headerIdx - 1), errors: p.result.errors, error_count: p.result.total, can_confirm: p.result.total === 0 && p.result.rows.length > 0,
  };
  if (report.modality !== 'proyectado' && p.result.rows.length) {
    out.totals = { debit: r2(p.result.rows.reduce((s, r) => s + r.debit, 0)), credit: r2(p.result.rows.reduce((s, r) => s + r.credit, 0)) };
    out.balance = imp.balanceCheck(p.result.rows, { rule: p.cfg.balance_rule, tolerance: p.cfg.balance_tolerance });
    out.balance_note = 'El cuadre se revisa sobre todo el informe después de cargar: esto es solo el cuadre del archivo.';
  }
  return out;
}

async function importConfirm(ctx, reportId, body) {
  const report = await getReport(ctx, reportId);
  assertEditable(ctx, report);
  const p = await parseUpload(ctx, report, body);
  if (p.result.total > 0) h.fail(422, `El archivo tiene ${p.result.total} error(es); corríjalos y vuelva a cargarlo. No se guardó nada.`, { errors: p.result.errors, error_count: p.result.total });
  if (!p.result.rows.length) h.fail(400, 'El archivo no tiene filas para guardar.');
  const kind = rules.MODALITIES[report.modality].kind;
  const sha = imp.sha256(p.buffer);
  const { data: imported, error } = await supabase.from('fin_imports').insert({ tenant_id: ctx.tenantId, report_id: report.id, kind, file_name: p.name, file_size: p.buffer.length, sha256: sha,
    sheet: p.table.sheet, mapping: p.mapping, row_count: p.result.rows.length, created_by: ctx.userId }).select('*').single();
  h.dbError(error);
  const table = kind === 'entries' ? 'fin_entries' : 'fin_assumptions';
  try {
    const rows = p.result.rows.map(r => (kind === 'entries'
      ? { tenant_id: ctx.tenantId, report_id: report.id, import_id: imported.id, row_no: r.row_no, entry_date: r.entry_date, account_code: r.account_code, account_name: r.account_name, concept: r.concept, reference: r.reference,
        debit: r.debit, credit: r.credit, opening_balance: r.opening_balance, closing_balance: r.closing_balance, classification: r.classification }
      : { tenant_id: ctx.tenantId, report_id: report.id, import_id: imported.id, row_no: r.row_no, kind: r.kind, name: r.name, description: r.description, period: r.period, account_code: r.account_code,
        amount: r.amount, unit: r.unit, source: r.source, pending: r.pending, created_by: ctx.userId, updated_by: ctx.userId }));
    for (let i = 0; i < rows.length; i += 500) { const { error: ie } = await supabase.from(table).insert(rows.slice(i, i + 500)); h.dbError(ie); }
  } catch (e) {
    // Carga a medias: se deshace lo recién insertado (son filas nuevas de esta importación, no historial).
    await supabase.from(table).delete().eq('import_id', imported.id);
    await supabase.from('fin_imports').delete().eq('id', imported.id);
    throw e;
  }
  // Archivo fuente: se guarda si el almacenamiento responde; si no, queda su huella y el registro de la importación.
  let stored = false;
  try {
    const path = `estados/${ctx.tenantId}/${report.id}/${imported.id}-${p.name.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
    const { error: ue } = await supabase.storage.from(BUCKET).upload(path, p.buffer, { contentType: 'application/octet-stream', upsert: false });
    if (!ue) { await supabase.from('fin_imports').update({ storage_path: path }).eq('id', imported.id); stored = true; }
  } catch { /* se informa abajo */ }
  if (body.save_mapping === true) await supabase.from('fin_mappings').upsert({ tenant_id: ctx.tenantId, modality: report.modality, headers_sig: p.sig, mapping: p.mapping, created_by: ctx.userId, updated_at: new Date().toISOString() }, { onConflict: 'tenant_id,modality,headers_sig' });
  const next = await bump(ctx, report, 'importación', `${p.name}: ${p.result.rows.length} fila(s)`);
  await logEvent(ctx, report.id, 'import_applied', { import_id: imported.id, file_name: p.name, sha256: sha, rows: p.result.rows.length, kind, mapping_saved: body.save_mapping === true, source_stored: stored });
  return { import: { ...imported, storage_path: stored ? 'guardado' : null }, rows: p.result.rows.length, source_file_stored: stored, report: next };
}

async function revertImport(ctx, importId, body) {
  const { data: im, error } = await supabase.from('fin_imports').select('*').eq('tenant_id', ctx.tenantId).eq('id', h.uuid(importId, 'Importación')).maybeSingle();
  h.dbError(error);
  if (!im) h.fail(404, 'Importación no encontrada.');
  const report = await getReport(ctx, im.report_id);
  assertEditable(ctx, report);
  if (im.status === 'reverted') h.fail(409, 'Esa importación ya fue revertida.');
  const reason = h.text(body.reason, { max: 500 });
  if (reason.length < 5) h.fail(400, 'Indique el motivo (mín. 5 caracteres).');
  const table = im.kind === 'entries' ? 'fin_entries' : 'fin_assumptions';
  const { error: e1 } = await supabase.from(table).update({ active: false }).eq('import_id', im.id);
  h.dbError(e1);
  const { error: e2 } = await supabase.from('fin_imports').update({ status: 'reverted', reverted_by: ctx.userId, reverted_at: new Date().toISOString(), revert_reason: reason }).eq('id', im.id);
  h.dbError(e2);
  await bump(ctx, report, 'importación revertida', `${im.file_name}: ${reason}`);
  await logEvent(ctx, report.id, 'import_reverted', { import_id: im.id, file_name: im.file_name, rows: im.row_count, reason });
  return { ok: true };
}

async function listEntries(ctx, id, q) {
  ctx.require('view');
  const report = await getReport(ctx, id);
  const page = Math.max(1, Number(q.page) || 1); const size = 100;
  let query = supabase.from('fin_entries').select('row_no, entry_date, account_code, account_name, concept, reference, debit, credit, opening_balance, closing_balance, classification, import_id', { count: 'exact' })
    .eq('report_id', report.id).eq('active', true).order('entry_date').order('row_no').range((page - 1) * size, page * size - 1);
  if (q.account) query = query.eq('account_code', String(q.account).slice(0, 60));
  if (q.q) { const term = String(q.q).replace(/[%,()]/g, ' ').trim().slice(0, 60); if (term) query = query.or(`concept.ilike.%${term}%,reference.ilike.%${term}%,account_name.ilike.%${term}%,account_code.ilike.%${term}%`); }
  const { data, error, count } = await query;
  h.dbError(error);
  return { entries: data || [], total: count || 0, page, size };
}

async function getVersion(ctx, id, version) {
  ctx.require('view');
  const report = await getReport(ctx, id);
  const { data, error } = await supabase.from('fin_versions').select('*').eq('report_id', report.id).eq('version', Number(version)).maybeSingle();
  h.dbError(error);
  if (!data) h.fail(404, 'Versión no encontrada.');
  return { version: data };
}

// ── Comparaciones (solo si Contabilidad las habilitó y hay datos suficientes) ──
async function compare(ctx, id, q) {
  ctx.require('view');
  const cfg = await loadConfig(ctx);
  if (!cfg.compare_enabled) h.fail(409, 'Las comparaciones no están habilitadas: se activan en Configuración cuando Contabilidad las solicite.');
  const a = await getReport(ctx, id);
  const b = await getReport(ctx, q.with);
  if (a.id === b.id) h.fail(400, 'Elija otro informe para comparar.');
  if (a.client_id !== b.client_id) h.fail(409, 'Solo se comparan informes de la misma empresa.');
  if (a.currency !== b.currency) h.fail(409, `Las monedas son distintas (${a.currency} y ${b.currency}); no se comparan.`);
  const [da, db] = [await loadData(a), await loadData(b)];
  const people = await usernames([a.prepared_by, b.prepared_by]);
  const label = (r, d) => ({ id: r.id, modality: r.modality, title: r.title, scenario: r.scenario, period_start: r.period_start, period_end: r.period_end, status: r.status, version: r.version, source: d.imports.filter(i => i.status === 'applied').map(i => i.file_name), prepared_by: people[r.prepared_by] || null });
  const net = d => { const m = new Map(); for (const e of d.entries) { const x = m.get(e.account_code) || { code: e.account_code, name: e.account_name, v: 0 }; x.v += e.debit - e.credit; if (!x.name && e.account_name) x.name = e.account_name; m.set(e.account_code, x); } return m; };
  // proyectado ↔ real: se compara cada valor estimado con la cifra real de su misma cuenta.
  const proj = [a, b].find(r => r.modality === 'proyectado'); const real = [a, b].find(r => r.modality !== 'proyectado');
  if (proj && real && proj.id !== real.id) {
    const dp = proj.id === a.id ? da : db; const dr = real.id === a.id ? da : db;
    const withAccount = dp.assumptions.filter(x => x.kind === 'valor_estimado' && x.account_code && x.amount !== null);
    if (!withAccount.length) h.fail(422, 'Para comparar un proyectado con cifras reales, los valores estimados deben traer el código de cuenta.');
    if (!dr.entries.length) h.fail(422, 'El informe real no tiene registros cargados.');
    const realNet = net(dr);
    return { kind: 'proyectado_vs_real', a: label(proj, dp), b: label(real, dr), note: 'Cada valor estimado se compara con el movimiento neto (débitos − créditos) de su cuenta en el informe real. Las cifras proyectadas son estimaciones del usuario, no hechos.',
      rows: withAccount.map(x => { const r = realNet.get(x.account_code); return { account_code: x.account_code, name: x.name, period: x.period, projected: x.amount, real: r ? r2(r.v) : null, difference: r ? r2(r.v - x.amount) : null, real_found: !!r }; }) };
  }
  if (a.modality === 'proyectado' || b.modality === 'proyectado') h.fail(409, 'Solo se compara un proyectado con un informe interino o del año.');
  if (!da.entries.length || !db.entries.length) h.fail(422, 'Ambos informes deben tener registros cargados para compararlos.');
  const na = net(da); const nb = net(db);
  const codes = [...new Set([...na.keys(), ...nb.keys()])].sort((x, y) => x.localeCompare(y, 'es', { numeric: true }));
  return { kind: 'real_vs_real', a: label(a, da), b: label(b, db), note: 'Movimiento neto por cuenta (débitos − créditos) de cada informe; los ajustes no se incluyen.',
    rows: codes.map(c => { const x = na.get(c); const y = nb.get(c); return { account_code: c, name: (x || y).name, a: x ? r2(x.v) : null, b: y ? r2(y.v) : null, difference: r2((y ? y.v : 0) - (x ? x.v : 0)) }; }) };
}

// ── Plantillas y exportación ──────────────────────────────────────────────
async function template(ctx, mod) {
  ctx.require('view');
  modality(mod);
  const cfg = await loadConfig(ctx);
  return { file: await excel.templateFile(mod, cfg) };
}
async function exportReport(ctx, id) {
  ctx.require('view');
  const detail = await reportDetail(ctx, id);
  const entries = detail.totals.entries ? (await fetchAll(supabase.from('fin_entries').select('row_no, entry_date, account_code, account_name, concept, reference, debit, credit, opening_balance, closing_balance, classification').eq('report_id', detail.report.id).eq('active', true).order('entry_date').order('row_no'), 50000)) : [];
  const file = await excel.reportFile(detail, entries, await loadConfig(ctx));
  await logEvent(ctx, detail.report.id, 'report_exported', { version: detail.report.version, status: detail.report.status, complete: detail.completeness.complete });
  return { file };
}

// ── Equipo y permisos (solo administrador de Direct) ──────────────────────
async function team(ctx) {
  ctx.require('team_manage');
  const { data: profiles, error } = await supabase.from('direct_profiles').select('id, role, access_estados, created_at').eq('tenant_id', ctx.tenantId).order('created_at');
  h.dbError(error);
  const [{ data: members, error: me2 }, { data: assigned, error: ae }] = await Promise.all([
    supabase.from('fin_members').select('*').eq('tenant_id', ctx.tenantId),
    supabase.from('fin_member_clients').select('user_id, client_id').eq('tenant_id', ctx.tenantId),
  ]);
  h.dbError(me2); h.dbError(ae);
  const names = await usernames((profiles || []).map(p => p.id));
  const byUser = Object.fromEntries((members || []).map(m => [m.user_id, m]));
  const list = (profiles || []).filter(p => p.role === 'admin' || p.access_estados).map(p => {
    const m = byUser[p.id]; const role = p.role === 'admin' ? 'admin' : (m?.fin_role || 'lectura');
    return { user_id: p.id, username: names[p.id] || p.id.slice(0, 8), app_role: p.role, fin_role: role, role_label: rules.ROLE_LABELS[role], all_clients: p.role === 'admin' ? true : (m ? m.all_clients : true),
      client_ids: (assigned || []).filter(a => a.user_id === p.id).map(a => a.client_id), permissions: p.role === 'admin' ? rules.PERMISSIONS : [...rules.permissionsFor(role, m?.permissions)], overrides: m?.permissions || {} };
  });
  return { members: list, roles: Object.entries(rules.ROLE_PERMISSIONS).map(([key, permissions]) => ({ key, label: rules.ROLE_LABELS[key], permissions })), all_permissions: rules.PERMISSIONS, permission_labels: rules.PERMISSION_LABELS };
}
async function updateMember(ctx, userId, body) {
  ctx.require('team_manage');
  const uid = h.uuid(userId, 'Persona');
  const { data: prof, error } = await supabase.from('direct_profiles').select('id, role, access_estados').eq('tenant_id', ctx.tenantId).eq('id', uid).maybeSingle();
  h.dbError(error);
  if (!prof) h.fail(404, 'Persona no encontrada.');
  if (prof.role === 'admin') h.fail(409, 'Los administradores tienen todos los permisos; no se configuran aquí.');
  if (!prof.access_estados) h.fail(409, 'Esa persona no tiene acceso a Estados Financieros. Actívelo primero en Direct → Usuarios.');
  const role = String(body.fin_role || 'lectura');
  if (!rules.ROLE_PERMISSIONS[role]) h.fail(400, 'Rol inválido.');
  const overrides = {};
  for (const [k, v] of Object.entries(body.permissions || {})) if (rules.PERMISSIONS.includes(k) && !rules.NO_OVERRIDE.includes(k) && typeof v === 'boolean') overrides[k] = v;
  const allClients = body.all_clients !== false;
  const clientIds = allClients ? [] : [...new Set((Array.isArray(body.client_ids) ? body.client_ids : []).map(c => h.uuid(c, 'Empresa')))];
  if (!allClients && clientIds.length) {
    const { data: ok, error: ce } = await supabase.from('direct_clients').select('id').eq('tenant_id', ctx.tenantId).in('id', clientIds);
    h.dbError(ce);
    if ((ok || []).length !== clientIds.length) h.fail(400, 'Alguna empresa no existe.');
  }
  const { error: ue } = await supabase.from('fin_members').upsert({ tenant_id: ctx.tenantId, user_id: uid, fin_role: role, all_clients: allClients, permissions: overrides, updated_by: ctx.userId, updated_at: new Date().toISOString() }, { onConflict: 'tenant_id,user_id' });
  h.dbError(ue);
  const { error: de } = await supabase.from('fin_member_clients').delete().eq('tenant_id', ctx.tenantId).eq('user_id', uid);
  h.dbError(de);
  if (clientIds.length) { const { error: ie } = await supabase.from('fin_member_clients').insert(clientIds.map(c => ({ tenant_id: ctx.tenantId, user_id: uid, client_id: c }))); h.dbError(ie); }
  await logEvent(ctx, null, 'member_updated', { user_id: uid, fin_role: role, all_clients: allClients, clients: clientIds.length, overrides });
  return { ok: true };
}

module.exports = {
  me, getConfig, putConfig, listClients, listReports, createReport, reportDetail, updateReport, transition, updateDocuments,
  createAssumption, updateAssumption, deleteAssumption, createAdjustment, deleteAdjustment, importPreview, importConfirm, revertImport,
  listEntries, getVersion, compare, template, exportReport, team, updateMember,
};
