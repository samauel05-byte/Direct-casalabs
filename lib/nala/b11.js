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
  ['monto', /^monto$|^monto base|^base|^monto facturado/], ['retencion', /^retencion/], ['itbis', /^itbis/], ['total', /^total/],
  ['pago', /^valor de pago|^valor pagado|^pago$|^neto|^a pagar/],
  // Hojas mensuales del IR-17: los encabezados de retención e ITBIS son la tasa (0.03 / 0.18).
  ['rate', /^0?\.\d+$/],
];
const DEFAULT_ORDER = ['fecha', 'ncf', 'ck', 'cedula', 'nombre', 'monto', 'retencion', 'pago'];

function splitLine(line) { return line.includes('\t') ? line.split('\t') : line.split(/;/); }

// text: filas pegadas desde Excel. opts: { retentionRate (%), itbis (bool), isrTipo, formaPago }
function periodEnd(period) {
  const m = /^(\d{4})(\d{2})$/.exec(String(period || ''));
  if (!m) return null;
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}`;
}

// text: filas pegadas/subidas del Excel. opts: { retentionRate (%), itbis (bool), isrTipo, formaPago, period }
function parse(text, opts = {}) {
  let rate = Number.isFinite(Number(opts.retentionRate)) ? Number(opts.retentionRate) : 3;
  const withItbis = opts.itbis !== false;
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
  let cols = DEFAULT_ORDER;
  let start = 0;
  // El encabezado puede no ser la primera fila (hojas mensuales con títulos arriba).
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const heads = splitLine(lines[i]).map(norm);
    const found = heads.map(c => (HEADERS.find(([, re]) => re.test(c)) || [null])[0]);
    if (found.filter(Boolean).length >= 3) {
      // Las dos tasas del encabezado: la primera es la retención y la segunda el ITBIS.
      const rateIdx = found.map((k, j) => (k === 'rate' ? j : -1)).filter(j => j >= 0);
      if (rateIdx[0] !== undefined && !found.includes('retencion')) { found[rateIdx[0]] = 'retencion'; const r = Number(heads[rateIdx[0]]); if (r > 0 && r < 1) rate = r * 100; }
      if (rateIdx[1] !== undefined && !found.includes('itbis')) found[rateIdx[1]] = 'itbis';
      // Hojas sin títulos en las dos primeras columnas: antes de «Base» van la cédula y el NCF.
      const mi = found.indexOf('monto');
      if (mi >= 2 && !found.includes('ncf') && !found.includes('cedula') && !found[mi - 1] && !found[mi - 2]) { found[mi - 1] = 'ncf'; found[mi - 2] = 'cedula'; }
      cols = found; start = i + 1; break;
    }
  }
  const fallbackDate = periodEnd(opts.period);
  const rows = []; const skipped = []; const errors = [];
  lines.slice(start).forEach((line, i) => {
    const cells = splitLine(line);
    const get = key => { const idx = cols.indexOf(key); return idx >= 0 ? String(cells[idx] ?? '').trim() : ''; };
    const nombre = get('nombre');
    const lineNo = start + i + 1;
    if (/^(nulo|anulad[oa])$/i.test(nombre)) { skipped.push({ line: lineNo, reason: 'Anulado (NULO)' }); return; }
    const cedulaRaw = get('cedula'); const cedula = cedulaRaw.replace(/\D/g, ''); const ncf = get('ncf').toUpperCase();
    let monto = num(get('monto')); const pago = num(get('pago')); let ret = num(get('retencion'));
    // Fila vacía, de títulos o de totales (sin cédula, NCF ni nombre).
    if (!nombre && !cedula && !ncf) return;
    if (monto === null && pago !== null) monto = r2(pago + (ret || 0));
    if (monto === null || monto <= 0) { errors.push({ line: lineNo, error: 'Sin monto' }); return; }
    if (ret === null) ret = r2(monto * rate / 100);
    const fecha = date(get('fecha')) || fallbackDate;
    if (!fecha) { errors.push({ line: lineNo, error: `Fecha inválida («${get('fecha')}»)` }); return; }
    const itbisCell = num(get('itbis'));
    const itbis = withItbis ? r2(itbisCell !== null ? itbisCell : monto * 0.18) : 0;
    const fields = {
      emisor_id: cedula || null, emisor_nombre: nombre || null,
      tipo_id: cedula.length === 9 ? '1' : '2',
      ncf: ncf || null,
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
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Si el libro trae una hoja por mes («SEPTIEMBRE 2026»), se usa la del período del lote.
function sheetNameFor(period) {
  const m = /^(\d{4})(\d{2})$/.exec(String(period || ''));
  return m ? `${MESES[Number(m[2]) - 1]} ${m[1]}` : null;
}

async function workbookToText(buffer, { period } = {}) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const want = sheetNameFor(period);
  const withData = wb.worksheets.filter(w => w.actualRowCount > 0);
  const ws = (want && withData.find(w => norm(w.name) === want)) || withData.find(w => w.state === 'visible') || withData[0];
  if (!ws) return '';
  workbookToText.lastSheet = ws.name;
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

module.exports = { parse, date, num, workbookToText, sheetNameFor, periodEnd };
