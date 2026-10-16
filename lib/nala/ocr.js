// OCR opcional con Tesseract (tesseract.js, WASM — sin binarios nativos, apto
// para el worker serverless). Es un APOYO para el modelo de visión, no un
// sustituto: le da una "capa de texto" del comprobante para cotejar números
// pequeños (totales, ITBIS, NCF, RNC). La imagen sigue mandando; el OCR es
// referencia. Desactivado salvo que NALA_OCR_TESSERACT esté encendido, así el
// flujo por defecto no cambia y el OCR nunca tumba la extracción.

function enabled() {
  return /^(1|true|on|yes|si|sí)$/i.test(String(process.env.NALA_OCR_TESSERACT || '').trim());
}

// OCR de las partes que son imagen (base64). Devuelve el texto combinado, o
// null si está desactivado, no hay imágenes, o algo falla (silencioso a
// propósito: el OCR es opcional y jamás debe interrumpir la lectura con IA).
// Tope de tiempo DURO: en el worker serverless cada trabajo tiene un presupuesto
// corto; si el OCR (incluida la descarga de datos de idioma la primera vez) no
// termina a tiempo, se abandona y se devuelve null para que la lectura con IA
// continúe y el trabajo no se pase de tiempo. Ajustable con NALA_OCR_TIMEOUT_MS.
function timeoutMs() { const n = Number(process.env.NALA_OCR_TIMEOUT_MS); return Number.isFinite(n) && n > 0 ? n : 8000; }

async function runOcr(images, signal) {
  let worker = null;
  try {
    const { createWorker } = require('tesseract.js');
    const langs = process.env.NALA_OCR_LANGS || 'spa+eng';
    worker = await createWorker(langs, 1, { cachePath: process.env.NALA_OCR_CACHE || '/tmp/tess-cache', logger: () => {} });
    const texts = [];
    for (const img of images) {
      if (signal?.aborted) break;
      const { data } = await worker.recognize(Buffer.from(img.base64, 'base64'));
      const text = String(data?.text || '').replace(/[ \t]+\n/g, '\n').trim();
      if (text) texts.push(text);
    }
    return texts.join('\n---\n').slice(0, 6000) || null;
  } finally {
    if (worker) { try { await worker.terminate(); } catch (_) { /* ignorar */ } }
  }
}

async function ocrImageParts(parts, { signal } = {}) {
  if (!enabled()) return null;
  const images = (parts || []).filter(p => p.kind === 'image' && p.base64);
  if (!images.length) return null;
  let timer = null;
  const cap = new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs()); });
  try {
    return await Promise.race([runOcr(images, signal).catch(() => null), cap]);
  } catch (_) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { enabled, ocrImageParts };
