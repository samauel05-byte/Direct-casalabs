// Panel de Nómina: resumen de TODAS las empresas del tenant en una sola respuesta.
// Función pura (sin base de datos): recibe las filas ya leídas y devuelve, por empresa, su
// último período con totales calculados con el mismo motor que la nómina (computePeriod),
// más el calendario de la quincena en curso (corte de novedades, generación y pago).
const { computePeriod } = require('./compute');
const settingsLib = require('./settings');
const { acceptingCycle, prevCycle, cycleKey, labelOf, payDate, cutDay, genDay, pad } = require('./calendar');

const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const daysBetween = (today, iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(today.y, today.m - 1, today.d)) / 86400000);
};
const group = (rows, key) => { const g = new Map(); for (const r of rows || []) { const k = r[key]; if (!g.has(k)) g.set(k, []); g.get(k).push(r); } return g; };
const money = n => Math.round((Number(n) || 0) * 100) / 100;

// d: { today:{y,m,d}, companies, periods, columns, employees, entries, settings }
//   periods: nomina_periods (cualquier orden) · employees: solo ACTIVOS · entries: de los períodos más recientes
//   settings: [{ client_id, settings }]
function summarize(d) {
  const today = d.today;
  const acc = acceptingCycle(today.y, today.m, today.d);
  const accKey = cycleKey(acc.y, acc.m, acc.half);
  const prev = prevCycle(acc);
  const prevKey = cycleKey(prev.y, prev.m, prev.half);
  const cut = ymd(acc.y, acc.m, cutDay(acc.half)), gen = ymd(acc.y, acc.m, genDay(acc.half)), pay = payDate(acc);
  const calendario = {
    hoy: ymd(today.y, today.m, today.d), ciclo: accKey, etiqueta: labelOf(acc),
    corte: cut, generacion: gen, pago: pay,
    dias_corte: daysBetween(today, cut), dias_generacion: daysBetween(today, gen), dias_pago: daysBetween(today, pay),
  };

  const periodsBy = group([...(d.periods || [])].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))), 'client_id');
  const colsBy = group(d.columns, 'client_id');
  const empsBy = group(d.employees, 'client_id');
  const entriesBy = group(d.entries, 'period_id');
  const setBy = new Map((d.settings || []).map(s => [s.client_id, s.settings]));

  const empresas = (d.companies || []).map(co => {
    const latest = (periodsBy.get(co.id) || [])[0] || null;
    const emps = empsBy.get(co.id) || [];
    let totales = null;
    if (latest && emps.length) {
      const calc = computePeriod(colsBy.get(co.id) || [], emps, entriesBy.get(latest.id) || [], { settings: settingsLib.merge(setBy.get(co.id)) });
      totales = { empleados: calc.summary.employees, bruto: money(calc.summary.ingresos), deducciones: money(calc.summary.deducciones), neto: money(calc.summary.neto), aportes: money(calc.summary.aportes) };
    }
    let estado;
    if (co.active === false) estado = 'inactiva';
    else if (!emps.length) estado = 'sin_empleados';
    else if (!latest) estado = 'sin_periodo';
    else if (latest.status === 'closed') estado = 'cerrada';
    else if (latest.novedades_locked) estado = 'bloqueada';
    else estado = 'abierta';
    const actual = !!(latest && latest.cycle === accKey);
    // Atrasada: automática, y su último período es anterior a la quincena previa (el cron no la alcanzó).
    const atrasada = co.active !== false && co.auto_nomina !== false && !!(latest && latest.cycle && latest.cycle < prevKey);
    const atencion = co.active !== false && (estado === 'sin_empleados' || estado === 'sin_periodo' || atrasada);
    return {
      id: co.id, nombre: co.legal_name, rnc: co.rnc || null, activa: co.active !== false, auto: co.auto_nomina !== false, fijada: co.pinned === true,
      empleados: emps.length, periodo: latest ? { id: latest.id, etiqueta: latest.label, estado: latest.status, bloqueado: !!latest.novedades_locked, ciclo: latest.cycle || null, pago: latest.pay_date || null } : null,
      estado, actual, atrasada, atencion, totales,
    };
  });

  const activas = empresas.filter(e => e.activa);
  const enCurso = activas.filter(e => e.actual && e.totales);
  const sum = k => money(enCurso.reduce((s, e) => s + e.totales[k], 0));
  const resumen = {
    empresas: activas.length,
    empleados: activas.reduce((s, e) => s + e.empleados, 0),
    abiertas: activas.filter(e => e.estado === 'abierta').length,
    bloqueadas: activas.filter(e => e.estado === 'bloqueada').length,
    cerradas: activas.filter(e => e.estado === 'cerrada').length,
    atencion: activas.filter(e => e.atencion).length,
    en_curso: enCurso.length,
    bruto: sum('bruto'), neto: sum('neto'), aportes: sum('aportes'),
  };
  return { calendario, resumen, empresas };
}

module.exports = { summarize };
