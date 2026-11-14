const test = require('node:test');
const assert = require('node:assert/strict');
const { calcular, addMonths, parseDate } = require('../../public/mora/js/engine');

test('interés compuesto mes a mes y acumulativo (3 meses, 1.10 %)', () => {
  const r = calcular({ capital: 100000, tasa: 1.1, desde: '2026-01-15', hasta: '2026-04-15', modo: 'compuesto' });
  assert.deepEqual(r.errores, []);
  assert.equal(r.meses, 3);
  assert.deepEqual(r.rows.map(x => x.interes), [1100.00, 1112.10, 1124.33]);
  assert.deepEqual(r.rows.map(x => x.saldoFinal), [101100.00, 102212.10, 103336.43]);
  assert.equal(r.rows[2].acumulado, 3336.43);
  assert.equal(r.intereses, 3336.43); assert.equal(r.total, 103336.43);
  assert.equal(r.rows[1].saldoInicial, 101100.00);
});

test('modo simple: el interés no se capitaliza', () => {
  const r = calcular({ capital: 100000, tasa: 1.1, desde: '2026-01-15', hasta: '2026-04-15', modo: 'simple' });
  assert.deepEqual(r.rows.map(x => x.interes), [1100, 1100, 1100]); assert.equal(r.total, 103300);
});

test('mes o fracción cuenta como mes completo; prorrata usa los días', () => {
  const a = calcular({ capital: 10000, tasa: 2, desde: '2026-01-01', hasta: '2026-02-15', fraccion: 'completo' });
  assert.equal(a.meses, 2); assert.equal(a.rows[1].factor, 1); assert.equal(a.rows[1].completo, false);
  const b = calcular({ capital: 10000, tasa: 2, desde: '2026-01-01', hasta: '2026-02-15', fraccion: 'prorrata' });
  assert.equal(b.rows[1].dias, 14); assert.equal(b.rows[1].factor, 0.5); assert.equal(b.rows[1].interes, 102.00);
});

test('fin de mes: 31 ene + 1 mes = 28 feb, sin arrastrar el día', () => {
  assert.equal(addMonths(parseDate('2026-01-31'), 1).toISOString().slice(0, 10), '2026-02-28');
  assert.equal(addMonths(parseDate('2026-01-31'), 2).toISOString().slice(0, 10), '2026-03-31');
});

test('recargos opcionales: 10 % + 4 % por mes adicional; tope solo si se indica', () => {
  assert.equal(calcular({ capital: 1000, tasa: 1.1, desde: '2026-01-01', hasta: '2026-01-20', recargos: true }).recargoPct, 10);
  assert.equal(calcular({ capital: 1000, tasa: 1.1, desde: '2026-01-01', hasta: '2026-04-01', recargos: true }).recargoPct, 18);
  const sin = calcular({ capital: 1000, tasa: 1.1, desde: '2024-01-01', hasta: '2026-01-01', recargos: true });
  assert.equal(sin.recargoPct, 10 + 4 * 23); assert.equal(sin.recargo, 1020);
  const con = calcular({ capital: 1000, tasa: 1.1, desde: '2024-01-01', hasta: '2026-01-01', recargos: true, topeRecargo: 100 });
  assert.equal(con.recargoPct, 100); assert.equal(con.recargo, 1000);
  assert.equal(calcular({ capital: 1000, tasa: 1.1, desde: '2026-01-01', hasta: '2026-04-01' }).recargo, 0);
});

test('valida los datos y no inventa resultados', () => {
  assert.ok(calcular({ capital: 0, tasa: 1.1, desde: '2026-01-01', hasta: '2026-02-01' }).errores.length);
  assert.ok(calcular({ capital: 10, tasa: 1.1, desde: '2026-02-01', hasta: '2026-01-01' }).errores.length);
  assert.ok(calcular({ capital: 10, tasa: 1.1, desde: 'x', hasta: '2026-01-01' }).errores.length);
});
