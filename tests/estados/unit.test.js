const test = require('node:test');
const assert = require('node:assert/strict');
const imp = require('../../lib/estados/import');
const rules = require('../../lib/estados/rules');
const { assess, accountSummary } = require('../../lib/estados/completeness');

test('importes: punto decimal, comas ambiguas y negativos', () => {
  assert.equal(imp.parseAmount('1,234.50').value, 1234.5);
  assert.equal(imp.parseAmount('RD$ 10').value, 10);
  assert.match(imp.parseAmount('1.234,56').error, /coma decimal/);
  assert.match(imp.parseAmount('12,5').error, /coma decimal/);
  assert.match(imp.parseAmount('-5').error, /negativo/);
  assert.equal(imp.parseAmount('-5', { allowNegative: true }).value, -5);
  assert.equal(imp.parseAmount('(5)', { allowNegative: true }).value, -5);
  assert.match(imp.parseAmount('abc').error, /no es un importe/);
  assert.equal(imp.parseAmount('').value, null);
});

test('asociación de columnas: alias y encabezado no en la primera fila', () => {
  const rows = [['Libro mayor 2026'], ['Fecha', 'Cuenta', 'Descripción', 'Debe', 'Haber'], ['2026-01-01', '1101', 'x', '5', '']];
  const idx = imp.findHeaderRow(rows, 'interino');
  assert.equal(idx, 1);
  const m = imp.suggestMapping(rows[idx], 'interino');
  assert.deepEqual([m.entry_date, m.account_code, m.concept, m.debit, m.credit], [0, 1, 2, 3, 4]);
  assert.equal(imp.validate(rows, idx, m, { modality: 'interino', currency: 'DOP' }).total, 0);
});

test('validación: columnas obligatorias sin asociar, moneda, empresa y período', () => {
  const rows = [['Fecha', 'Cuenta', 'Débito', 'Moneda', 'Empresa', 'Período'], ['2026-10-05', '1', '5', 'USD', '999999999', '202611']];
  const m = imp.suggestMapping(rows[0], 'interino');
  const r = imp.validate(rows, 0, m, { modality: 'interino', currency: 'DOP', client_rnc: '131000001' });
  const msgs = r.errors.map(e => e.field);
  assert.ok(msgs.includes('Moneda') && msgs.includes('Empresa') && msgs.includes('Período'));
  const noMap = imp.validate(rows, 0, { ...m, account_code: null }, { modality: 'interino', currency: 'DOP' });
  assert.match(noMap.errors[0].message, /columna obligatoria/);
});

test('cuadre: por asiento, global y ninguna', () => {
  const e = [{ reference: 'A', debit: 10, credit: 0 }, { reference: 'A', debit: 0, credit: 10 }, { reference: 'B', debit: 5, credit: 0 }, { debit: 3, credit: 0 }];
  const a = imp.balanceCheck(e, { rule: 'por_asiento' });
  assert.equal(a.ok, false); assert.equal(a.issues[0].reference, 'B'); assert.equal(a.without_reference, 1);
  assert.equal(imp.balanceCheck(e, { rule: 'global' }).ok, false);
  assert.equal(imp.balanceCheck(e, { rule: 'ninguna' }).applied, false);
  assert.equal(imp.balanceCheck([{ reference: 'A', debit: 10.004, credit: 10 }], { rule: 'por_asiento', tolerance: 0.01 }).ok, true);
});

test('CSV: delimitador, comillas y BOM', async () => {
  const t = await imp.readTable(Buffer.from('﻿Fecha;Cuenta;Débito\n2026-10-05;"11;01";5\n'), 'a.csv');
  assert.deepEqual(t.rows[1], ['2026-10-05', '11;01', '5']);
  await assert.rejects(() => imp.readTable(Buffer.from('x'), 'a.xls'), /\.xlsx/);
});

test('permisos por rol y overrides (team_manage nunca se otorga)', () => {
  assert.deepEqual([...rules.permissionsFor('lectura')], ['view']);
  assert.ok(rules.permissionsFor('preparador').has('proyectados_edit') && !rules.permissionsFor('preparador').has('approve'));
  assert.ok(rules.permissionsFor('aprobador').has('approve') && !rules.permissionsFor('aprobador').has('close_reopen'));
  assert.ok(rules.permissionsFor('contador').has('templates_manage'));
  const p = rules.permissionsFor('lectura', { approve: true, team_manage: true, view: false });
  assert.ok(p.has('approve') && !p.has('team_manage') && p.has('view'));
});

test('flujo: legalización apagada por defecto y reapertura vuelve a observado', () => {
  const cfg = rules.mergeConfig({});
  assert.ok(!cfg.states.anual.includes('pendiente_legalizacion'));
  const t = rules.transitionsFor('interino', cfg.states.interino);
  assert.ok(t.some(x => x.from === 'aprobado' && x.to === 'observado' && x.reopen && x.reason));
  assert.ok(!t.some(x => x.to === 'pendiente_legalizacion'));
  assert.equal(rules.INITIAL_STATE.anual, 'pendiente_cierre');
  const on = rules.mergeConfig({ legalizacion: { enabled: true }, states: { anual: [...cfg.states.anual, 'pendiente_legalizacion'] } });
  assert.ok(rules.transitionsFor('anual', on.states.anual).some(x => x.to === 'pendiente_legalizacion'));
});

test('completitud: documentos obligatorios y clasificación parcial bloquean; sin cifras inventadas', () => {
  const cfg = rules.mergeConfig({});
  const base = { client_id: 'c', currency: 'DOP', period_start: '2026-10-01', period_end: '2026-10-31', modality: 'interino', documents: [{ key: 'b', label: 'Balance', required: true, status: 'pendiente' }] };
  const entries = [{ entry_date: '2026-10-31', account_code: '1', debit: 5, credit: 0, reference: 'A', classification: 'x' }, { entry_date: '2026-10-31', account_code: '2', debit: 0, credit: 5, reference: 'A' }];
  const r = assess(base, { entries }, cfg);
  const codes = r.items.filter(i => i.severity === 'blocking').map(i => i.code).sort();
  assert.deepEqual(codes, ['DOCUMENTOS_PENDIENTES', 'SIN_CLASIFICAR']);
  assert.equal(accountSummary(entries).length, 2);
});
