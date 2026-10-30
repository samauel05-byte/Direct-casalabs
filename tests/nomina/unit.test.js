const test = require('node:test');
const assert = require('node:assert/strict');
const { compile, validate, round2 } = require('../../lib/nomina/formula');

test('fórmula: aritmética y precedencia', () => {
  assert.equal(compile('2 + 3 * 4').evaluate(), 14);
  assert.equal(compile('(2 + 3) * 4').evaluate(), 20);
  assert.equal(compile('-5 + 2').evaluate(), -3);
  assert.equal(compile('10 / 4').evaluate(), 2.5);
  assert.equal(compile('10 / 0').evaluate(), 0, 'división por cero → 0, nunca NaN/Infinity');
});

test('fórmula: referencias a columnas y refs detectadas', () => {
  const f = compile('sueldo + horas_extra * 1.35');
  assert.deepEqual(f.refs.sort(), ['horas_extra', 'sueldo']);
  assert.equal(f.evaluate({ sueldo: 20000, horas_extra: 10 }), 20013.5);
  assert.equal(compile('falta_clave + 5').evaluate({}), 5, 'columna ausente cuenta como 0');
});

test('fórmula: funciones permitidas', () => {
  assert.equal(compile('round(10.004, 2)').evaluate(), 10);
  assert.equal(compile('round(1234.5678, 2)').evaluate(), 1234.57);
  assert.equal(compile('max(1, 9, 4)').evaluate(), 9);
  assert.equal(compile('min(sueldo, 5000)').evaluate({ sueldo: 3000 }), 3000);
  assert.equal(compile('abs(0 - 7)').evaluate(), 7);
});

test('fórmula: rechaza entradas peligrosas o mal formadas (nunca ejecuta código)', () => {
  assert.throws(() => compile('process.exit(1)'), /no permitido|desconocida|mal formada/i);
  assert.throws(() => compile('a => 1'), /no permitido|mal formada|Sobran/i);
  assert.throws(() => compile('2 +'), /incompleta|mal formada/i);
  assert.throws(() => compile('(2 + 3'), /incompleta|mal formada/i);
  assert.throws(() => compile(''), /vac/i);
  assert.throws(() => compile('1.2.3'), /inválido|Número/i);
  assert.throws(() => compile('"drop"'), /no permitido/i);
});

test('fórmula: validate() con columnas conocidas', () => {
  assert.equal(validate('sueldo * 2', ['sueldo']).ok, true);
  const bad = validate('sueldo + bono', ['sueldo']);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /no existen|bono/);
  assert.equal(validate('1 +', null).ok, false);
});

test('round2: redondeo monetario a 2 decimales', () => {
  assert.equal(round2(10.005), 10.01);
  assert.equal(round2(1234.5), 1234.5);
  assert.equal(round2('abc'), 0);
});

const { computePeriod, computeRow } = require('../../lib/nomina/compute');

const COLS = [
  { key: 'sueldo', type: 'monto', sign: 1, include_total: true, position: 1 },
  { key: 'horas_extra', type: 'numero', sign: 0, include_total: false, position: 2 },
  { key: 'pago_extra', type: 'formula', formula: 'horas_extra * (sueldo / 23.83 / 8) * 1.35', sign: 1, include_total: true, position: 3 },
  { key: 'afp', type: 'formula', formula: 'round((sueldo + pago_extra) * 0.0287, 2)', sign: -1, include_total: true, position: 4 },
  { key: 'nota', type: 'texto', sign: 0, include_total: false, position: 5 },
];

test('compute: fila con fórmulas en cadena, ingresos/deducciones/neto', () => {
  const r = computeRow(COLS, { sueldo: 20000, horas_extra: 0, nota: 'ok' });
  assert.equal(r.cells.sueldo, 20000);
  assert.equal(r.cells.pago_extra, 0);
  assert.equal(r.cells.afp, 574, 'AFP = 20000*0.0287 = 574');
  assert.equal(r.cells.nota, 'ok');
  assert.equal(r.ingresos, 20000);
  assert.equal(r.deducciones, 574);
  assert.equal(r.neto, 19426);
});

test('compute: totales por columna y resumen del período', () => {
  const emps = [{ id: 'e1' }, { id: 'e2' }];
  const entries = [
    { employee_id: 'e1', values: { sueldo: 20000, horas_extra: 0 } },
    { employee_id: 'e2', values: { sueldo: 10000, horas_extra: 0 } },
  ];
  const out = computePeriod(COLS, emps, entries);
  assert.equal(out.rows.length, 2);
  assert.equal(out.totals.sueldo, 30000);
  assert.equal(out.totals.afp, round2(574 + 287));
  assert.equal(out.summary.ingresos, 30000);
  assert.equal(out.summary.deducciones, round2(574 + 287));
  assert.equal(out.summary.neto, round2(30000 - 574 - 287));
});

test('compute: empleado sin valores no rompe (columnas ausentes = 0)', () => {
  const out = computePeriod(COLS, [{ id: 'e1' }], []);
  assert.equal(out.rows[0].neto, 0);
  assert.equal(out.summary.neto, 0);
});

const { paramsFromSettings } = require('../../lib/nomina/compute');
test('compute: fórmulas con tasas de ajustes (p_*)', () => {
  const st = { period_type:'quincenal', empleado:{afp:0.0287,sfs:0.0304,tope_sfs:134820,tope_afp:404460}, isr:{exento:416220,tramo2:624329,tramo3:867123}, empleador:{} };
  const p = paramsFromSettings(st);
  assert.equal(p.p_div, 2); assert.equal(p.p_afp, 0.0287);
  const cols=[{key:'sueldo',type:'monto',sign:0,include_total:false,position:1},{key:'afp',type:'formula',formula:'round(sueldo*p_afp/p_div,2)',sign:-1,include_total:true,position:2}];
  const r = computeRow(cols, {sueldo:55000}, p);
  assert.equal(r.cells.afp, 789.25, 'AFP quincenal 55000*0.0287/2');
  // período mensual: divisor 1
  const pm = paramsFromSettings({ ...st, period_type:'mensual' });
  assert.equal(computeRow(cols, {sueldo:55000}, pm).cells.afp, 1578.5);
});

test('imponible: «Otros (+)» no se duplica cuando se cobra el mes entero', () => {
  // Misma fórmula de las empresas: con cobra_entero=1 el período ya trae el mes completo,
  // así que el extra no se multiplica por p_div (antes salía 113,806.16 en vez de 65,606.40).
  const imp = compile('round(sueldo_mensual-(sfs+pension)*p_div/(1+cobra_entero)+otros_mas*p_div/(1+cobra_entero),2)');
  const sfs = 562.40, pension = 530.96;
  const base = { sueldo_mensual: 18500, sfs, pension, p_div: 2, otros_mas: 48199.76 };
  assert.equal(imp.evaluate({ ...base, cobra_entero: 1 }), 65606.4);
  // Quincenal normal (cobra_entero=0): el extra se sigue anualizando como siempre.
  assert.equal(imp.evaluate({ ...base, sfs: 304, pension: 287, otros_mas: 591, sueldo_mensual: 20000, cobra_entero: 0 }), 20000 - (304 + 287) * 2 + 591 * 2);
});
