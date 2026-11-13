// Flujo completo de Estados Financieros contra una base en memoria (sin red): crear, importar, validar,
// versiones, revisión/aprobación, bloqueo, reapertura, permisos y alcance por empresa.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ExcelJS = require('exceljs');
const { createFake } = require('./fake-supabase');

const fake = createFake();
const supPath = require.resolve('../../lib/supabase');
require.cache[supPath] = { id: supPath, filename: supPath, loaded: true, exports: fake };
const api = require('../../lib/estados/api');
const rules = require('../../lib/estados/rules');

const TENANT = '11111111-1111-4111-8111-111111111111';
const C1 = '22222222-2222-4222-8222-222222222221'; const C2 = '22222222-2222-4222-8222-222222222222';
fake.db.tables.direct_clients = [{ id: C1, tenant_id: TENANT, legal_name: 'Empresa Uno SRL', rnc: '131000001', status: 'active' }, { id: C2, tenant_id: TENANT, legal_name: 'Empresa Dos SRL', rnc: '131000002', status: 'active' }];
const U = { prep: '33333333-3333-4333-8333-333333333331', rev: '33333333-3333-4333-8333-333333333332', apr: '33333333-3333-4333-8333-333333333333', ro: '33333333-3333-4333-8333-333333333334', ctd: '33333333-3333-4333-8333-333333333335' };
Object.assign(fake.db.users, { [U.prep]: 'preparador1', [U.rev]: 'revisor1', [U.apr]: 'aprobador1', [U.ro]: 'lector1', [U.ctd]: 'contador1' });

function ctxFor(userId, role, { clients = null, admin = false } = {}) {
  const perms = admin ? new Set(rules.PERMISSIONS) : rules.permissionsFor(role);
  const scope = clients ? new Set(clients) : null;
  return { userId, username: fake.db.users[userId], tenantId: TENANT, isAdmin: admin, role, roleLabel: role, perms,
    can: p => perms.has(p), require(p) { if (!perms.has(p)) { const e = new Error('No tiene permiso'); e.status = 403; throw e; } },
    canClient: id => !scope || scope.has(id), requireClient(id) { if (scope && !scope.has(id)) { const e = new Error('Empresa o informe no encontrado.'); e.status = 404; throw e; } },
    scopeArray: () => (scope ? [...scope] : null) };
}
const prep = ctxFor(U.prep, 'preparador'); const rev = ctxFor(U.rev, 'revisor'); const apr = ctxFor(U.apr, 'aprobador'); const ro = ctxFor(U.ro, 'lectura'); const ctd = ctxFor(U.ctd, 'contador');
const rejects = async (p, status, re) => { try { await p; assert.fail('debió fallar'); } catch (e) { assert.equal(e.status, status, e.message); if (re) assert.match(e.message, re); return e; } };

async function xlsx(rows) {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Libro'); rows.forEach(r => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}
const HEAD = ['Fecha', 'Código de cuenta', 'Nombre de cuenta', 'Concepto', 'Referencia', 'Débito', 'Crédito', 'Clasificación contable'];
const goodRows = [HEAD,
  ['2026-10-05', '1101', 'Caja', 'Venta', 'AS-1', '1000.00', '', 'Activo'],
  ['2026-10-05', '4101', 'Ingresos', 'Venta', 'AS-1', '', '1000.00', 'Ingreso'],
  ['2026-10-31', '5101', 'Gastos', 'Alquiler', 'AS-2', '400', '', 'Gasto'],
  ['2026-10-31', '1101', 'Caja', 'Alquiler', 'AS-2', '', '400', 'Activo']];

test('plantillas: sin cifras y con lo pendiente de Contabilidad', async () => {
  for (const m of Object.keys(rules.MODALITIES)) {
    const { file } = await api.template({ ...prep, require() {}, can: () => true, tenantId: TENANT }, m);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(file.base64, 'base64'));
    assert.equal(wb.getWorksheet('Datos').rowCount, 1, 'solo encabezados');
    const text = JSON.stringify(wb.getWorksheet('Instrucciones').getSheetValues());
    assert.match(text, /Por confirmar con Contabilidad/); assert.match(text, /Contabilidad todavía debe entregar/);
  }
});

let interino;
test('crear interino: permisos y validaciones', async () => {
  await rejects(api.createReport(ro, { modality: 'interino' }), 403);
  await rejects(api.createReport(prep, { modality: 'interino', client_id: C1, title: 'Oct', period_start: '2026-10-01', period_end: '2026-10-31' }), 400, /período fiscal/);
  await rejects(api.createReport(prep, { modality: 'interino', client_id: C1, title: 'Oct', fiscal_period: '2026', period_start: '2026-10-31', period_end: '2026-10-01' }), 400, /no puede ser anterior/);
  const r = await api.createReport(prep, { modality: 'interino', client_id: C1, title: 'Interino octubre', fiscal_period: '2026', period_start: '2026-10-01', period_end: '2026-10-31' });
  interino = r.report;
  assert.equal(interino.status, 'borrador'); assert.equal(interino.version, 1); assert.equal(interino.prepared_by, U.prep);
  assert.equal(fake.db.tables.fin_versions.length, 1);
});

test('informe sin datos queda incompleto y no se aprueba', async () => {
  const d = await api.reportDetail(prep, interino.id);
  assert.equal(d.completeness.complete, false);
  assert.ok(d.completeness.items.some(i => i.code === 'SIN_INFORMACION' && i.severity === 'blocking'));
  await api.transition(prep, interino.id, { to: 'en_revision' });
  await rejects(api.transition(apr, interino.id, { to: 'aprobado' }), 422, /pendientes/);
  await api.transition(rev, interino.id, { to: 'observado', note: 'Falta cargar el libro' });
  await api.transition(prep, interino.id, { to: 'borrador' });
});

test('importación: preview con errores por fila y nada se guarda hasta confirmar', async () => {
  const bad = await xlsx([HEAD, ['2026-10-05', '1101', 'Caja', 'x', 'AS-1', '1,5', '', ''], ['2026-13-40', '', '', '', '', '10', '', ''], ['2026-11-15', '1101', '', '', 'AS-9', '5', '', ''], ['2026-10-05', '1101', '', '', 'AS-3', '-5', '', '']]);
  const p = await api.importPreview(prep, interino.id, { file_base64: bad, file_name: 'libro.xlsx' });
  assert.equal(p.can_confirm, false);
  const msgs = p.errors.map(e => `${e.row}|${e.field}`);
  assert.ok(msgs.includes('2|Débito'), 'coma decimal'); assert.ok(msgs.includes('3|Fecha')); assert.ok(msgs.includes('3|Código de cuenta')); assert.ok(msgs.includes('4|Fecha'), 'fuera del período'); assert.ok(msgs.includes('5|Débito'), 'negativo');
  await rejects(api.importConfirm(prep, interino.id, { file_base64: bad, file_name: 'libro.xlsx' }), 422, /error/);
  assert.equal((fake.db.tables.fin_entries || []).length, 0);
  await rejects(api.importPreview(prep, interino.id, { file_base64: Buffer.from('x').toString('base64'), file_name: 'libro.xls' }), 400, /\.xlsx/);
});

test('importación válida: guarda filas, archivo fuente, versión y evento', async () => {
  const good = await xlsx(goodRows);
  const p = await api.importPreview(prep, interino.id, { file_base64: good, file_name: 'libro.xlsx' });
  assert.equal(p.can_confirm, true); assert.equal(p.valid_rows, 4); assert.deepEqual(p.totals, { debit: 1400, credit: 1400 }); assert.equal(p.balance.ok, true);
  assert.equal(p.mapping.entry_date, 0); assert.equal(p.mapping.classification, 7);
  const before = (await api.reportDetail(prep, interino.id)).report.version;
  const c = await api.importConfirm(prep, interino.id, { file_base64: good, file_name: 'libro.xlsx', save_mapping: true });
  assert.equal(c.rows, 4); assert.equal(c.source_file_stored, true); assert.equal(fake.db.uploads.length, 1);
  const d = await api.reportDetail(prep, interino.id);
  assert.equal(d.report.version, before + 1); assert.equal(d.totals.entries, 4); assert.equal(d.data_through, '2026-10-31');
  assert.equal(d.imports[0].sha256.length, 64); assert.ok(d.events.some(e => e.action === 'import_applied'));
  assert.equal(d.completeness.complete, true, JSON.stringify(d.completeness.items));
  // mismo archivo otra vez = posibles duplicados (no se acepta en silencio)
  const again = await api.importPreview(prep, interino.id, { file_base64: good, file_name: 'libro.xlsx' });
  assert.equal(again.can_confirm, false); assert.match(again.errors[0].message, /duplicado/);
  assert.equal(again.saved_mapping_used, true);
});

test('descuadre por asiento y archivo parcial vuelven el informe incompleto', async () => {
  const unbalanced = await xlsx([HEAD, ['2026-10-31', '1101', 'Caja', 'x', 'AS-7', '50', '', 'Activo']]);
  await api.importConfirm(prep, interino.id, { file_base64: unbalanced, file_name: 'parcial.xlsx' });
  const d = await api.reportDetail(prep, interino.id);
  assert.ok(d.completeness.items.some(i => i.code === 'DESCUADRE' && i.severity === 'blocking'));
  await api.transition(prep, interino.id, { to: 'en_revision' });
  await rejects(api.transition(apr, interino.id, { to: 'aprobado' }), 422);
  // revertir la importación (queda el historial) → vuelve a cuadrar
  const bad = d.imports.find(i => i.file_name === 'parcial.xlsx');
  await rejects(api.revertImport(prep, bad.id, { reason: '' }), 400);
  await api.revertImport(prep, bad.id, { reason: 'Archivo parcial equivocado' });
  const d2 = await api.reportDetail(prep, interino.id);
  assert.equal(d2.totals.entries, 4); assert.equal(d2.imports.find(i => i.id === bad.id).status, 'reverted');
  assert.equal(fake.db.tables.fin_entries.length, 5, 'las filas revertidas se conservan inactivas');
});

test('revisión → aprobación → bloqueo → reapertura con motivo', async () => {
  await rejects(api.transition(prep, interino.id, { to: 'aprobado' }), 403);
  const a = await api.transition(apr, interino.id, { to: 'aprobado' });
  assert.equal(a.report.status, 'aprobado'); assert.equal(a.report.approved_by, U.apr);
  await rejects(api.updateReport(prep, interino.id, { title: 'otro' }), 409, /aprobado o cerrado/);
  await rejects(api.createAdjustment(prep, interino.id, { adj_date: '2026-10-31', concept: 'x', account_code: '1', debit: 1 }), 409);
  await rejects(api.transition(apr, interino.id, { to: 'cerrado' }), 403, /permiso/);
  const c = await api.transition(ctd, interino.id, { to: 'cerrado' });
  assert.equal(c.report.closed_by, U.ctd);
  await rejects(api.transition(ctd, interino.id, { to: 'observado' }), 400, /motivo/);
  const re = await api.transition(ctd, interino.id, { to: 'observado', note: 'Se detectó un ajuste pendiente' });
  assert.equal(re.report.approved_by, null); assert.equal(re.report.closed_by, null);
  const d = await api.reportDetail(prep, interino.id);
  assert.ok(d.events.some(e => e.action === 'report_reopened' && e.details.previous.approved_by === U.apr), 'la reapertura conserva quién aprobó');
  assert.ok(d.versions.length >= 8); assert.deepEqual(d.versions.map(v => v.version), [...d.versions.map(v => v.version)].sort((a, b) => b - a));
});

test('exportación: preliminar mientras no esté aprobado', async () => {
  const { file } = await api.exportReport(prep, interino.id);
  assert.match(file.name, /PRELIMINAR/);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(file.base64, 'base64'));
  assert.match(String(wb.getWorksheet('Informe').getCell('A1').value), /PRELIMINAR.*NO APROBADO/);
  assert.ok(wb.getWorksheet('Registros').rowCount >= 5);
});

let proy;
test('proyectado: escenario obligatorio, supuestos pendientes bloquean y no calcula nada', async () => {
  await rejects(api.createReport(prep, { modality: 'proyectado', client_id: C1, title: 'Proy 2027', period_start: '2027-01-01', period_end: '2027-12-31' }), 400, /escenario/);
  proy = (await api.createReport(prep, { modality: 'proyectado', client_id: C1, title: 'Proyección 2027', scenario: 'Base', period_start: '2027-01-01', period_end: '2027-12-31' })).report;
  assert.equal(proy.status, 'borrador');
  await rejects(api.createAssumption(prep, proy.id, { kind: 'valor_estimado', name: 'Ventas', amount: '100' }), 400, /descripción/);
  await api.createAssumption(prep, proy.id, { kind: 'valor_estimado', name: 'Ventas enero', description: 'Dato dado por Contabilidad', amount: '1000.50', account_code: '4101', period: '2027-01' });
  await api.createAssumption(prep, proy.id, { kind: 'supuesto', name: 'Inflación', pending: true });
  const d = await api.reportDetail(prep, proy.id);
  assert.ok(d.completeness.items.some(i => i.code === 'SUPUESTOS_PENDIENTES' && i.severity === 'blocking'));
  assert.ok(d.completeness.items.some(i => i.code === 'FORMULAS_PENDIENTES' && i.severity === 'info'));
  assert.equal(d.accounts.length, 0, 'no se calcula ninguna cifra');
  const pend = d.assumptions.find(a => a.name === 'Inflación');
  await api.updateAssumption(prep, pend.id, { name: 'Inflación', kind: 'supuesto', pending: false, description: 'Según Contabilidad' });
  assert.equal((await api.reportDetail(prep, proy.id)).completeness.complete, true);
  await api.deleteAssumption(prep, pend.id);
  assert.equal(fake.db.tables.fin_assumptions.find(a => a.id === pend.id).active, false, 'se conserva inactivo');
  await rejects(api.createAdjustment(prep, proy.id, { adj_date: '2027-01-01', concept: 'x', account_code: '1', debit: 1 }), 409);
});

test('proyectado: importación de supuestos y comparación con real solo si se habilita', async () => {
  const hdr = ['Escenario', 'Tipo', 'Concepto', 'Descripción', 'Período', 'Código de cuenta', 'Valor', 'Unidad', 'Fuente'];
  const f = await xlsx([hdr, ['Base', 'valor estimado', 'Ventas feb', 'Dato de Contabilidad', '2027-02', '4101', '2000', 'RD$', 'Contabilidad'], ['Otro', 'supuesto', 'X', '', '', '', '', '', '']]);
  const p = await api.importPreview(prep, proy.id, { file_base64: f, file_name: 'sup.xlsx' });
  assert.equal(p.can_confirm, false); assert.match(p.errors[0].message, /escenario/i);
  const ok = await xlsx([hdr, ['Base', 'valor estimado', 'Ventas feb', 'Dato de Contabilidad', '2027-02', '4101', '2000', 'RD$', 'Contabilidad']]);
  assert.equal((await api.importConfirm(prep, proy.id, { file_base64: ok, file_name: 'sup.xlsx' })).rows, 1);
  await rejects(api.compare(prep, proy.id, { with: interino.id }), 409, /no están habilitadas/);
  await api.putConfig(ctd, { config: { compare_enabled: true } });
  const cmp = await api.compare(prep, proy.id, { with: interino.id });
  assert.equal(cmp.kind, 'proyectado_vs_real'); assert.equal(cmp.rows[0].real, -1000); assert.match(cmp.note, /estimaciones/);
});

test('alcance por empresa y permisos de configuración', async () => {
  const limited = ctxFor(U.prep, 'preparador', { clients: [C2] });
  await rejects(api.reportDetail(limited, interino.id), 404);
  await rejects(api.createReport(limited, { modality: 'interino', client_id: C1, title: 'x', fiscal_period: '1', period_start: '2026-01-01', period_end: '2026-01-31' }), 404);
  assert.equal((await api.listReports(limited, {})).reports.length, 0);
  assert.equal((await api.listClients(limited)).clients.length, 1);
  await rejects(api.putConfig(prep, { config: {} }), 403);
  await rejects(api.team(ctd), 403);
});

test('legalización queda apagada hasta que Contabilidad la confirme', async () => {
  let cfg = (await api.getConfig(prep)).config;
  assert.ok(!cfg.states.anual.includes('pendiente_legalizacion'));
  cfg = (await api.putConfig(ctd, { config: { ...cfg, legalizacion: { enabled: true, notes: 'por definir' }, states: { ...cfg.states, anual: [...cfg.states.anual, 'pendiente_legalizacion'] } } })).config;
  assert.ok(cfg.states.anual.includes('pendiente_legalizacion')); assert.ok(!cfg.states.interino.includes('pendiente_legalizacion'));
});

test('del año: año fiscal, ajustes de cierre y estado inicial «pendiente de cierre»', async () => {
  const an = (await api.createReport(prep, { modality: 'anual', client_id: C1, title: 'Cierre 2026', fiscal_year: 2026, period_start: '2026-01-01', period_end: '2026-12-31' })).report;
  assert.equal(an.status, 'pendiente_cierre');
  await api.createAdjustment(prep, an.id, { kind: 'cierre', adj_date: '2026-12-31', concept: 'Asiento de cierre', account_code: '3101', credit: '10', reference: 'CI-1' });
  await rejects(api.createAdjustment(prep, an.id, { adj_date: '2027-01-02', concept: 'x', account_code: '1', debit: 1 }), 400, /fuera del período/);
  const d = await api.reportDetail(prep, an.id);
  assert.equal(d.adjustments.length, 1); assert.ok(!d.completeness.items.some(i => i.code === 'SIN_AJUSTES_CIERRE'));
  assert.deepEqual(d.transitions.map(t => t.to), ['en_revision']);
});

// ── Estados (Situación Financiera / Resultados / Flujo) ───────────────────────────────────────────
const JANV = {
  er: { serv_trabajos: { 1: '68123.27' }, financieros: { 1: '319.68' }, serv_prof: { 1: '5,000.00' } },
  esf: { efectivo: { 1: '0.06' }, cxc: { 1: '265788.19' }, capital: { 1: '100000' }, acumulados: { 1: '239231.20' } },
  efe: { res_anteriores: { 1: '239231.20' }, cc_cxc_accionistas: { 1: '-265788.19' }, fin_aportes: { 1: '100000' }, ef_inicio: { 1: '0' } },
};
let pk;
test('estados: crear proyectado, digitar enero y ver los totales del modelo', async () => {
  pk = (await api.createReport(prep, { modality: 'proyectado', client_id: C1, title: 'Proyectados 2026', scenario: 'Base', period_start: '2026-01-01', period_end: '2026-01-31' })).report;
  await rejects(api.putStatements(ro, pk.id, { values: JANV }), 403);
  await rejects(api.putStatements(prep, pk.id, { values: { er: { t_egresos: { 1: '5' } } } }), 400, /calcula Direct/);
  await rejects(api.putStatements(prep, pk.id, { values: { er: { financieros: { 1: '1.234,5' } } } }), 400, /coma decimal/);
  await rejects(api.putStatements(prep, pk.id, { values: { esf: { efectivo: { 0: '5' } } } }), 400, /anual/);
  const saved = await api.putStatements(prep, pk.id, { values: JANV });
  assert.equal(saved.saved, 11);
  const st = await api.getStatements(prep, pk.id);
  assert.equal(st.computed.er.t_egresos[1], 73442.95); assert.equal(st.computed.esf.t_pp[1], 265788.25); assert.equal(st.computed.efe.ef_final[1], 0.06);
  assert.equal(st.checks.filter(c => c.severity === 'blocking').length, 0);
  const d = await api.reportDetail(prep, pk.id);
  assert.ok(!d.completeness.items.some(i => i.code === 'SIN_SUPUESTOS'), 'las cifras de los estados cuentan como información cargada');
  const ver = (await api.getVersion(prep, pk.id, d.report.version)).version;
  assert.equal(ver.snapshot.statements.er.financieros['1'], 319.68, 'la versión guarda las cifras de los estados');
});

test('estados: un balance que no cuadra impide aprobar', async () => {
  await api.putStatements(prep, pk.id, { values: { esf: { capital: { 1: '90000' } } } });
  const d = await api.reportDetail(prep, pk.id);
  assert.ok(d.completeness.items.some(i => i.code === 'BALANCE_DESCUADRADO' && i.severity === 'blocking'));
  await api.transition(prep, pk.id, { to: 'en_revision' });
  await rejects(api.transition(apr, pk.id, { to: 'aprobado' }), 422, /pendientes/);
  await api.putStatements(prep, pk.id, { values: { esf: { capital: { 1: '100000' } } } });
  assert.equal((await api.reportDetail(prep, pk.id)).completeness.blocking, 0);
});

async function sheets(spec) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(spec)) { const ws = wb.addWorksheet(name); rows.forEach(r => ws.addRow(r)); }
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}
test('estados: importar el Excel del modelo (una hoja por estado) reconoce líneas, avisa de lo no reconocido y de totales distintos', async () => {
  const rep = (await api.createReport(prep, { modality: 'proyectado', client_id: C1, title: 'Proyectados Excel', scenario: 'Base', period_start: '2026-01-01', period_end: '2026-02-28' })).report;
  const file = await sheets({
    'Estado de Resultados': [['ESTADOS FINANCIEROS PROYECTADOS'], ['', 'ENERO', 'FEBRERO', 'TOTAL'], ['Ingresos por Ventas', '', 2143034.8, 2143034.8], ['Mano de Obra', '', 366462.59],
      ['Gastos por Servicios Trabajos y Suministros', 68123.27, 54103.86], ['Gastos Financieros', 319.68, 1444.65], ['Gastos Por Servicios Profesionales', 5000, 5000], ['Total de Gastos Generales y Adm', 73442.95, 99999.99], ['Gasto raro no existente', 10, 20]],
    'Estado de Situación Financiera': [['', 'ENERO', 'FEBRERO'], ['Efectivo en Caja', 0.06, 78635], ['Capital Social', 100000, 100000]],
  });
  const prev = await api.importStatements(prep, rep.id, { file_base64: file, file_name: 'modelo.xlsx' });
  assert.equal(prev.can_confirm, false, 'hay una fila sin reconocer'); assert.equal(prev.unmatched.length, 1); assert.equal(prev.unmatched[0].label, 'Gasto raro no existente');
  assert.equal(prev.sheets.length, 2);
  const diff = prev.total_diffs.find(x => x.line === 't_egresos' && x.month === 2); assert.ok(diff && !diff.rounding, 'el total de febrero del archivo no coincide con la suma de sus líneas');
  assert.equal(prev.total_diffs.find(x => x.line === 't_egresos' && x.month === 1), undefined, 'enero sí coincide');
  await rejects(api.importStatements(prep, rep.id, { file_base64: file, file_name: 'modelo.xlsx', confirm: true }), 422, /sin reconocer/);
  const ok = await api.importStatements(prep, rep.id, { file_base64: file, file_name: 'modelo.xlsx', confirm: true, allow_unmatched: true });
  assert.ok(ok.saved >= 9); assert.equal(fake.db.tables.fin_imports.filter(i => i.kind === 'statements').length, 1);
  const st = await api.getStatements(prep, rep.id);
  assert.equal(st.computed.er.t_ingresos[2], 2143034.8); assert.equal(st.computed.er.t_egresos[1], 73442.95); assert.equal(st.computed.esf.efectivo[0], 78635, 'anual del balance = último mes');
  assert.equal(st.computed.er.t_ingresos[0], 2143034.8, 'anual de resultados = suma de meses');
  await rejects(api.importStatements(prep, rep.id, { file_base64: Buffer.from('a,b\n1,2').toString('base64'), file_name: 'x.csv' }), 400, /qué estado/);
});

test('estados: líneas propias, paquete (portada, informe, estados) y Excel con los estados', async () => {
  await api.putStatements(prep, pk.id, { custom_lines: [{ statement: 'esf', key: 'c_inventario', label: 'Inventario', parent: 't_act_cte' }], values: { esf: { c_inventario: { 1: '10' }, capital: { 1: '100010' } } } });
  await rejects(api.putStatements(prep, pk.id, { custom_lines: [{ statement: 'esf', key: 'c_x1y2', label: 'X', parent: 't_act' }] }), 400, /sección/);
  assert.equal((await api.getStatements(prep, pk.id)).computed.esf.t_act_cte[1], 265798.25);
  await api.putConfig(ctd, { config: { firm: { name: 'SAVE CONSULTORES SRL', address: 'Cruce de Verón', signer: { name: 'Licda. Ejemplo', icpard: '1234', city: 'Verón' } } } });
  await api.updatePackage(prep, pk.id, { fecha_informe: '2026-10-13', firmante_titulo: 'Contador Público' });
  const pkg = await api.getPackage(prep, pk.id);
  assert.equal(pkg.title, 'ESTADOS FINANCIEROS PROYECTADOS DEL 01 DE ENERO AL 31 DE ENERO DEL AÑO 2026');
  assert.equal(pkg.range_text, 'DESDE EL 01 DE ENERO AL 31 DE ENERO 2026'); assert.equal(pkg.currency_label, 'DOP$');
  assert.match(pkg.informe, /Empresa Uno SRL, con RNC No\. 131-00000-1 comprendido del 01 de enero al 31 de enero del año 2026/); assert.match(pkg.informe, /Informe Financiero Proyectado que se compone/); assert.match(pkg.informe, /Estados Financieros Proyectados de Empresa Uno SRL/);
  assert.equal(pkg.signer.nombre, 'Licda. Ejemplo'); assert.equal(pkg.signer.titulo, 'Contador Público'); assert.equal(pkg.signer.fecha, '13 de octubre de 2026'); assert.equal(pkg.firm.name, 'SAVE CONSULTORES SRL');
  const { file } = await api.exportReport(prep, pk.id);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(file.base64, 'base64'));
  assert.ok(wb.getWorksheet('Situación financiera') && wb.getWorksheet('Resultados') && wb.getWorksheet('Flujo de efectivo'));
  assert.equal(wb.getWorksheet('Resultados').getRow(5).getCell(3).value, 'ENERO');
});
