// Manejadores de Nómina. Todo filtra por tenant y por alcance de empresa; nunca
// confía en el client_id del cuerpo sin validarlo contra la empresa de la ruta.
const crypto = require('crypto');
const supabase = require('../supabase');
const h = require('../nala/http');
const { validate } = require('./formula');
const { computePeriod, computeRow, paramsFromSettings } = require('./compute');
const { buildWorkbook } = require('./excel');
const settingsStore = require('./settings');
const storage = require('./storage');
const { summarize: summarizeDashboard } = require('./dashboard');
const { drParts } = require('./calendar');

const COLUMN_TYPES = ['monto', 'numero', 'texto', 'formula'];
const KEY_RE = /^[a-z][a-z0-9_]{0,38}$/;

// ── helpers de empresa ─────────────────────────────────────────────────────
async function requireClientRow(ctx, clientId) {
  const id = h.uuid(clientId, 'empresa');
  const { data, error } = await supabase.from('nomina_companies').select('id, legal_name, rnc, active').eq('tenant_id', ctx.tenantId).eq('id', id).maybeSingle();
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

// Empresas de Nómina (propias del módulo). El usuario las crea aquí dentro.
const CLIENT_COLS = 'id, legal_name, rnc, active, auto_nomina, pinned';
async function listClients(ctx) {
  // Fijadas primero, luego por nombre.
  const { data, error } = await supabase.from('nomina_companies').select(CLIENT_COLS).eq('tenant_id', ctx.tenantId).order('pinned', { ascending: false }).order('legal_name');
  h.dbError(error);
  return { clients: data || [] };
}

function companyPayload(body) {
  const row = { legal_name: h.text(body.legal_name, { min: 1, max: 160, label: 'nombre de la empresa' }) };
  const rnc = body.rnc == null ? '' : String(body.rnc).replace(/\D+/g, '');
  row.rnc = rnc ? rnc.slice(0, 20) : null;
  if (body.active !== undefined) row.active = body.active !== false;
  if (body.auto_nomina !== undefined) row.auto_nomina = body.auto_nomina !== false;
  if (body.pinned !== undefined) row.pinned = body.pinned === true;
  return row;
}

async function createClient(ctx, body) {
  const { data, error } = await supabase.from('nomina_companies').insert({ tenant_id: ctx.tenantId, ...companyPayload(body || {}) }).select(CLIENT_COLS).single();
  h.dbError(error);
  return { client: data };
}

async function updateClient(ctx, id, body) {
  const cid = h.uuid(id, 'empresa');
  await requireClientRow(ctx, cid);
  const { data, error } = await supabase.from('nomina_companies').update({ ...companyPayload(body || {}), updated_at: new Date().toISOString() }).eq('tenant_id', ctx.tenantId).eq('id', cid).select(CLIENT_COLS).single();
  h.dbError(error);
  return { client: data };
}

// Borra la empresa y, en cascada, sus columnas/empleados/períodos/valores.
async function deleteClient(ctx, id) {
  const cid = h.uuid(id, 'empresa');
  await requireClientRow(ctx, cid);
  const { error } = await supabase.from('nomina_companies').delete().eq('tenant_id', ctx.tenantId).eq('id', cid);
  h.dbError(error);
  return { deleted: true };
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
  // carry = columna fija (se mantiene al generar la próxima nómina). Las de
  // fórmula nunca se guardan, así que su carry es irrelevante.
  if (body.carry !== undefined) row.carry = body.carry === true;
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

const EXIT_REASONS = ['renuncia', 'desahucio', 'despido', 'fin_contrato', 'otro'];
function optDate(v, label) {
  if (v == null || v === '') return null;
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) h.fail(400, `Fecha inválida (${label}).`);
  return s;
}
function optMoney(v, label) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) h.fail(400, `Monto inválido (${label}).`);
  return Math.round(n * 100) / 100;
}
function employeePayload(body) {
  const exitDate = optDate(body.exit_date, 'fecha de salida');
  const reason = body.exit_reason ? String(body.exit_reason).trim().toLowerCase() : null;
  return {
    full_name: h.text(body.full_name, { min: 1, max: 120, label: 'nombre del empleado' }),
    identifier: body.identifier ? h.text(body.identifier, { max: 20, label: 'cédula' }) : null,
    nss: body.nss ? h.text(body.nss, { max: 20, label: 'NSS' }) : null,
    position: body.position ? h.text(body.position, { max: 80, label: 'puesto' }) : null,
    forma_pago: body.forma_pago ? h.text(body.forma_pago, { max: 30, label: 'forma de pago' }) : null,
    notes: body.notes ? h.text(body.notes, { max: 500, label: 'nota' }) : null,
    hire_date: optDate(body.hire_date, 'fecha de entrada'),
    exit_date: exitDate,
    exit_reason: reason && EXIT_REASONS.includes(reason) ? reason : null,
    severance_paid: !!body.severance_paid,
    severance_amount: body.severance_paid ? optMoney(body.severance_amount, 'prestaciones') : null,
    // Una baja (con fecha de salida) queda inactiva automáticamente; sin baja,
    // respeta la casilla Activo.
    active: exitDate ? false : body.active !== false,
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
  const params = paramsFromSettings(await settingsStore.load(ctx.tenantId, emp.client_id));
  const [{ data: periods, error: pe }, { data: entries, error: ne }] = await Promise.all([
    supabase.from('nomina_periods').select('id, label, year, month, status, created_at').eq('tenant_id', ctx.tenantId).eq('client_id', emp.client_id).order('created_at', { ascending: false }),
    supabase.from('nomina_entries').select('period_id, values').eq('tenant_id', ctx.tenantId).eq('employee_id', empId),
  ]);
  h.dbError(pe); h.dbError(ne);
  const byPeriod = new Map((entries || []).map(e => [e.period_id, e.values || {}]));
  const history = (periods || []).filter(p => byPeriod.has(p.id)).map(p => {
    const r = computeRow(cols, byPeriod.get(p.id), params);
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
  if (body.status !== undefined) {
    if (!['draft', 'closed'].includes(body.status)) h.fail(400, 'Estado inválido.');
    patch.status = body.status;
    // Reabrir un período también reabre sus novedades (quita el bloqueo del corte).
    if (body.status === 'draft') patch.novedades_locked = false;
  }
  if (body.novedades_locked !== undefined) patch.novedades_locked = body.novedades_locked === true;
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
  if (period.novedades_locked) h.fail(409, 'Las novedades de esta nómina ya cerraron (pasó la fecha de corte). Captúralas en la próxima.');
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

// ── Documentos del empleado (recibos firmados, soportes, expediente) ───────
const FILE_COLS = 'id, period_id, kind, original_name, mime_type, size_bytes, created_at';
const MAX_FILE = 15 * 1024 * 1024;
const OK_MIME = /^(application\/pdf|image\/(png|jpe?g|webp|heic|heif))$/i;

async function employeeOfFileScope(ctx, empId) {
  const id = h.uuid(empId, 'empleado');
  const { data, error } = await supabase.from('nomina_employees').select('id, client_id').eq('tenant_id', ctx.tenantId).eq('id', id).maybeSingle();
  h.dbError(error);
  if (!data) h.fail(404, 'Empleado no encontrado.');
  ctx.requireClient(data.client_id);
  return data;
}

async function listEmployeeFiles(ctx, empId, query = {}) {
  const emp = await employeeOfFileScope(ctx, empId);
  let q = supabase.from('nomina_employee_files').select(FILE_COLS).eq('tenant_id', ctx.tenantId).eq('employee_id', emp.id).order('created_at', { ascending: false });
  if (query.period_id) q = q.eq('period_id', h.uuid(query.period_id, 'período'));
  const { data, error } = await q;
  h.dbError(error);
  return { files: data || [] };
}

async function addEmployeeFile(ctx, empId, body) {
  const emp = await employeeOfFileScope(ctx, empId);
  const name = h.text(body.name, { min: 1, max: 200, label: 'nombre del archivo' });
  const kind = body.kind ? h.text(body.kind, { max: 30, label: 'tipo' }) : 'documento';
  const periodId = body.period_id ? h.uuid(body.period_id, 'período') : null;
  const mime = body.mime ? String(body.mime).slice(0, 100) : 'application/octet-stream';
  if (!OK_MIME.test(mime)) h.fail(415, 'Solo se permiten archivos PDF o imágenes.');
  let buffer;
  try { buffer = Buffer.from(String(body.data || ''), 'base64'); } catch { buffer = Buffer.alloc(0); }
  if (!buffer.length) h.fail(400, 'Archivo vacío o inválido.');
  if (buffer.length > MAX_FILE) h.fail(413, 'El archivo supera 15 MB.');
  const safe = name.replace(/[^\w.\- ]+/g, '_').slice(0, 120);
  const path = `${ctx.tenantId}/${emp.client_id}/${emp.id}/${Date.now()}_${crypto.randomBytes(6).toString('hex')}_${safe}`;
  await storage.upload(path, buffer, mime);
  const { data, error } = await supabase.from('nomina_employee_files').insert({
    tenant_id: ctx.tenantId, client_id: emp.client_id, employee_id: emp.id, period_id: periodId,
    kind, original_name: name, mime_type: mime, size_bytes: buffer.length, storage_path: path, created_by: ctx.userId,
  }).select(FILE_COLS).single();
  if (error) { await storage.remove([path]).catch(() => {}); h.dbError(error); }
  return { file: data };
}

async function employeeFileLink(ctx, fileId) {
  const id = h.uuid(fileId, 'archivo');
  const { data, error } = await supabase.from('nomina_employee_files').select('storage_path, original_name, client_id').eq('tenant_id', ctx.tenantId).eq('id', id).maybeSingle();
  h.dbError(error);
  if (!data) h.fail(404, 'Archivo no encontrado.');
  ctx.requireClient(data.client_id);
  return { url: await storage.signedDownload(data.storage_path, 120, data.original_name) };
}

async function deleteEmployeeFile(ctx, fileId) {
  const id = h.uuid(fileId, 'archivo');
  const { data, error } = await supabase.from('nomina_employee_files').select('storage_path, client_id').eq('tenant_id', ctx.tenantId).eq('id', id).maybeSingle();
  h.dbError(error);
  if (!data) h.fail(404, 'Archivo no encontrado.');
  ctx.requireClient(data.client_id);
  await storage.remove([data.storage_path]).catch(() => {});
  const { error: de } = await supabase.from('nomina_employee_files').delete().eq('tenant_id', ctx.tenantId).eq('id', id);
  h.dbError(de);
  return {};
}

// ── panel (todas las empresas) ─────────────────────────────────────────────
// Lee en bloque (PostgREST corta en 1000 filas, por eso se pagina) y delega el cálculo en
// lib/nomina/dashboard.js. Solo lectura, filtrado por tenant.
async function fetchAll(build) {
  const out = [];
  for (let from = 0; from < 50000; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    h.dbError(error);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function dashboard(ctx) {
  const t = ctx.tenantId;
  const [companies, periods, columns, employees, settings] = await Promise.all([
    fetchAll(() => supabase.from('nomina_companies').select(CLIENT_COLS).eq('tenant_id', t).order('id')),
    fetchAll(() => supabase.from('nomina_periods').select('id, client_id, label, status, cycle, pay_date, novedades_locked, created_at').eq('tenant_id', t).order('id')),
    fetchAll(() => supabase.from('nomina_columns').select('*').eq('tenant_id', t).order('id')),
    fetchAll(() => supabase.from('nomina_employees').select('id, client_id').eq('tenant_id', t).eq('active', true).order('id')),
    fetchAll(() => supabase.from('nomina_settings').select('client_id, settings').eq('tenant_id', t).order('client_id')),
  ]);
  // Valores capturados solo de los períodos más recientes de cada empresa (los que muestra el panel).
  const latest = new Map();
  for (const p of periods) { const cur = latest.get(p.client_id); if (!cur || String(p.created_at) > String(cur.created_at)) latest.set(p.client_id, p); }
  const ids = [...latest.values()].map(p => p.id);
  let entries = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    entries = entries.concat(await fetchAll(() => supabase.from('nomina_entries').select('period_id, employee_id, values').eq('tenant_id', t).in('period_id', chunk).order('period_id').order('employee_id')));
  }
  const out = summarizeDashboard({ today: drParts(), companies, periods, columns, employees, entries, settings });
  // Orden: fijadas primero, luego por nombre.
  out.empresas.sort((a, b) => (b.fijada - a.fijada) || a.nombre.localeCompare(b.nombre, 'es'));
  return out;
}

module.exports = {
  me, dashboard, listClients, createClient, updateClient, deleteClient,
  listColumns, createColumn, updateColumn, deleteColumn,
  listEmployees, createEmployee, updateEmployee, deleteEmployee, employeeHistory,
  listEmployeeFiles, addEmployeeFile, employeeFileLink, deleteEmployeeFile,
  getSettings, putSettings,
  listPeriods, createPeriod, periodDetail, updatePeriod, deletePeriod, saveEntries, exportPeriod,
};
