// Manejadores de Nómina. Todo filtra por tenant y por alcance de empresa; nunca
// confía en el client_id del cuerpo sin validarlo contra la empresa de la ruta.
const supabase = require('../supabase');
const h = require('../nala/http');
const { validate } = require('./formula');
const { computePeriod, computeRow } = require('./compute');
const { buildWorkbook } = require('./excel');
const settingsStore = require('./settings');

const COLUMN_TYPES = ['monto', 'numero', 'texto', 'formula'];
const KEY_RE = /^[a-z][a-z0-9_]{0,38}$/;

// ── helpers de empresa ─────────────────────────────────────────────────────
async function requireClientRow(ctx, clientId) {
  const id = h.uuid(clientId, 'empresa');
  ctx.requireClient(id);
  const { data, error } = await supabase.from('direct_clients').select('id, legal_name, rnc, cedula').eq('tenant_id', ctx.tenantId).eq('id', id).maybeSingle();
  h.dbError(error);
  if (!data) h.fail(404, 'Empresa no encontrada.');
  return data;
}

async function columnsOf(ctx, clientId) {
  const { data, error } = await supabase.from('nomina_columns').select('*').eq('tenant_id', ctx.tenantId).eq('client_id', clientId).order('position').order('created_at');
  h.dbError(error);
  return data || [];
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// ── identidad y empresas ───────────────────────────────────────────────────
async function me(ctx) {
  const { data: tenant, error } = await supabase.from('direct_tenants').select('id, name, slug').eq('id', ctx.tenantId).maybeSingle();
  h.dbError(error);
  return { user_id: ctx.userId, tenant, is_admin: ctx.isAdmin, column_types: COLUMN_TYPES };
}

async function listClients(ctx) {
  let q = supabase.from('direct_clients').select('id, legal_name, rnc, cedula, status').eq('tenant_id', ctx.tenantId).order('legal_name');
  const scope = ctx.scopeArray();
  if (scope) q = q.in('id', scope.length ? scope : ['00000000-0000-0000-0000-000000000000']);
  const { data, error } = await q;
  h.dbError(error);
  return { clients: (data || []).filter(c => ctx.canClient(c.id)) };
}

// ── columnas ───────────────────────────────────────────────────────────────
async function listColumns(ctx, clientId) {
  await requireClientRow(ctx, clientId);
  return { columns: await columnsOf(ctx, clientId) };
}

function columnPayload(body, existingKeys) {
  const type = String(body.type || '').trim();
  if (!COLUMN_TYPES.includes(type)) h.fail(400, 'Tipo de columna inválido.');
  const key = String(body.key || '').trim().toLowerCase();
  if (!KEY_RE.test(key)) h.fail(400, 'La clave debe empezar por letra y usar sólo minúsculas, números y guion bajo (máx. 39).');
  const label = h.text(body.label, { min: 1, max: 60, label: 'nombre de la columna' });
  const row = { key, label, type, sign: 0, include_total: false, position: Number.isFinite(+body.position) ? Math.trunc(+body.position) : 0, formula: null };
  if (type === 'formula') {
    const v = validate(body.formula, existingKeys);
    if (!v.ok) h.fail(400, v.error);
    row.formula = String(body.formula).trim();
  }
  if (type === 'monto' || type === 'formula') {
    row.sign = [-1, 0, 1].includes(+body.sign) ? +body.sign : 1;
    row.include_total = body.include_total !== false;
  }
  return row;
}

async function createColumn(ctx, clientId, body) {
  await requireClientRow(ctx, clientId);
  const existing = await columnsOf(ctx, clientId);
  const payload = columnPayload(body || {}, existing.map(c => c.key));
  if (existing.some(c => c.key === payload.key)) h.fail(409, `Ya existe una columna con la clave "${payload.key}".`);
  if (!payload.position) payload.position = (existing.reduce((m, c) => Math.max(m, c.position), 0) || 0) + 1;
  const { data, error } = await supabase.from('nomina_columns').insert({ tenant_id: ctx.tenantId, client_id: clientId, ...payload }).select('*').single();
  h.dbError(error);
  return { column: data };
}

async function updateColumn(ctx, id, body) {
  const colId = h.uuid(id);
  const { data: col, error } = await supabase.from('nomina_columns').select('*').eq('tenant_id', ctx.tenantId).eq('id', colId).maybeSingle();
  h.dbError(error);
  if (!col) h.fail(404, 'Columna no encontrada.');
  ctx.requireClient(col.client_id);
  const others = (await columnsOf(ctx, col.client_id)).filter(c => c.id !== colId);
  // La clave no se cambia (las fórmulas y los valores guardados dependen de ella).
  const payload = columnPayload({ ...body, key: col.key, type: body.type || col.type }, others.map(c => c.key));
  delete payload.key;
  if (body.position === undefined) payload.position = col.position; // no reiniciar el orden
  const { data, error: ue } = await supabase.from('nomina_columns').update({ ...payload, updated_at: new Date().toISOString() }).eq('tenant_id', ctx.tenantId).eq('id', colId).select('*').single();
  h.dbError(ue);
  return { column: data };
}

async function deleteColumn(ctx, id) {
  const colId = h.uuid(id);
  const { data: col, error } = await supabase.from('nomina_columns').select('client_id, key').eq('tenant_id', ctx.tenantId).eq('id', colId).maybeSingle();
  h.dbError(error);
  if (!col) h.fail(404, 'Columna no encontrada.');
  ctx.requireClient(col.client_id);
  const others = await columnsOf(ctx, col.client_id);
  const used = others.find(c => c.type === 'formula' && c.id !== colId && (validate(c.formula, null).refs || []).includes(col.key));
  if (used) h.fail(409, `No se puede borrar: la fórmula de "${used.label}" usa esta columna.`);
  const { error: de } = await supabase.from('nomina_columns').delete().eq('tenant_id', ctx.tenantId).eq('id', colId);
  h.dbError(de);
  return { deleted: true };
}

// ── empleados ──────────────────────────────────────────────────────────────
async function listEmployees(ctx, clientId) {
  await requireClientRow(ctx, clientId);
  const { data, error } = await supabase.from('nomina_employees').select('*').eq('tenant_id', ctx.tenantId).eq('client_id', clientId).order('active', { ascending: false }).order('full_name');
  h.dbError(error);
  return { employees: data || [] };
}

function employeePayload(body) {
  return {
    full_name: h.text(body.full_name, { min: 1, max: 120, label: 'nombre del empleado' }),
    identifier: body.identifier ? h.text(body.identifier, { max: 20, label: 'cédula' }) : null,
    position: body.position ? h.text(body.position, { max: 80, label: 'puesto' }) : null,
    forma_pago: body.forma_pago ? h.text(body.forma_pago, { max: 30, label: 'forma de pago' }) : null,
    notes: body.notes ? h.text(body.notes, { max: 500, label: 'nota' }) : null,
    active: body.active !== false,
  };
}

// ── ajustes de la empresa (tasas de ley y aportes del empleador) ───────────
async function getSettings(ctx, clientId) {
  await requireClientRow(ctx, clientId);
  return { settings: await settingsStore.load(ctx.tenantId, clientId) };
}

async function putSettings(ctx, clientId, body) {
  await requireClientRow(ctx, clientId);
  return { settings: await settingsStore.save(ctx.tenantId, clientId, body || {}) };
}

async function createEmployee(ctx, clientId, body) {
  await requireClientRow(ctx, clientId);
  const { data, error } = await supabase.from('nomina_employees').insert({ tenant_id: ctx.tenantId, client_id: clientId, ...employeePayload(body || {}) }).select('*').single();
  h.dbError(error);
  return { employee: data };
}

async function updateEmployee(ctx, id, body) {
  const empId = h.uuid(id);
  const { data: emp, error } = await supabase.from('nomina_employees').select('client_id').eq('tenant_id', ctx.tenantId).eq('id', empId).maybeSingle();
  h.dbError(error);
  if (!emp) h.fail(404, 'Empleado no encontrado.');
  ctx.requireClient(emp.client_id);
  const { data, error: ue } = await supabase.from('nomina_employees').update({ ...employeePayload(body || {}), updated_at: new Date().toISOString() }).eq('tenant_id', ctx.tenantId).eq('id', empId).select('*').single();
  h.dbError(ue);
  return { employee: data };
}

// Ficha del empleado: sus datos + el historial de todos los períodos en los que
// aparece (ingresos, deducciones y neto calculados), con acumulados.
async function employeeHistory(ctx, id) {
  const empId = h.uuid(id, 'empleado');
  const { data: emp, error } = await supabase.from('nomina_employees').select('*').eq('tenant_id', ctx.tenantId).eq('id', empId).maybeSingle();
  h.dbError(error);
  if (!emp) h.fail(404, 'Empleado no encontrado.');
  ctx.requireClient(emp.client_id);
  const cols = await columnsOf(ctx, emp.client_id);
  const [{ data: periods, error: pe }, { data: entries, error: ne }] = await Promise.all([
    supabase.from('nomina_periods').select('id, label, year, month, status, created_at').eq('tenant_id', ctx.tenantId).eq('client_id', emp.client_id).order('created_at', { ascending: false }),
    supabase.from('nomina_entries').select('period_id, values').eq('tenant_id', ctx.tenantId).eq('employee_id', empId),
  ]);
  h.dbError(pe); h.dbError(ne);
  const byPeriod = new Map((entries || []).map(e => [e.period_id, e.values || {}]));
  const history = (periods || []).filter(p => byPeriod.has(p.id)).map(p => {
    const r = computeRow(cols, byPeriod.get(p.id));
    return { period: { id: p.id, label: p.label, year: p.year, month: p.month, status: p.status }, ingresos: r.ingresos, deducciones: r.deducciones, neto: r.neto, cells: r.cells };
  });
  const totals = history.reduce((a, h2) => ({ ingresos: a.ingresos + h2.ingresos, deducciones: a.deducciones + h2.deducciones, neto: a.neto + h2.neto }), { ingresos: 0, deducciones: 0, neto: 0 });
  return { employee: emp, columns: cols, history, totals, periods_count: history.length };
}

async function deleteEmployee(ctx, id) {
  const empId = h.uuid(id);
  const { data: emp, error } = await supabase.from('nomina_employees').select('client_id').eq('tenant_id', ctx.tenantId).eq('id', empId).maybeSingle();
  h.dbError(error);
  if (!emp) h.fail(404, 'Empleado no encontrado.');
  ctx.requireClient(emp.client_id);
  const { error: de } = await supabase.from('nomina_employees').delete().eq('tenant_id', ctx.tenantId).eq('id', empId);
  h.dbError(de);
  return { deleted: true };
}

// ── períodos ───────────────────────────────────────────────────────────────
async function listPeriods(ctx, clientId) {
  await requireClientRow(ctx, clientId);
  const { data, error } = await supabase.from('nomina_periods').select('*').eq('tenant_id', ctx.tenantId).eq('client_id', clientId).order('created_at', { ascending: false });
  h.dbError(error);
  return { periods: data || [] };
}

async function createPeriod(ctx, clientId, body) {
  await requireClientRow(ctx, clientId);
  const label = h.text(body.label, { min: 1, max: 80, label: 'nombre del período' });
  const year = Number.isFinite(+body.year) ? Math.trunc(+body.year) : null;
  const month = Number.isFinite(+body.month) ? Math.trunc(+body.month) : null;
  const { data, error } = await supabase.from('nomina_periods').insert({ tenant_id: ctx.tenantId, client_id: clientId, label, year, month, created_by: ctx.userId }).select('*').single();
  h.dbError(error);
  return { period: data };
}

async function loadPeriod(ctx, id) {
  const pid = h.uuid(id, 'período');
  const { data: period, error } = await supabase.from('nomina_periods').select('*').eq('tenant_id', ctx.tenantId).eq('id', pid).maybeSingle();
  h.dbError(error);
  if (!period) h.fail(404, 'Período no encontrado.');
  ctx.requireClient(period.client_id);
  const [cols, { data: emps, error: ee }, { data: entries, error: ne }] = await Promise.all([
    columnsOf(ctx, period.client_id),
    supabase.from('nomina_employees').select('*').eq('tenant_id', ctx.tenantId).eq('client_id', period.client_id).eq('active', true).order('full_name'),
    supabase.from('nomina_entries').select('employee_id, values').eq('tenant_id', ctx.tenantId).eq('period_id', pid),
  ]);
  h.dbError(ee); h.dbError(ne);
  return { period, columns: cols, employees: emps || [], entries: entries || [] };
}

async function periodDetail(ctx, id) {
  const { period, columns, employees, entries } = await loadPeriod(ctx, id);
  const settings = await settingsStore.load(ctx.tenantId, period.client_id);
  const computed = computePeriod(columns, employees, entries, { settings });
  return { period, settings, ...computed };
}

async function updatePeriod(ctx, id, body) {
  const pid = h.uuid(id);
  const { data: period, error } = await supabase.from('nomina_periods').select('client_id, status').eq('tenant_id', ctx.tenantId).eq('id', pid).maybeSingle();
  h.dbError(error);
  if (!period) h.fail(404, 'Período no encontrado.');
  ctx.requireClient(period.client_id);
  const patch = { updated_at: new Date().toISOString() };
  if (body.label !== undefined) patch.label = h.text(body.label, { min: 1, max: 80, label: 'nombre del período' });
  if (body.status !== undefined) { if (!['draft', 'closed'].includes(body.status)) h.fail(400, 'Estado inválido.'); patch.status = body.status; }
  const { data, error: ue } = await supabase.from('nomina_periods').update(patch).eq('tenant_id', ctx.tenantId).eq('id', pid).select('*').single();
  h.dbError(ue);
  return { period: data };
}

async function deletePeriod(ctx, id) {
  const pid = h.uuid(id);
  const { data: period, error } = await supabase.from('nomina_periods').select('client_id').eq('tenant_id', ctx.tenantId).eq('id', pid).maybeSingle();
  h.dbError(error);
  if (!period) h.fail(404, 'Período no encontrado.');
  ctx.requireClient(period.client_id);
  const { error: de } = await supabase.from('nomina_periods').delete().eq('tenant_id', ctx.tenantId).eq('id', pid);
  h.dbError(de);
  return { deleted: true };
}

// Guarda los valores capturados (sólo columnas que NO son fórmula ni cálculo).
async function saveEntries(ctx, id, body) {
  const { period, columns } = await loadPeriod(ctx, id);
  if (period.status === 'closed') h.fail(409, 'El período está cerrado; reábralo para editar.');
  const editable = new Map(columns.filter(c => c.type !== 'formula').map(c => [c.key, c]));
  const list = Array.isArray(body.entries) ? body.entries : [];
  if (list.length > 2000) h.fail(400, 'Demasiados registros en una sola operación.');
  const rows = [];
  for (const e of list) {
    const employeeId = h.uuid(e.employee_id, 'empleado');
    const values = {};
    for (const [k, raw] of Object.entries(e.values || {})) {
      const col = editable.get(k);
      if (!col) continue; // ignora claves desconocidas o de fórmula
      if (col.type === 'texto') { if (raw != null && String(raw) !== '') values[k] = String(raw).slice(0, 500); }
      else { const n = num(raw); if (n !== null) values[k] = n; }
    }
    rows.push({ tenant_id: ctx.tenantId, period_id: period.id, employee_id: employeeId, values, updated_at: new Date().toISOString() });
  }
  if (rows.length) {
    const { error } = await supabase.from('nomina_entries').upsert(rows, { onConflict: 'tenant_id,period_id,employee_id' });
    h.dbError(error);
  }
  return periodDetail(ctx, id);
}

async function exportPeriod(ctx, id) {
  const { period, columns, employees, entries } = await loadPeriod(ctx, id);
  const computed = computePeriod(columns, employees, entries);
  const client = await requireClientRow(ctx, period.client_id);
  const buffer = await buildWorkbook({ period, client, ...computed });
  return { filename: `nomina-${(period.label || 'periodo').replace(/[^a-z0-9]+/gi, '_')}.xlsx`, base64: buffer.toString('base64') };
}

module.exports = {
  me, listClients,
  listColumns, createColumn, updateColumn, deleteColumn,
  listEmployees, createEmployee, updateEmployee, deleteEmployee, employeeHistory,
  getSettings, putSettings,
  listPeriods, createPeriod, periodDetail, updatePeriod, deletePeriod, saveEntries, exportPeriod,
};
