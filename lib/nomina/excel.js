// Exporta un período de nómina a Excel. Una hoja con: encabezado de la empresa
// y el período, una fila por empleado (sus celdas ya calculadas), columnas de
// ingresos/deducciones/neto, y una fila de totales al pie.
const ExcelJS = require('exceljs');

const MONEY_FMT = '#,##0.00';

async function buildWorkbook({ period, client, columns, rows, totals, summary }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SERP · Nómina';
  const ws = wb.addWorksheet('Nómina', { views: [{ state: 'frozen', ySplit: 5, xSplit: 1 }] });

  ws.getCell('A1').value = client?.legal_name || 'Empresa';
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A2').value = period?.label || 'Período';
  ws.getCell('A2').font = { size: 12 };
  ws.getCell('A3').value = `Empleados: ${summary.employees} · Neto total: ${summary.neto.toLocaleString('es-DO', { minimumFractionDigits: 2 })}`;
  ws.getCell('A3').font = { color: { argb: 'FF666666' } };

  // Fila de encabezados (fila 5). Col 1 = Empleado, luego las columnas de la
  // empresa, y al final Ingresos/Deducciones/Neto.
  const headers = ['Empleado', 'Cédula', 'Puesto', ...columns.map(c => c.label), 'Ingresos', 'Deducciones', 'Neto'];
  const headerRow = ws.getRow(5);
  headers.forEach((hd, i) => { const c = headerRow.getCell(i + 1); c.value = hd; c.font = { bold: true }; c.alignment = { wrapText: true }; });
  headerRow.commit();

  const numericCols = new Set(columns.filter(c => c.type !== 'texto').map(c => c.key));
  const firstDataRow = 6;
  rows.forEach((r, idx) => {
    const row = ws.getRow(firstDataRow + idx);
    row.getCell(1).value = r.employee.full_name;
    row.getCell(2).value = r.employee.identifier || '';
    row.getCell(2).numFmt = '@';
    row.getCell(3).value = r.employee.position || '';
    columns.forEach((c, i) => {
      const cell = row.getCell(4 + i);
      const v = r.cells[c.key];
      if (c.type === 'texto') cell.value = v || '';
      else { cell.value = Number(v) || 0; cell.numFmt = c.type === 'monto' || c.type === 'formula' ? MONEY_FMT : '#,##0.##'; }
    });
    const base = 4 + columns.length;
    [r.ingresos, r.deducciones, r.neto].forEach((v, i) => { const cell = row.getCell(base + i); cell.value = v; cell.numFmt = MONEY_FMT; });
    row.getCell(base + 2).font = { bold: true };
    row.commit();
  });

  // Totales.
  const totalRow = ws.getRow(firstDataRow + rows.length);
  totalRow.getCell(1).value = 'TOTALES';
  totalRow.getCell(1).font = { bold: true };
  columns.forEach((c, i) => {
    if (!numericCols.has(c.key)) return;
    const cell = totalRow.getCell(4 + i);
    cell.value = totals[c.key] || 0;
    cell.numFmt = c.type === 'numero' ? '#,##0.##' : MONEY_FMT;
    cell.font = { bold: true };
  });
  const base = 4 + columns.length;
  [summary.ingresos, summary.deducciones, summary.neto].forEach((v, i) => { const cell = totalRow.getCell(base + i); cell.value = v; cell.numFmt = MONEY_FMT; cell.font = { bold: true }; });
  totalRow.commit();

  ws.columns.forEach((col, i) => { col.width = i === 0 ? 26 : Math.max(12, (headers[i] || '').length + 2); });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildWorkbook };
