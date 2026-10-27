const test = require('node:test');
const assert = require('node:assert');
const E = require('../../public/conciliacion/engine.js');

test('montos: formatos dominicanos y de banco', () => {
  assert.strictEqual(E.parseAmount('1,234.56'), 123456);
  assert.strictEqual(E.parseAmount('1.234,56'), 123456);
  assert.strictEqual(E.parseAmount('RD$ 12,000.00'), 1200000);
  assert.strictEqual(E.parseAmount('(500.00)'), -50000);
  assert.strictEqual(E.parseAmount('-45.5'), -4550);
  assert.strictEqual(E.parseAmount('250.00 DB'), -25000);
  assert.strictEqual(E.parseAmount('250.00 CR'), 25000);
  assert.strictEqual(E.parseAmount('1,000'), 100000);
  assert.strictEqual(E.parseAmount(75.1), 7510);
  assert.strictEqual(E.parseAmount('abc'), null);
  assert.strictEqual(E.parseAmount(''), null);
});

test('fechas: dd/mm/yyyy, ISO y serial de Excel', () => {
  assert.strictEqual(E.parseDate('05/10/2026'), '2026-10-05');
  assert.strictEqual(E.parseDate('2026-10-05'), '2026-10-05');
  assert.strictEqual(E.parseDate('5-10-26'), '2026-10-05');
  assert.strictEqual(E.parseDate(46300), '2026-10-05');
  assert.strictEqual(E.parseDate('99/99/2026'), null);
});

const mk = (id, date, amount, ref = '', desc = '') => ({ id, line: +id.slice(1), date, amount, ref, desc });

test('concilia por monto+referencia, monto+fecha y marca fecha distinta para revisar', () => {
  const bank = [mk('B1', '2026-10-01', -100000, '1234', 'CHEQUE 1234'), mk('B2', '2026-10-02', 250000, '', 'DEPOSITO'), mk('B3', '2026-10-05', -75000, '', 'TRANSF ACME'), mk('B4', '2026-10-09', 99900, '', 'X')];
  const book = [mk('L1', '2026-10-03', -100000, '1234', 'Pago proveedor'), mk('L2', '2026-10-02', 250000, '', 'Depósito cliente'), mk('L3', '2026-10-07', -75000, '', 'Pago ACME'), mk('L4', '2026-10-20', 55500, '', 'Otro')];
  const r = E.reconcile(bank, book, { dayTol: 3 });
  const st = id => r.pairs.find(p => p.bank.id === id);
  assert.strictEqual(st('B1').status, 'auto');          // misma referencia aunque 2 días de diferencia
  assert.strictEqual(st('B2').status, 'auto');          // mismo monto y fecha
  assert.strictEqual(st('B3').status, 'review');        // 2 días y sin referencia
  assert.strictEqual(r.onlyBank.length, 1); assert.strictEqual(r.onlyBank[0].id, 'B4');
  assert.strictEqual(r.onlyBook.length, 1); assert.strictEqual(r.onlyBook[0].id, 'L4');
});

test('una pareja es 1 a 1 y montos repetidos se marcan para revisión', () => {
  const bank = [mk('B1', '2026-10-01', -5000), mk('B2', '2026-10-01', -5000)];
  const book = [mk('L1', '2026-10-01', -5000)];
  const r = E.reconcile(bank, book);
  assert.strictEqual(r.pairs.length, 1);
  assert.strictEqual(r.onlyBank.length, 1);
  assert.strictEqual(r.pairs[0].status, 'review');
});

test('detecta duplicados y separa cargos bancarios', () => {
  const bank = [mk('B1', '2026-10-01', -5000, '', 'COMISION MANEJO'), mk('B2', '2026-10-01', -1500, '', 'IMPUESTO 0.15% LEY 288-04'), mk('B3', '2026-10-02', 7000, '', 'DEP'), mk('B4', '2026-10-02', 7000, '', 'DEP')];
  const book = [mk('L1', '2026-10-02', 7000, '', 'Dep')];
  const r = E.reconcile(bank, book);
  assert.strictEqual(r.fees.length, 2);
  assert.strictEqual(r.duplicates.bank.length, 1);
  const s = E.summarize(r);
  assert.strictEqual(s.cargos, 2); assert.strictEqual(s.montoCargos, -6500);
});

test('normaliza filas con débito/crédito y signo del libro', () => {
  const rows = [['01/10/2026', 'Pago', '77', '1,000.00', ''], ['02/10/2026', 'Cobro', '', '', '2,500.00'], ['xx', '', '', '', '']];
  const map = { fecha: 0, desc: 1, ref: 2, debito: 3, credito: 4 };
  const { rows: out } = E.normalizeRows(rows, map);
  assert.deepStrictEqual(out.map(r => r.amount), [-100000, 250000]);
  assert.deepStrictEqual(E.normalizeRows(rows, map, { signo: -1 }).rows.map(r => r.amount), [100000, -250000]);
});

test('adivina columnas y fila de encabezado', () => {
  const rows = [['Banco X'], [], ['Fecha', 'Descripción', 'Referencia', 'Débito', 'Crédito', 'Balance'], ['01/10/2026', 'a', '1', '5.00', '', '10']];
  const hi = E.findHeaderRow(rows); assert.strictEqual(hi, 2);
  const m = E.guessMap(rows[hi]);
  assert.deepStrictEqual([m.fecha, m.desc, m.ref, m.debito, m.credito], [0, 1, 2, 3, 4]);
});
