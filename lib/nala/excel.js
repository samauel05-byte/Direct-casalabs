// Excel workbooks built from the same export snapshot as the TXT. Identifiers,
// codes, NCF and dates are written as text (leading zeros preserved); amounts
// are real numbers. The official layout sheet is protected; the custom
// workbook lets the firm choose columns.
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const money = require('./money');
const formats = require('./formats');

// Columnas del 606 que en la herramienta oficial de la DGII son listas desplegables. Se escriben con el
// texto de la opción (la macro lee sus 2 primeros caracteres) y llevan la lista para poder cambiarla.
const LIST_COLUMNS = { '606': { tipo_bienes_servicios: 'tipo_bienes_servicios', forma_pago: 'forma_pago' } };

function optionFor(list, code) {
  const found = (formats.TOOL_606_LISTS[list] || []).find(o => o.slice(0, 2) === code);
  return found ? found.trim() : code;
}

// Hoja oculta «Listas» con las opciones (algunas llevan comas, por eso no van en línea).
function addListsSheet(wb, format) {
  const defs = LIST_COLUMNS[format];
  if (!defs) return {};
  const ws = wb.addWorksheet('Listas', { state: 'hidden' });
  const refs = {};
  let col = 1;
  for (const [key, list] of Object.entries(defs)) {
    const options = (formats.TOOL_606_LISTS[list] || []).map(o => o.trim());
    options.forEach((o, i) => { ws.getCell(i + 1, col).value = o; });
    ws.getColumn(col).width = 60;
    const letter = ws.getColumn(col).letter;
    refs[key] = { formulae: [`Listas!$${letter}$1:$${letter}$${options.length}`], list };
    col += 1;
  }
  return refs;
}

function applyList(cell, ref, unlock) {
  cell.dataValidation = { type: 'list', allowBlank: true, showErrorMessage: true, errorStyle: 'warning', errorTitle: 'Valor fuera de la lista',
    error: 'Elija una opción de la lista desplegable.', showInputMessage: true, promptTitle: 'Lista DGII', prompt: 'Elija una opción de la lista.', formulae: ref.formulae };
  if (unlock) cell.protection = { locked: false }; // la hoja está protegida: estas celdas sí se pueden cambiar
}

function styleHeader(row) {
  row.font = { bold: true, size: 10 };
  row.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  row.height = 42;
  row.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
    cell.border = { bottom: { style: 'thin' } };
  });
}

function setCell(cell, type, value) {
  if (type === 'amount') {
    cell.value = value === '' || value === null || value === undefined ? null : money.toNumber(value);
    cell.numFmt = '#,##0.00';
    cell.alignment = { horizontal: 'right' };
  } else {
    cell.value = value === null || value === undefined ? '' : String(value);
    cell.numFmt = '@';
  }
}

function addControlSheet(wb, snapshot, meta) {
  const ws = wb.addWorksheet('Control NALA');
  ws.columns = [{ header: 'Línea', key: 'line', width: 8 }, { header: 'ID factura NALA', key: 'invoice', width: 38 },
    { header: 'Lote', key: 'batch', width: 38 }, { header: 'Contraparte', key: 'name', width: 36 }, { header: 'Moneda original', key: 'cur', width: 12 },
    { header: 'Advertencias', key: 'warn', width: 60 }];
  styleHeader(ws.getRow(1));
  for (const line of snapshot.lines) {
    ws.addRow({ line: line.line_no, invoice: line.invoice_id, batch: line.batch_id || '', name: line.counterpart_name || '', cur: line.currency || '',
      warn: (line.issues || []).filter(i => i.severity === 'warning').map(i => i.message).join(' | ') });
  }
  ws.addRow({});
  const info = [['Exportación', meta.exportId || '(vista previa)'], ['Formato', snapshot.format], ['Período', snapshot.period],
    ['Esquema', snapshot.schema_version], ['Reglas', snapshot.rules_version], ['Archivo TXT', snapshot.file_name],
    ['SHA-256 TXT', meta.txtSha256 || ''], ['Generado', meta.generatedAt || new Date().toISOString()]];
  for (const [k, v] of info) { const r = ws.addRow({ line: k, invoice: v }); r.getCell(1).font = { bold: true }; r.getCell(2).numFmt = '@'; }
}

async function buildOfficial(snapshot, meta = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NALA';
  wb.created = new Date(meta.generatedAt || Date.now());
  const title = snapshot.format === '606' ? 'Formato de Envío de Compras de Bienes y Servicios (606)' : 'Formato de Envío de Ventas de Bienes y Servicios (607)';
  const ws = wb.addWorksheet(`Formato ${snapshot.format}`, { views: [{ state: 'frozen', ySplit: 6 }] });
  ws.getCell('A1').value = title; ws.getCell('A1').font = { bold: true, size: 13 };
  const headerRows = [['RNC o Cédula', snapshot.header.rnc], ['Periodo', snapshot.header.period], ['Cantidad Registros', String(snapshot.header.count)]];
  headerRows.forEach(([label, value], i) => {
    ws.getCell(2 + i, 1).value = label; ws.getCell(2 + i, 1).font = { bold: true };
    const c = ws.getCell(2 + i, 2); c.value = value; c.numFmt = '@';
  });
  const columns = [{ label: snapshot.format === '606' ? 'Líneas' : 'No', type: 'code' }, ...snapshot.columns];
  const headerRow = ws.getRow(6);
  columns.forEach((c, i) => { headerRow.getCell(i + 1).value = c.label; });
  styleHeader(headerRow);
  columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.type === 'amount' ? 17 : (i === 0 ? 7 : 22); });
  const listRefs = addListsSheet(wb, snapshot.format);
  snapshot.lines.forEach((line, index) => {
    const row = ws.getRow(7 + index);
    row.getCell(1).value = line.line_no;
    snapshot.columns.forEach((c, i) => {
      const cell = row.getCell(i + 2);
      const ref = listRefs[c.key];
      if (ref) { setCell(cell, 'code', line.values[i] ? optionFor(ref.list, line.values[i]) : ''); applyList(cell, ref, true); }
      else setCell(cell, c.type, line.values[i]);
    });
  });
  const totalRow = ws.getRow(7 + snapshot.lines.length);
  totalRow.getCell(1).value = 'TOTAL'; totalRow.font = { bold: true };
  snapshot.columns.forEach((c, i) => {
    if (c.type !== 'amount') return;
    const letter = ws.getColumn(i + 2).letter;
    const cell = totalRow.getCell(i + 2);
    cell.value = snapshot.lines.length
      ? { formula: `SUM(${letter}7:${letter}${6 + snapshot.lines.length})`, result: money.toNumber(snapshot.totals[c.key]) }
      : 0;
    cell.numFmt = '#,##0.00';
  });
  // Structure is protected so the official layout cannot be altered by mistake;
  // cells remain selectable and copyable.
  await ws.protect(crypto.randomBytes(12).toString('hex'), { selectLockedCells: true, selectUnlockedCells: true, formatColumns: true });
  if (snapshot.consumer_summary) {
    const cs = wb.addWorksheet('Resumen consumo');
    cs.addRow(['Resumen General de Facturas de Consumo (para la Oficina Virtual)']).font = { bold: true };
    cs.addRow(['Cantidad de NCF', snapshot.consumer_summary.count]);
    const r1 = cs.addRow(['Monto facturado', money.toNumber(snapshot.consumer_summary.monto_facturado)]); r1.getCell(2).numFmt = '#,##0.00';
    const r2 = cs.addRow(['ITBIS facturado', money.toNumber(snapshot.consumer_summary.itbis)]); r2.getCell(2).numFmt = '#,##0.00';
    cs.getColumn(1).width = 30; cs.getColumn(2).width = 18;
  }
  addControlSheet(wb, snapshot, meta);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Catalogue for the custom workbook: official columns plus traceability data.
function customCatalogue(format) {
  const extra = [
    { key: 'x_line', label: 'Línea', type: 'code' },
    { key: 'x_counterpart', label: format === '606' ? 'Proveedor' : 'Cliente', type: 'text' },
    { key: 'x_currency', label: 'Moneda original', type: 'code' },
    { key: 'x_invoice', label: 'ID factura NALA', type: 'code' },
    { key: 'x_batch', label: 'Lote', type: 'code' },
    { key: 'x_warnings', label: 'Advertencias aceptadas', type: 'text' },
  ];
  return [...extra, ...require('./formats').SCHEMAS[format].map(c => ({ key: c.key, label: c.label, type: c.type }))];
}

async function buildCustom(snapshot, columnKeys, meta = {}) {
  const catalogue = customCatalogue(snapshot.format);
  const chosen = (Array.isArray(columnKeys) && columnKeys.length ? columnKeys : catalogue.map(c => c.key))
    .map(key => catalogue.find(c => c.key === key)).filter(Boolean);
  if (!chosen.length) throw new Error('Seleccione al menos una columna.');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NALA';
  const ws = wb.addWorksheet(`NALA ${snapshot.format} ${snapshot.period}`, { views: [{ state: 'frozen', ySplit: 1 }] });
  chosen.forEach((c, i) => { ws.getRow(1).getCell(i + 1).value = c.label; ws.getColumn(i + 1).width = c.type === 'amount' ? 17 : 24; });
  styleHeader(ws.getRow(1));
  const indexOf = Object.fromEntries(snapshot.columns.map((c, i) => [c.key, i]));
  const listRefs = addListsSheet(wb, snapshot.format);
  snapshot.lines.forEach((line, n) => {
    const row = ws.getRow(n + 2);
    chosen.forEach((c, i) => {
      const extraValue = { x_line: String(line.line_no), x_counterpart: line.counterpart_name || '', x_currency: line.currency || '',
        x_invoice: line.invoice_id, x_batch: line.batch_id || '', x_warnings: (line.issues || []).filter(x => x.severity === 'warning').map(x => x.message).join(' | ') };
      const value = c.key in extraValue ? extraValue[c.key] : line.values[indexOf[c.key]];
      const ref = listRefs[c.key];
      if (ref) { setCell(row.getCell(i + 1), 'code', value ? optionFor(ref.list, value) : ''); applyList(row.getCell(i + 1), ref, false); }
      else setCell(row.getCell(i + 1), c.type === 'text' ? 'code' : c.type, value);
    });
  });
  addControlSheet(wb, snapshot, meta);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildOfficial, buildCustom, customCatalogue };
