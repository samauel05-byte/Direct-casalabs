// Panel de Nómina: estados por empresa, totales (mismo motor que la nómina) y calendario de la quincena.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';          // settings.js crea el cliente al cargarse
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'x'; // (no hay llamadas de red en estas pruebas)
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize } = require('../../lib/nomina/dashboard');
const { computePeriod } = require('../../lib/nomina/compute');
const settingsLib = require('../../lib/nomina/settings');
const cal = require('../../lib/nomina/calendar');

const col = (position, key, type, sign, inc, formula) => ({ id: key, client_id: 'A', position, key, label: key, type, sign, include_total: inc, formula: formula || null, created_at: '2026-01-01' });
const COLS = [col(1, 'sueldo_mensual', 'monto', 0, false), col(2, 'sueldo_quincenal', 'formula', 1, true, 'round(sueldo_mensual/p_div,2)'), col(3, 'sfs', 'formula', -1, true, 'round(min(sueldo_mensual,p_tope_sfs)*p_sfs/p_div,2)'), col(4, 'otros_mas', 'monto', 1, true)];
const withClient = (cols, id) => cols.map(c => ({ ...c, client_id: id }));
const co = (id, extra) => ({ id, legal_name: 'EMPRESA ' + id, rnc: '1' + id, active: true, auto_nomina: true, pinned: false, ...extra });
const per = (id, client, extra) => ({ id, client_id: client, label: 'Nómina', status: 'draft', cycle: null, pay_date: null, novedades_locked: false, created_at: '2026-10-01', ...extra });
const today = { y: 2026, m: 10, d: 20 }; // acepta la 2.ª quincena de octubre → 2026-10-B

test('calendario: quincena en curso, fechas clave y días restantes', () => {
  const c = summarize({ today, companies: [] }).calendario;
  assert.equal(c.ciclo, '2026-10-B'); assert.equal(c.corte, '2026-10-26'); assert.equal(c.generacion, '2026-10-28'); assert.equal(c.pago, '2026-10-31');
  assert.equal(c.dias_corte, 6); assert.equal(c.dias_generacion, 8); assert.equal(c.dias_pago, 11);
  // el día 27 ya se acepta la 1.ª de noviembre
  const n = summarize({ today: { y: 2026, m: 10, d: 27 }, companies: [] }).calendario;
  assert.equal(n.ciclo, '2026-11-A'); assert.equal(n.corte, '2026-11-12'); assert.equal(n.pago, '2026-11-15');
  // cambio de año
  assert.equal(summarize({ today: { y: 2026, m: 12, d: 30 }, companies: [] }).calendario.ciclo, '2027-01-A');
});

test('estados por empresa y conteos del resumen', () => {
  const companies = [co('A'), co('B'), co('C'), co('D'), co('E'), co('F', { active: false }), co('G')];
  const columns = ['A', 'B', 'C', 'D', 'E', 'G'].flatMap(id => withClient(COLS, id));
  const employees = [['A', 1], ['B', 1], ['C', 1], ['E', 1], ['G', 1], ['G', 2]].map(([c, n]) => ({ id: `${c}${n}`, client_id: c })); // D sin empleados
  const periods = [
    per('pA', 'A', { cycle: '2026-10-B' }),                                   // abierta, actual
    per('pB', 'B', { cycle: '2026-10-B', novedades_locked: true }),           // bloqueada
    per('pC', 'C', { cycle: '2026-10-A', status: 'closed' }),                 // cerrada (quincena previa)
    per('pE', 'E', { cycle: '2026-08-A', status: 'closed' }),                 // atrasada (el cron no la alcanzó)
  ];                                                                          // G: empleados pero sin período
  const r = summarize({ today, companies, periods, columns, employees, entries: [], settings: [] });
  const st = Object.fromEntries(r.empresas.map(e => [e.id, e.estado]));
  assert.deepEqual(st, { A: 'abierta', B: 'bloqueada', C: 'cerrada', D: 'sin_empleados', E: 'cerrada', F: 'inactiva', G: 'sin_periodo' });
  const by = Object.fromEntries(r.empresas.map(e => [e.id, e]));
  assert.equal(by.E.atrasada, true); assert.equal(by.C.atrasada, false);
  assert.deepEqual(['D', 'E', 'G'].filter(k => by[k].atencion), ['D', 'E', 'G']);
  assert.equal(by.F.atencion, false, 'una empresa inactiva nunca pide atención');
  assert.deepEqual({ ...r.resumen, bruto: 0, neto: 0, aportes: 0 }, { empresas: 6, empleados: 6, abiertas: 1, bloqueadas: 1, cerradas: 2, atencion: 3, en_curso: 2, bruto: 0, neto: 0, aportes: 0 });
});

test('totales: iguales a los del motor de nómina y solo suma la quincena en curso', () => {
  const companies = [co('A'), co('B')];
  const columns = [...withClient(COLS, 'A'), ...withClient(COLS, 'B')];
  const employees = [{ id: 'a1', client_id: 'A' }, { id: 'a2', client_id: 'A' }, { id: 'b1', client_id: 'B' }];
  const periods = [per('pA', 'A', { cycle: '2026-10-B' }), per('pB', 'B', { cycle: '2026-10-A', status: 'closed' })];
  const entries = [
    { period_id: 'pA', employee_id: 'a1', values: { sueldo_mensual: 60000, otros_mas: 1500 } },
    { period_id: 'pA', employee_id: 'a2', values: { sueldo_mensual: 30000 } },
    { period_id: 'pB', employee_id: 'b1', values: { sueldo_mensual: 99999 } },
  ];
  const r = summarize({ today, companies, periods, columns, employees, entries, settings: [] });
  const esperado = computePeriod(withClient(COLS, 'A'), employees.slice(0, 2), entries.slice(0, 2), { settings: settingsLib.merge(null) }).summary;
  const a = r.empresas.find(e => e.id === 'A').totales;
  assert.equal(a.neto, esperado.neto); assert.equal(a.bruto, esperado.ingresos); assert.equal(a.aportes, esperado.aportes); assert.equal(a.empleados, 2);
  assert.equal(r.resumen.neto, esperado.neto, 'B es de la quincena anterior: no entra en el total en curso');
  assert.equal(r.resumen.en_curso, 1);
  assert.ok(r.empresas.find(e => e.id === 'B').totales.neto > 0, 'pero B sí muestra sus propios totales');
});

test('ajustes por empresa: las tasas guardadas cambian el neto', () => {
  const companies = [co('A')]; const columns = withClient(COLS, 'A');
  const employees = [{ id: 'a1', client_id: 'A' }]; const periods = [per('pA', 'A', { cycle: '2026-10-B' })];
  const entries = [{ period_id: 'pA', employee_id: 'a1', values: { sueldo_mensual: 100000 } }];
  const base = summarize({ today, companies, periods, columns, employees, entries, settings: [] }).empresas[0].totales.neto;
  const alto = summarize({ today, companies, periods, columns, employees, entries, settings: [{ client_id: 'A', settings: { empleado: { sfs: 0.10 } } }] }).empresas[0].totales.neto;
  assert.ok(alto < base);
});

test('calendar.js: mismas reglas que usa el cron', () => {
  assert.deepEqual(cal.acceptingCycle(2026, 10, 12), { y: 2026, m: 10, half: 'A' });
  assert.deepEqual(cal.acceptingCycle(2026, 10, 13), { y: 2026, m: 10, half: 'B' });
  assert.deepEqual(cal.acceptingCycle(2026, 10, 27), { y: 2026, m: 11, half: 'A' });
  assert.equal(cal.payDate({ y: 2028, m: 2, half: 'B' }), '2028-02-29');
  assert.equal(cal.genPassed({ y: 2026, m: 10, half: 'B' }, { y: 2026, m: 10, d: 27 }), false);
  assert.equal(cal.genPassed({ y: 2026, m: 10, half: 'B' }, { y: 2026, m: 10, d: 28 }), true);
});
