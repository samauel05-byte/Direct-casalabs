// Cálculo de un período de nómina. Dado el catálogo de columnas de la empresa,
// sus empleados y los valores capturados, produce: cada fila con sus celdas
// (las de fórmula calculadas), ingresos/deducciones/neto por empleado, los
// totales por columna y el resumen del período. Puro y determinista.
const { compile, round2 } = require('./formula');

// Orden estable: por 'position' y, a igualdad, por antigüedad.
function sortColumns(columns) {
  return [...(columns || [])].sort((a, b) => (a.position - b.position) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

// Parámetros de fórmula derivados de los ajustes de la empresa, para que las
// deducciones de ley no lleven tasas fijas en la fórmula. Se inyectan al scope
// con prefijo p_ (p_afp, p_sfs, p_tope_sfs, p_div = divisor del período, etc.).
function paramsFromSettings(st) {
  if (!st) return {};
  const e = st.empleado || {}; const i = st.isr || {};
  const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    p_div: st.period_type === 'mensual' ? 1 : 2,
    p_afp: n(e.afp, 0), p_sfs: n(e.sfs, 0),
    p_tope_sfs: n(e.tope_sfs, 1e12), p_tope_afp: n(e.tope_afp, 1e12),
    p_isr_ex: n(i.exento, 0), p_isr_t2: n(i.tramo2, 0), p_isr_t3: n(i.tramo3, 0),
  };
}

// Calcula una fila (un empleado). 'values' son los valores capturados por key;
// 'params' son las tasas de ley (ver paramsFromSettings), accesibles en fórmulas.
function computeRow(columns, values, params) {
  const v = values || {};
  const scope = { ...(params || {}) };
  for (const c of columns) if (c.type === 'monto' || c.type === 'numero') scope[c.key] = Number(v[c.key]) || 0;
  const cells = {};
  for (const c of columns) {
    if (c.type === 'formula') {
      let r = 0;
      try { r = compile(c.formula || '0').evaluate(scope); } catch { r = 0; }
      r = round2(r); scope[c.key] = r; cells[c.key] = r;
    } else if (c.type === 'monto') cells[c.key] = round2(scope[c.key]);
    else if (c.type === 'numero') cells[c.key] = scope[c.key];
    else cells[c.key] = v[c.key] != null ? String(v[c.key]) : '';
  }
  let ingresos = 0; let deducciones = 0;
  for (const c of columns) {
    if ((c.type === 'monto' || c.type === 'formula') && c.include_total) {
      const n = Number(cells[c.key]) || 0;
      if (c.sign > 0) ingresos += n; else if (c.sign < 0) deducciones += n;
    }
  }
  ingresos = round2(ingresos); deducciones = round2(deducciones);
  return { cells, ingresos, deducciones, neto: round2(ingresos - deducciones) };
}

// Aportes del empleador (TSS) sobre el salario mensual cotizable. Un empleado
// exento (socia) no genera aportes. En período quincenal se prorratea a la
// mitad para que cuadre con las deducciones (que ya van quincenales).
function employerContributions(baseMonthly, exempt, st, quincenal) {
  if (!st || exempt) return { afp: 0, sfs: 0, srl: 0, infotep: 0, total: 0 };
  const base = Number(baseMonthly) || 0;
  const f = quincenal ? 0.5 : 1;
  const e = st.empleador || {}; const em = st.empleado || {};
  const topeSfs = Number(em.tope_sfs) || base; const topeAfp = Number(em.tope_afp) || base;
  const afp = round2(Math.min(base, topeAfp) * (e.afp || 0) * f);
  const sfs = round2(Math.min(base, topeSfs) * (e.sfs || 0) * f);
  const srl = round2(Math.min(base, topeSfs) * (e.srl || 0) * f);
  const infotep = round2(base * (e.infotep || 0) * f);
  return { afp, sfs, srl, infotep, total: round2(afp + sfs + srl + infotep) };
}

// opts: { settings, salaryKey, exemptKey } para calcular los aportes del
// empleador por empleado (y su total). Si no se pasan, se omiten (compat).
function computePeriod(columns, employees, entries, opts = {}) {
  const cols = sortColumns(columns);
  const byEmp = new Map((entries || []).map(e => [e.employee_id, e.values || {}]));
  const st = opts.settings || null;
  const quincenal = !st || st.period_type !== 'mensual';
  const params = paramsFromSettings(st);
  const salaryKey = opts.salaryKey || 'sueldo_mensual';
  const exemptKey = opts.exemptKey || 'exento_tss';
  const rows = (employees || []).map(emp => {
    const r = computeRow(cols, byEmp.get(emp.id) || {}, params);
    const base = Number(r.cells[salaryKey]) || 0;
    const exempt = !!(Number(r.cells[exemptKey]) || 0);
    const aportes = employerContributions(base, exempt, st, quincenal);
    return { employee: emp, ...r, aportes };
  });
  const totals = {};
  for (const c of cols) if (c.type !== 'texto') totals[c.key] = round2(rows.reduce((s, r) => s + (Number(r.cells[c.key]) || 0), 0));
  const summary = {
    employees: rows.length,
    ingresos: round2(rows.reduce((s, r) => s + r.ingresos, 0)),
    deducciones: round2(rows.reduce((s, r) => s + r.deducciones, 0)),
    neto: round2(rows.reduce((s, r) => s + r.neto, 0)),
    aportes: round2(rows.reduce((s, r) => s + (r.aportes ? r.aportes.total : 0), 0)),
  };
  return { columns: cols, rows, totals, summary };
}

module.exports = { computePeriod, computeRow, sortColumns, employerContributions, paramsFromSettings };
