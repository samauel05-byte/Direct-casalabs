// CAMI · 607: lee un reporte de ventas B02/E32 ESCANEADO (foto o PDF de imagen), como el «Reporte de ventas
// resumidas por cajeras» de un POS: una fila por comprobante con Factura, NCF, Fecha, Sub-Total, Descuento,
// Total facturado, Más ITBIS, Total pagado y Condiciones. La IA solo transcribe lo impreso; los cuadres
// (base + ITBIS = total pagado, NCF válido, duplicados) los hace este módulo, no el modelo.
// Usa la misma configuración de IA que NALA (OPENAI_API_KEY en el servidor; la llave nunca sale de aquí).
const { allow } = require('./rate-limit');

const OPENAI_URL = () => (process.env.NALA_OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/chat/completions';
const MODEL = () => process.env.NALA_OPENAI_MODEL || 'gpt-4o';
const MAX_FILES = 6;
const MAX_BYTES = 3.8 * 1024 * 1024; // el cuerpo de la petición en Vercel admite ~4.5 MB

const nullable = type => ({ type: [type, 'null'] });
const ROW = {
  type: 'object', additionalProperties: false,
  required: ['factura', 'ncf', 'fecha', 'subtotal', 'descuento', 'total_facturado', 'mas_itbis', 'total_pagado', 'condiciones', 'moneda_seccion', 'nota'],
  properties: {
    factura: nullable('string'), ncf: nullable('string'), fecha: nullable('string'), subtotal: nullable('string'), descuento: nullable('string'),
    total_facturado: nullable('string'), mas_itbis: nullable('string'), total_pagado: nullable('string'), condiciones: nullable('string'),
    moneda_seccion: nullable('string'), nota: nullable('string'),
  },
};
const SCHEMA = { type: 'object', additionalProperties: false, required: ['titulo', 'filas'], properties: { titulo: nullable('string'), filas: { type: 'array', items: ROW } } };

const PROMPT = `Eres un lector de reportes de ventas de República Dominicana. Transcribe la tabla impresa; no calcules ni supongas.
El reporte (foto o escaneo, a veces torcido) tiene UNA FILA POR COMPROBANTE con columnas como: Factura, NCF, Fecha, Sub-Total, Descuento, %, Total facturado, Mas Itbis, Total Pagado, Condiciones (AL CONTADO, CRÉDITO…).
Reglas:
- Devuelve una entrada por cada fila de comprobante, en el orden en que aparecen. Una fila va de izquierda a derecha: no mezcles valores de filas distintas aunque la foto esté inclinada; alinea cada fila por su NCF.
- factura: el número de factura impreso. ncf: el comprobante EXACTAMENTE como está impreso, sin espacios (ej. B0200003531). Si no se lee, null.
- fecha: tal como aparece (DD/MM/AAAA). subtotal, descuento, total_facturado, mas_itbis, total_pagado: el valor impreso con punto decimal y sin separador de miles. Si una columna no está impresa en esa fila, null; nunca inventes ni pongas 0 si no aparece.
- condiciones: el texto de la forma/condición de pago de la fila (ej. "AL CONTADO"). nota: marcas junto a la fila ("DEV. - 125", "(T)", "ANULADA") o null.
- moneda_seccion: la moneda del encabezado o sección bajo el que está la fila (ej. "DOLLAR", "US$", "EURO", "€", "PESOS", "RD$"). El mismo reporte puede traer varias secciones en monedas distintas (dólar, euro y peso dominicano): cada fila lleva la moneda de SU sección. Si los montos traen un símbolo (US$, €, RD$) úsalo. null solo si no hay ninguna pista.
- titulo: el título del reporte con su rango de fechas. No incluyas filas de totales ni subtotales de sección.`;

function num(v) {
  if (v === null || v === undefined) return null;
  const t = String(v).trim().replace(/[^\d.,-]/g, '');
  if (!t) return null;
  const normalized = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function ymd(v) {
  const s = String(v || '').trim();
  let m;
  if ((m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(s))) return `${m[3]}${m[2].padStart(2, '0')}${m[1].padStart(2, '0')}`;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return `${m[1]}${m[2]}${m[3]}`;
  return /^\d{8}$/.test(s) ? s : null;
}
function currency(v) {
  const t = String(v || '').toUpperCase().replace(/\s+/g, '');
  if (!t) return null;
  if (/DOLL|USD|US\$|DÓLAR|DOLAR/.test(t)) return 'USD';
  if (/PESO|RD\$|DOP|RDS/.test(t)) return 'DOP';
  if (/EUR|€/.test(t)) return 'EUR';
  return null;
}

// Valida y deja cada fila lista para la pantalla de revisión. Función pura (se prueba sin la IA).
function normalize(filas) {
  const seen = new Map();
  const out = (Array.isArray(filas) ? filas : []).map((r, i) => {
    const flags = [];
    const ncf = r.ncf ? String(r.ncf).toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
    const base = num(r.total_facturado), itbis = num(r.mas_itbis), pagado = num(r.total_pagado), sub = num(r.subtotal);
    const fecha = ymd(r.fecha);
    if (!ncf) flags.push('Sin NCF');
    else if (!/^(B02\d{8}|E32\d{10})$/.test(ncf)) flags.push(/^(B|E)\d/.test(ncf) ? 'NCF no es B02/E32' : 'NCF dudoso');
    if (!fecha) flags.push('Fecha ilegible');
    if (base === null || itbis === null || pagado === null) flags.push('Faltan montos');
    else if (Math.abs(base + itbis - pagado) > 0.02) flags.push('Base + ITBIS ≠ total pagado');
    else if (base > 0 && Math.abs(itbis - Math.round(base * 18) / 100) > 0.03) flags.push('ITBIS no es 18 %');
    if (r.nota && /dev|anul|nula|n\/c|nota de cr/i.test(String(r.nota))) flags.push('Devolución / anulada');
    if (ncf) seen.set(ncf, (seen.get(ncf) || 0) + 1);
    return { n: i + 1, factura: r.factura || '', ncf, fecha, base, itbis, total: pagado, subtotal: sub, condiciones: r.condiciones || '', moneda: currency(r.moneda_seccion), nota: r.nota || '', flags };
  });
  out.forEach(r => { if (r.ncf && seen.get(r.ncf) > 1) r.flags.push('NCF repetido'); });
  return out;
}

async function callModel(parts) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { const e = new Error('La lectura con IA no está configurada en el servidor.'); e.status = 503; throw e; }
  const content = [{ type: 'text', text: PROMPT }];
  for (const p of parts) {
    if (p.kind === 'pdf') content.push({ type: 'file', file: { filename: p.name || 'reporte.pdf', file_data: `data:application/pdf;base64,${p.base64}` } });
    else content.push({ type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.base64}`, detail: 'high' } });
  }
  const response = await fetch(OPENAI_URL(), {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL(), temperature: 0, max_tokens: 16000, messages: [{ role: 'user', content }], response_format: { type: 'json_schema', json_schema: { name: 'reporte_ventas', strict: true, schema: SCHEMA } } }),
  });
  if (!response.ok) { const e = new Error(`El servicio de IA respondió ${response.status}.`); e.status = 502; throw e; }
  const data = await response.json();
  const msg = data.choices?.[0]?.message;
  if (msg?.refusal) { const e = new Error('La IA no pudo leer ese documento.'); e.status = 422; throw e; }
  let parsed; try { parsed = JSON.parse(msg?.content || ''); } catch { const e = new Error('La respuesta de la IA no es válida.'); e.status = 502; throw e; }
  return parsed;
}

async function handle(req, res, session) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (!(session.role === 'admin' || session.access_cami)) return res.status(403).json({ error: 'Sin acceso a CAMI' });
  if (!(await allow(req, 'cami-escaneo', 20, 15 * 60 * 1000, session.userId))) return res.status(429).json({ error: 'Demasiados escaneos seguidos. Espera unos minutos.' });
  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!files.length) return res.status(400).json({ error: 'Falta la foto o el PDF del reporte.' });
  if (files.length > MAX_FILES) return res.status(400).json({ error: `Máximo ${MAX_FILES} páginas por escaneo.` });
  const parts = []; let bytes = 0;
  for (const f of files) {
    const base64 = String(f?.base64 || '').replace(/^data:[^,]*,/, '');
    const mime = String(f?.mimeType || '').toLowerCase();
    if (!base64) return res.status(400).json({ error: 'Archivo vacío.' });
    bytes += base64.length * 0.75;
    if (mime === 'application/pdf') parts.push({ kind: 'pdf', base64, name: String(f.name || 'reporte.pdf').slice(0, 80) });
    else if (/^image\/(jpeg|png|webp)$/.test(mime)) parts.push({ kind: 'image', mimeType: mime, base64 });
    else return res.status(400).json({ error: 'Formato no admitido (usa JPG, PNG o PDF).' });
  }
  if (bytes > MAX_BYTES) return res.status(413).json({ error: 'Las fotos pesan demasiado. Sube menos páginas o con menor resolución.' });
  try {
    const parsed = await callModel(parts);
    const filas = normalize(parsed.filas);
    return res.json({ ok: true, titulo: parsed.titulo || '', filas, monedas: [...new Set(filas.map(f => f.moneda).filter(Boolean))] });
  } catch (e) {
    if (!e.status) console.error('[cami-escaneo]', e);
    return res.status(e.status || 500).json({ error: e.status ? e.message : 'No se pudo leer el reporte.' });
  }
}

module.exports = { handle, normalize, num, ymd, currency, PROMPT, SCHEMA };
