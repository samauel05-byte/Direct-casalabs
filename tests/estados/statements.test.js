// Motor de los estados: reproduce el modelo «Estados Financieros Proyectados» de ACINGENIERIA SRL (Save Consultores).
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../public/estados/js/statements-engine.js');

// Enero 2026 tal como se imprime en las hojas mensuales del modelo.
const JAN = {
  er: { serv_trabajos: { 1: 68123.27 }, financieros: { 1: 319.68 }, serv_prof: { 1: 5000 } },
  esf: { efectivo: { 1: 0.06 }, cxc: { 1: 265788.19 }, capital: { 1: 100000 }, acumulados: { 1: 239231.2 } },
  efe: { res_anteriores: { 1: 239231.2 }, cc_cxc_accionistas: { 1: -265788.19 }, fin_aportes: { 1: 100000 }, ef_inicio: { 1: 0 } },
};

test('meses de las columnas a partir del período', () => {
  const m = S.monthsFor('2026-01-01', '2026-12-31'); assert.equal(m.length, 12); assert.equal(m[0].label, 'ENERO'); assert.equal(m[11].label, 'DICIEMBRE');
  assert.equal(S.monthsFor('2026-07-01', '2027-06-30')[6].key, '2027-01');
});

test('enero del modelo: estado de resultados, balance y flujo cuadran con lo impreso', () => {
  const c = S.compute(JAN, 1);
  assert.equal(c.er.t_egresos[1], 73442.95); assert.equal(c.er.resultado[1], -73442.95); assert.equal(c.er.margen[1], null, 'sin ingresos ni costos cargados no se inventa un 0');
  assert.equal(c.esf.t_act_cte[1], 265788.25); assert.equal(c.esf.t_act[1], 265788.25);
  assert.equal(c.esf.t_pat[1], 265788.25, 'capital + acumulados + resultado del período');
  assert.equal(c.esf.t_pp[1], 265788.25);
  assert.equal(c.efe.t_noafecta[1], 239231.2); assert.equal(c.efe.t_cambios[1], -265788.19);
  assert.equal(c.efe.flujo_ops[1], -99999.94); assert.equal(c.efe.aumento[1], 0.06); assert.equal(c.efe.ef_final[1], 0.06);
  assert.deepEqual(S.checks(c, JAN, 1, S.monthsFor('2026-01-01', '2026-01-31')).filter(i => i.severity === 'blocking'), []);
});

test('el efectivo inicial de cada mes es el final del anterior y el acumulado del resultado corre', () => {
  const v = JSON.parse(JSON.stringify(JAN));
  v.er.ing_ventas = { 2: 2143034.8 }; v.er.mano_obra = { 2: 366462.59 };
  v.efe.fin_aportes[2] = 0; v.efe.cc_cxc_accionistas[2] = 0;
  const c = S.compute(v, 2);
  assert.equal(c.efe.ef_inicio[2], c.efe.ef_final[1]); assert.equal(c.er.resultado_acum[2], r(c.er.resultado[1] + c.er.resultado[2]));
  function r(x) { return Math.round(x * 100) / 100; }
});

test('columna anual: balance = último mes, resultados = suma, acumulados = primer mes', () => {
  const v = { er: { ing_ventas: { 1: 100, 2: 50.5 }, mano_obra: { 1: 40, 2: 10 } }, esf: { efectivo: { 1: 1, 2: 7 }, acumulados: { 1: 239231.2, 2: 100 }, capital: { 1: 5, 2: 5 } }, efe: {} };
  const c = S.compute(v, 2);
  assert.equal(c.er.t_ingresos[0], 150.5); assert.equal(c.er.resultado[0], 100.5);
  assert.equal(c.esf.efectivo[0], 7); assert.equal(c.esf.acumulados[0], 239231.2);
  assert.equal(c.esf.res_periodo[0], 100.5, 'el resultado del período anual sale del Estado de Resultados');
});

test('balance descuadrado se marca como bloqueante; sin datos no se inventa nada', () => {
  const v = { er: {}, esf: { efectivo: { 1: 100 }, capital: { 1: 90 } }, efe: {} };
  const c = S.compute(v, 1);
  const bl = S.checks(c, v, 1, S.monthsFor('2026-01-01', '2026-01-31')).filter(i => i.severity === 'blocking');
  assert.equal(bl.length, 1); assert.match(bl[0].message, /no cuadra/);
  const empty = S.compute({}, 3);
  assert.equal(empty.esf.t_act[1], null); assert.equal(empty.er.resultado[0], null);
});

test('líneas propias se suman al total de su sección', () => {
  const customs = [{ statement: 'esf', key: 'c_inventario', label: 'Inventario', parent: 't_act_cte' }];
  const v = { esf: { efectivo: { 1: 10 }, c_inventario: { 1: 5 } } };
  const c = S.compute(v, 1, customs);
  assert.equal(c.esf.t_act_cte[1], 15);
  const keys = S.template('esf', customs).lines.map(l => l.k); assert.ok(keys.indexOf('c_inventario') > keys.indexOf('obras') && keys.indexOf('c_inventario') < keys.indexOf('t_act_cte'));
});

test('reconocimiento de etiquetas del Excel (anual y mensual) y de las hojas', () => {
  assert.equal(S.matchLabel('er', 'Ingresos por Ventas').k, 'ing_ventas');
  assert.equal(S.matchLabel('er', 'UTILIDAD BRUTA').k, 'margen');
  assert.equal(S.matchLabel('er', 'Total de Gastos Generales y Adm').k, 't_egresos');
  assert.equal(S.matchLabel('efe', 'Resultado del Período').k, 'resultado');
  assert.equal(S.matchLabel('esf', 'Total de Activo Corriente').k, 't_act_cte');
  assert.equal(S.matchLabel('esf', 'Algo que no existe'), null);
  assert.equal(S.detectStatement('Estado de Situación Financiera'), 'esf'); assert.equal(S.detectStatement('ESTADO DE RESULTADO'), 'er'); assert.equal(S.detectStatement('Flujo de Efectivo'), 'efe');
  assert.equal(S.monthFromHeader('SEPTIEMBRE'), 9); assert.equal(S.monthFromHeader('Ene'), 1); assert.equal(S.monthFromHeader('TOTAL'), null);
});

test('totales del modelo anual (ACINGENIERIA 2026) con las cifras impresas', () => {
  // Estado de Resultados anual (una sola columna): las líneas impresas suman lo impreso (salvo 0.01 de redondeo del Excel).
  const v = { er: { ing_ventas: { 1: 13513097.76 }, mano_obra: { 1: 4397551.04 }, costos_directos: { 1: 810785.87 }, costos_indirectos: { 1: 540523.91 }, supervision: { 1: 2198775.52 },
    serv_trabajos: { 1: 675741.84 }, financieros: { 1: 15545.07 }, serv_prof: { 1: 60000 } }, esf: {}, efe: {} };
  const c = S.compute(v, 1);
  assert.equal(c.er.t_costo[0], 7947636.34); assert.equal(c.er.margen[0], 5565461.42); assert.equal(c.er.t_egresos[0], 751286.91);
  assert.ok(Math.abs(c.er.resultado[0] - 4814174.52) <= 0.011, 'impreso 4,814,174.52 (el Excel redondea un centavo)');
  // Balance: 100,000 + 239,231.20 + 4,814,174.52 = 5,153,405.72 = 1,756,090.03 + 3,397,315.69
  const b = S.compute({ er: {}, esf: { efectivo: { 1: 1756090.03 }, cxc: { 1: 3397315.69 }, capital: { 1: 100000 }, acumulados: { 1: 239231.2 }, res_periodo: { 1: 4814174.52 } }, efe: {} }, 1);
  assert.equal(b.esf.t_act[1], 5153405.72); assert.equal(b.esf.t_pp[1], 5153405.72);
  // Flujo: 4,814,174.52 + 239,231.20 − 3,397,315.69 = 1,656,090.03 ; + 100,000 = 1,756,090.03
  const f = S.compute({ er: { ing_ventas: { 1: 4814174.52 } }, esf: {}, efe: { res_anteriores: { 1: 239231.2 }, cc_cxc_accionistas: { 1: -3397315.69 }, fin_aportes: { 1: 100000 }, ef_inicio: { 1: 0 } } }, 1);
  assert.equal(f.efe.flujo_ops[1], 1656090.03); assert.equal(f.efe.aumento[1], 1756090.03); assert.equal(f.efe.ef_final[1], 1756090.03);
});
