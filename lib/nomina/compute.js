// Cálculo de un período de nómina. Dado el catálogo de columnas de la empresa,
// sus empleados y los valores capturados, produce: cada fila con sus celdas
// (las de fórmula calculadas), ingresos/deducciones/neto por empleado, los
// totales por columna y el resumen del período. Puro y determinista.
const { compile, round2 } = require('./formula');

// Orden estable: por 'position' y, a igualdad, por antigüedad.
function sortColumns(columns) {
  return [...(columns || [])].sort((a, b) => (a.position - b.position) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

// Calcula una fila (un empleado). 'values' son los valores capturados por key.
function computeRow(columns, values) {
  const v = values || {};
  const scope = {};
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

function computePeriod(columns, employees, entries) {
  const cols = sortColumns(columns);
  const byEmp = new Map((entries || []).map(e => [e.employee_id, e.values || {}]));
  const rows = (employees || []).map(emp => ({ employee: emp, ...computeRow(cols, byEmp.get(emp.id) || {}) }));
  const totals = {};
  for (const c of cols) if (c.type !== 'texto') totals[c.key] = round2(rows.reduce((s, r) => s + (Number(r.cells[c.key]) || 0), 0));
  const summary = {
    employees: rows.length,
    ingresos: round2(rows.reduce((s, r) => s + r.ingresos, 0)),
    deducciones: round2(rows.reduce((s, r) => s + r.deducciones, 0)),
    neto: round2(rows.reduce((s, r) => s + r.neto, 0)),
  };
  return { columns: cols, rows, totals, summary };
}

module.exports = { computePeriod, computeRow, sortColumns };
