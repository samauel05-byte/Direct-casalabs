// Ventas del 607 desde un Excel/CSV (el reporte del POS o del sistema de facturación del cliente).
// Columnas reconocidas por su encabezado: NCF, RNC/Cédula, Nombre/Cliente, Fecha, Importe (sin ITBIS),
// ITBIS, Total y, si la trae, la forma de pago («Tipo de cobro»). Función pura para poder probarla.
const b11 = require('./b11');

const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const fx = n => r2(n).toFixed(2);

const HEADERS = [
  ['ret', /^itbis\s+ret|^retenci/], // retenciones: se ignoran (no son el ITBIS facturado)
  ['ncf', /^(e-?)?ncf|^e-?cf|^no\.?\s*comprobante|^n[uú]mero\s+(de\s+)?(comprobante|ncf|e-?ncf)|^comprobante/], ['cedula', /^rnc|^c[e]dula|^identificacion|^rnc\/c/],
  ['nombre', /^nombre|^cliente|^vendido a|^razon social|^raz[oó]n social/], ['fecha', /^fecha/],
  ['itbis', /^itbis|^impuesto|^iva/], ['total', /^total|^ventas brutas$|^valor total|^monto total/],
  ['importe', /^importe|^subtotal|^sub-total|^base|^monto( facturado)?( sin itbis)?$|^ventas brutas sin|^valor( facturado)?$/],
  ['pago', /^tipo de cobro|^forma de pago|^forma pago|^cobro/],
];

// yyyymmdd (lo que exportan varios POS) además de los formatos de b11.date.
function date(v, period) {
  const s = String(v ?? '').trim();
  let m;
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return `${m[1]}-${m[2]}-${m[3]}`;
  // dd/mm/aaaa o mm/dd/aaaa (los reportes de la DGII traen mm/dd): con el período (AAAAMM) se elige el que cae en él.
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?!\d)/.exec(s))) {
    const a = Number(m[1]), b = Number(m[2]), y = Number(m[3]);
    const pm = /^20\d{2}(0[1-9]|1[0-2])$/.test(String(period || '')) ? Number(String(period).slice(4)) : 0;
    const okDmy = b >= 1 && b <= 12 && a >= 1 && a <= 31, okMdy = a >= 1 && a <= 12 && b >= 1 && b <= 31;
    const useMdy = okMdy && (!okDmy || (pm && a === pm && b !== pm));
    const [d, mo] = useMdy ? [b, a] : [a, b];
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
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

// Sin encabezado reconocible (p. ej. «Ingresos según terceros» de la DGII, que trae RNC, Nombre, Año, Período,
// NCF, Fecha, Tipo de comprobante, Tipo de ID, Monto, ITBIS retenido, ITBIS): se deducen las columnas por su contenido.
const NCF_RE = /^[BE]\d{10}(\d{2})?$/;
function inferColumns(lines, opts = {}) {
  const grid = lines.map(l => splitLine(l).map(c => String(c ?? '').trim()));
  const isNcf = c => NCF_RE.test(c.replace(/[\s-]/g, '').toUpperCase());
  const first = grid.findIndex(r => r.some(isNcf));
  if (first < 0) return null;
  const data = grid.slice(first).filter(r => r.some(isNcf));
  const width = Math.max(...data.map(r => r.length));
  const share = (i, fn) => data.filter(r => fn(String(r[i] ?? '').trim())).length / data.length;
  const colsOf = fn => [...Array(width).keys()].filter(i => share(i, fn) >= 0.6);
  const ncfCol = colsOf(isNcf)[0];
  const fechaCol = colsOf(c => !!date(c, opts.period) && /[/.-]|^\d{8}$/.test(c))[0];
  if (ncfCol === undefined || fechaCol === undefined) return null;
  const cedulaCol = colsOf(c => /^\d{9}$|^\d{11}$/.test(c.replace(/[-\s]/g, '')) && !isNcf(c))[0];
  const keys = Array(width).fill(null);
  keys[ncfCol] = 'ncf'; keys[fechaCol] = 'fecha'; if (cedulaCol !== undefined) keys[cedulaCol] = 'cedula';
  const textLike = c => /[A-Za-zÁÉÍÓÚáéíóúÑñ]{3}/.test(c) && !/^(factura|comprobante|nota|cr[eé]dito|consumo)/i.test(c);
  const nameCol = colsOf(textLike).find(i => keys[i] === null);
  if (nameCol !== undefined) keys[nameCol] = 'nombre';
  // Montos: columnas numéricas que no son año/período/tipo de ID.
  const numVal = c => b11.num(c);
  const amountCols = colsOf(c => c !== '' && numVal(c) !== null).filter(i => keys[i] === null && !data.every(r => { const v = numVal(r[i]); return v === null || (Number.isInteger(v) && v < 10 || (Number.isInteger(v) && /^(19|20)\d{2}(\d{2})?$/.test(String(r[i]).trim()))); }));
  const withValues = (amountCols.length ? amountCols : [...Array(width).keys()].filter(i => keys[i] === null && data.some(r => numVal(r[i]) > 0)));
  if (!withValues.length) return null;
  const med = i => { const v = data.map(r => numVal(r[i]) || 0).sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };
  const importeCol = [...withValues].sort((x, y) => med(y) - med(x))[0];
  keys[importeCol] = 'importe';
  // ITBIS: la columna cuyo valor ≈ 18 % / 16 % del importe en la mayoría de las filas.
  const rate = i => data.filter(r => { const im = numVal(r[importeCol]), it = numVal(r[i]); return im > 0 && it !== null && [0.18, 0.16, 0.08, 0.09, 0.1].some(t => Math.abs(it - im * t) <= Math.max(1, im * 0.004)); }).length / data.length;
  const itbisCol = withValues.filter(i => i !== importeCol).map(i => [i, rate(i)]).filter(([, q]) => q >= 0.5).sort((x, y) => y[1] - x[1])[0];
  if (itbisCol) keys[itbisCol[0]] = 'itbis';
  return { cols: keys, start: first };
}

// opts: { tipoIngreso ('01'…'06'), formaPago ('01'…'04'), period }
function parse(text, opts = {}) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
  let cols = null; let start = 0;
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const found = splitLine(lines[i]).map(norm).map(c => (HEADERS.find(([, re]) => re.test(c)) || [null])[0]);
    if (found.includes('ncf') && found.filter(Boolean).length >= 3) { cols = found; start = i + 1; break; }
  }
  if (!cols) { const inf = inferColumns(lines, opts); if (inf) { cols = inf.cols; start = inf.start; } }
  if (!cols) return { rows: [], skipped: [], errors: [{ line: 1, error: 'No encontré el encabezado ni columnas de NCF y fecha (debe tener al menos NCF, Fecha e Importe/Total).' }] };
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
    const fecha = date(get('fecha'), opts.period);
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
