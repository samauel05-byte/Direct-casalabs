// Comprobantes de compras B11 (compras a personas informales, sin factura) para el 606.
// El contador los lleva en un Excel (Fecha, NCF, No.ck, Cédula, Nombre, Monto, Retención,
// Valor de pago). Lo copia y lo pega en NALA: aquí se leen esas filas y se arman los
// campos del 606 (tipo de id, ITBIS 18 % retenido al 100 %, retención de renta).
// Función pura (sin base de datos) para poder probarla.

const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const fx = n => r2(n).toFixed(2);

function num(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/RD\$|\$|\s/gi, '').replace(/,/g, '');
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// d/m/aaaa (formato dominicano), aaaa-mm-dd, o número de serie de Excel → 'AAAA-MM-DD'.
function date(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s))) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = Number(m[1]); const mo = Number(m[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  if (/^\d{5}(\.\d+)?$/.test(s) && Number(s) > 30000 && Number(s) < 80000) {
    const dt = new Date(Math.round((Number(s) - 25569) * 86400 * 1000));
    return dt.toISOString().slice(0, 10);
  }
  return null;
}

const HEADERS = [
  ['fecha', /^fecha/], ['ncf', /^ncf|^no\.?\s*comprobante/], ['ck', /^no\.?\s*ck|^cheque|^no\.?\s*cheque/],
  ['cedula', /^c[e]dula|^rnc|^identificacion/], ['nombre', /^nombre|^beneficiario|^proveedor/],
  ['monto', /^monto$|^monto base|^base|^monto facturado/], ['retencion', /^retencion/], ['pago', /^valor de pago|^valor pagado|^pago$|^neto/],
];
const DEFAULT_ORDER = ['fecha', 'ncf', 'ck', 'cedula', 'nombre', 'monto', 'retencion', 'pago'];

function splitLine(line) { return line.includes('\t') ? line.split('\t') : line.split(/;/); }

// text: filas pegadas desde Excel. opts: { retentionRate (%), itbis (bool), isrTipo, formaPago }
function parse(text, opts = {}) {
  const rate = Number.isFinite(Number(opts.retentionRate)) ? Number(opts.retentionRate) : 3;
  const withItbis = opts.itbis !== false;
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
  let cols = DEFAULT_ORDER;
  let start = 0;
  if (lines.length) {
    const first = splitLine(lines[0]).map(norm);
    const found = first.map(c => (HEADERS.find(([, re]) => re.test(c)) || [null])[0]);
    if (found.filter(Boolean).length >= 3) { cols = found; start = 1; }
  }
  const rows = []; const skipped = []; const errors = [];
  lines.slice(start).forEach((line, i) => {
    const cells = splitLine(line);
    const get = key => { const idx = cols.indexOf(key); return idx >= 0 ? String(cells[idx] ?? '').trim() : ''; };
    const nombre = get('nombre');
    const lineNo = start + i + 1;
    if (/^(nulo|anulad[oa])$/i.test(nombre)) { skipped.push({ line: lineNo, reason: 'Anulado (NULO)' }); return; }
    const cedulaRaw = get('cedula'); const cedula = cedulaRaw.replace(/\D/g, '');
    let monto = num(get('monto')); const pago = num(get('pago')); let ret = num(get('retencion'));
    if (!nombre && !cedula && monto === null && pago === null) return; // fila vacía o de totales
    if (monto === null && pago !== null) monto = r2(pago + (ret || 0));
    if (monto === null || monto <= 0) { errors.push({ line: lineNo, error: 'Sin monto' }); return; }
    if (ret === null) ret = r2(monto * rate / 100);
    const fecha = date(get('fecha'));
    if (!fecha) { errors.push({ line: lineNo, error: `Fecha inválida («${get('fecha')}»)` }); return; }
    const itbis = withItbis ? r2(monto * 0.18) : 0;
    const fields = {
      emisor_id: cedula || null, emisor_nombre: nombre || null,
      tipo_id: cedula.length === 9 ? '1' : '2',
      ncf: get('ncf').toUpperCase() || null,
      fecha_comprobante: fecha, fecha_pago: fecha,
      tipo_bienes_servicios: opts.tipoBienes || '02', forma_pago: opts.formaPago || '02',
      monto_servicios: fx(monto), itbis: fx(itbis), itbis_retenido: fx(itbis),
      isr_tipo_retencion: opts.isrTipo || '03', isr_retenido: fx(ret),
      total: fx(monto + itbis),
    };
    rows.push({ line: lineNo, fields });
  });
  return { rows, skipped, errors };
}

// Lee un Excel (.xlsx) subido: toma la primera hoja con datos y la devuelve como texto
// separado por tabulaciones, igual que si se hubiera copiado y pegado.
async function workbookToText(buffer) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets.find(w => w.state === 'visible' && w.actualRowCount > 0) || wb.worksheets.find(w => w.actualRowCount > 0);
  if (!ws) return '';
  const cell = v => {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'object') return String(v.result ?? v.text ?? (v.richText ? v.richText.map(t => t.text).join('') : '') ?? '');
    return String(v);
  };
  const lines = [];
  ws.eachRow({ includeEmpty: false }, row => {
    const cells = []; for (let c = 1; c <= Math.min(row.cellCount, 12); c++) cells.push(cell(row.getCell(c).value).replace(/[\t\r\n]+/g, ' '));
    lines.push(cells.join('\t'));
  });
  return lines.join('\n');
}

module.exports = { parse, date, num, workbookToText };
