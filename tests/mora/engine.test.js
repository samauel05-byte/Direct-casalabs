const test = require('node:test');
const assert = require('node:assert/strict');
const { calcular, porAnio, tasaMensual, vencimiento, addMonths, parseDate } = require('../../public/mora/js/engine');

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

test('recargos: 10 % + 4 % por mes adicional (régimen anterior); tope solo si el régimen lo trae', () => {
  assert.equal(calcular({ capital: 1000, tasa: 1.1, desde: '2026-01-01', hasta: '2026-01-20', recargos: true }).recargoPct, 10);
  assert.equal(calcular({ capital: 1000, tasa: 1.1, desde: '2026-01-01', hasta: '2026-04-01', recargos: true }).recargoPct, 18);
  const sin = calcular({ capital: 1000, tasa: 1.1, desde: '2024-01-01', hasta: '2026-01-01', recargos: true });
  assert.equal(sin.recargoPct, 10 + 4 * 23); assert.equal(sin.recargo, 1020);
  const con = calcular({ capital: 1000, tasa: 1.1, desde: '2024-01-01', hasta: '2026-01-01', recargos: true, regimenes: [{ desde: '1992-01-01', primerMes: 10, adicional: 4, tope: 100 }] });
  assert.equal(con.recargoPct, 100); assert.equal(con.recargo, 1000);
  assert.equal(calcular({ capital: 1000, tasa: 1.1, desde: '2026-01-01', hasta: '2026-04-01' }).recargo, 0);
});

test('recargo e interés indemnizatorio van por separado en cada mes', () => {
  const r = calcular({ capital: 100000, tasa: 1.1, desde: '2026-01-15', hasta: '2026-04-15', recargos: true });
  assert.deepEqual(r.rows.map(x => x.recargoPct), [10, 14, 18]);
  assert.deepEqual(r.rows.map(x => x.recargoAcum), [10000, 14000, 18000]);
  assert.equal(r.rows[2].acumulado, 3336.43); // el interés no incluye el recargo
  assert.equal(r.total, 100000 + 3336.43 + 18000);
});

test('valida los datos y no inventa resultados', () => {
  assert.ok(calcular({ capital: 0, tasa: 1.1, desde: '2026-01-01', hasta: '2026-02-01' }).errores.length);
  assert.ok(calcular({ capital: 10, tasa: 1.1, desde: '2026-02-01', hasta: '2026-01-01' }).errores.length);
  assert.ok(calcular({ capital: 10, tasa: 1.1, desde: 'x', hasta: '2026-01-01' }).errores.length);
});

test('vista por año: suma el interés de cada año calendario y deja el saldo al cierre', () => {
  const r = calcular({ capital: 100000, tasa: 1, desde: '2025-11-15', hasta: '2026-03-15', recargos: true });
  const a = porAnio(r.rows);
  assert.deepEqual(a.map(x => [x.anio, x.meses]), [[2025, 2], [2026, 2]]);
  assert.equal(a[0].interes, Math.round((r.rows[0].interes + r.rows[1].interes) * 100) / 100);
  assert.equal(a[1].saldoFinal, r.rows[3].saldoFinal); assert.equal(a[1].acumulado, r.intereses); assert.equal(a[1].recargoPct, 22);
  assert.equal(Math.round((a[0].interes + a[1].interes) * 100) / 100, r.intereses);
});

test('tasa anual se convierte a mensual (anual / 12)', () => {
  assert.equal(tasaMensual(12, 'anual'), 1); assert.equal(tasaMensual(1, 'mensual'), 1);
});

// Casos reales de la calculadora de la DGII (consultados el 14-nov-2026; pago previsto 20/11/2026, impuesto RD$100,000).
const DGII = [
  { n: 'ITBIS 03/2023', v: '2023-04-20', meses: 43, recargo: 162000, interes: 47300, total: 309300 },
  { n: 'ITBIS 03/2026', v: '2026-04-21', meses: 7, recargo: 30000, interes: 7700, total: 137700 },
  { n: 'IR-2 12/2024', v: '2025-04-30', meses: 19, recargo: 77000, interes: 20900, total: 197900 },
  { n: 'IR-1 12/2024', v: '2025-03-31', meses: 20, recargo: 81000, interes: 22000, total: 203000 },
];
for (const c of DGII) {
  test('coincide con la calculadora de la DGII: ' + c.n, () => {
    const r = calcular({ capital: 100000, tasa: 1.1, desde: c.v, hasta: '2026-11-20', modo: 'simple', recargos: true });
    assert.equal(r.meses, c.meses); assert.equal(r.recargo, c.recargo); assert.equal(r.intereses, c.interes); assert.equal(r.total, c.total);
  });
}

test('fecha de vencimiento por impuesto (ITBIS día 20 del mes siguiente, IR-1 31 de marzo, IR-2 120 días tras el cierre)', () => {
  assert.equal(vencimiento('ITB', 3, 2023), '2023-04-20'); assert.equal(vencimiento('ITB', 12, 2024), '2025-01-20');
  assert.equal(vencimiento('IR1', 12, 2024), '2025-03-31'); assert.equal(vencimiento('IR2', 12, 2024), '2025-04-30');
  assert.equal(vencimiento('IR2', 6, 2025), '2025-10-28'); assert.equal(vencimiento('XX', 1, 2025), null);
});
