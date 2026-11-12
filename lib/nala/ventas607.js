// Ventas del 607 desde un Excel/CSV (el reporte del POS o del sistema de facturación del cliente).
// Columnas reconocidas por su encabezado: NCF, RNC/Cédula, Nombre/Cliente, Fecha, Importe (sin ITBIS),
// ITBIS, Total y, si la trae, la forma de pago («Tipo de cobro»). Función pura para poder probarla.
const b11 = require('./b11');

const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const fx = n => r2(n).toFixed(2);

const HEADERS = [
  ['ncf', /^ncf|^no\.?\s*comprobante|^comprobante/], ['cedula', /^rnc|^c[e]dula|^identificacion|^rnc\/c/],
  ['nombre', /^nombre|^cliente|^vendido a|^razon social/], ['fecha', /^fecha/],
  ['itbis', /^itbis|^impuesto|^iva/], ['total', /^total|^ventas brutas$|^valor total|^monto total/],
  ['importe', /^importe|^subtotal|^sub-total|^base|^monto( facturado)?$|^ventas brutas sin|^valor$/],
  ['pago', /^tipo de cobro|^forma de pago|^forma pago|^cobro/],
];

// yyyymmdd (lo que exportan varios POS) además de los formatos de b11.date.
function date(v) {
  const s = String(v ?? '').trim();
  let m;
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^(\d{1,2})-(\d{1,2})-(\d{4})/.exec(s))) return b11.date(`${m[1]}/${m[2]}/${m[3]}`);
  return b11.date(s);
}

// '02' cheque/transferencia/depósito, '03' tarjeta, '04' crédito, '01' efectivo (por defecto).
function paymentBucket(text, fallback) {
  const t = norm(text);
  if (!t) return fallback;
  if (/transfer|cheque|deposit/.test(t)) return 'pago_cheque';
  if (/tarjeta|credito|debito/.test(t) && !/venta a credito|a credito/.test(t)) return 'pago_tarjeta';
  if (/a credito|credito dias|credit/.test(t)) return 'pago_credito';
  if (/efectivo|cash/.test(t)) return 'pago_efectivo';
  return fallback;
}
const BUCKETS = { '01': 'pago_efectivo', '02': 'pago_cheque', '03': 'pago_tarjeta', '04': 'pago_credito' };

function splitLine(line) { return line.includes('\t') ? line.split('\t') : line.split(/;/); }

// opts: { tipoIngreso ('01'…'06'), formaPago ('01'…'04'), period }
function parse(text, opts = {}) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
  let cols = null; let start = 0;
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const found = splitLine(lines[i]).map(norm).map(c => (HEADERS.find(([, re]) => re.test(c)) || [null])[0]);
    if (found.includes('ncf') && found.filter(Boolean).length >= 3) { cols = found; start = i + 1; break; }
  }
  if (!cols) return { rows: [], skipped: [], errors: [{ line: 1, error: 'No encontré el encabezado (debe tener al menos NCF, Fecha e Importe/Total).' }] };
  const fallbackBucket = BUCKETS[opts.formaPago] || 'pago_efectivo';
  const rows = []; const skipped = []; const errors = [];
  lines.slice(start).forEach((line, i) => {
    const cells = splitLine(line);
    const get = key => { const idx = cols.indexOf(key); return idx >= 0 ? String(cells[idx] ?? '').trim() : ''; };
    const lineNo = start + i + 1;
    const ncf = get('ncf').replace(/[\s-]/g, '').toUpperCase();
    const nombre = get('nombre');
    if (!ncf && !nombre) return;
    if (/^(nulo|anulad[oa])$/i.test(nombre)) { skipped.push({ line: lineNo, reason: 'Anulado' }); return; }
    if (!/^[A-Z]\d{10}(\d{2})?$/.test(ncf)) { errors.push({ line: lineNo, error: `NCF inválido («${get('ncf')}»)` }); return; }
    const fecha = date(get('fecha'));
    if (!fecha) { errors.push({ line: lineNo, error: `Fecha inválida («${get('fecha')}»)` }); return; }
    let itbis = b11.num(get('itbis')); let importe = b11.num(get('importe')); const total = b11.num(get('total'));
    if (importe === null && total !== null) importe = r2(total - (itbis || 0));
    if (importe === null) { errors.push({ line: lineNo, error: 'Sin monto' }); return; }
    if (itbis === null) itbis = total !== null ? r2(total - importe) : 0;
    let id = get('cedula').replace(/\D/g, ''); let nombreLimpio = nombre;
    // Reportes que traen el RNC entre paréntesis junto al nombre: «EMPRESA SRL (131-31015-1)».
    const inName = /\(\s*([\d-]{9,13})\s*\)\s*$/.exec(nombre);
    if (!id && inName && [9, 11].includes(inName[1].replace(/\D/g, '').length)) { id = inName[1].replace(/\D/g, ''); nombreLimpio = nombre.replace(inName[0], '').trim(); }
    const bucket = paymentBucket(get('pago'), fallbackBucket);
    const fields = {
      receptor_id: id || null, receptor_nombre: nombreLimpio || null,
      tipo_id: id ? (id.length === 9 ? '1' : '2') : null,
      ncf, fecha_comprobante: fecha, tipo_ingreso: opts.tipoIngreso || '01',
      monto_facturado: fx(importe), itbis: fx(itbis), total: fx(importe + itbis),
      [bucket]: fx(importe + itbis),
    };
    rows.push({ line: lineNo, fields });
  });
  return { rows, skipped, errors };
}

// Lee .xls / .xlsx / .xlsm con SheetJS y devuelve la primera hoja con datos como texto con tabulaciones.
function workbookToText(buffer) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' });
    if (rows.some(r => r.some(c => String(c).trim() !== ''))) {
      workbookToText.lastSheet = name;
      return rows.map(r => r.slice(0, 14).map(c => String(c).replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
    }
  }
  return '';
}

module.exports = { parse, workbookToText, date, paymentBucket };
