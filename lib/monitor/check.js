// Comprobación de un servicio: hace la petición, mide el tiempo, clasifica el
// resultado y lo deja listo para guardar. No toca la base de datos (eso lo hace
// store.js), para poder probarla con respuestas controladas.

const { isAllowedUrl } = require('./endpoints');

// Deja el texto apto para guardar/mostrar: sin saltos ni caracteres de control,
// truncado. Las respuestas de la semilla son públicas, pero igual se sanea.
function sanitize(s, max = 400) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// ¿La respuesta tiene la estructura/el contenido esperados de una semilla?
// La semilla llega como XML <SemillaModel> con <valor> (y normalmente <fecha>).
function validateSemilla(body) {
  const text = String(body || '');
  if (!text.trim()) return { ok: false, reason: 'Respuesta vacía' };
  const hasValor = /<valor>\s*[^<\s][^<]*<\/valor>/i.test(text);
  if (hasValor) return { ok: true };
  // Tolera variantes (JSON u otra envoltura) siempre que traigan un valor de semilla.
  if (/semilla/i.test(text) && /["']?valor["']?\s*[:=]\s*["']?[^"'\s,}]+/i.test(text)) return { ok: true };
  return { ok: false, reason: 'Respuesta sin la estructura de semilla esperada' };
}

// Traduce un error de red a un tipo estable: dns | tls | timeout | network.
function classifyError(err) {
  if (!err) return 'network';
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'timeout';
  const code = String(err.cause?.code || err.code || '');
  const msg = String(err.cause?.message || err.message || '');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo|dns/i.test(msg)) return 'dns';
  if (/CERT|TLS|SSL|DEPTH_ZERO|UNABLE_TO_VERIFY|SELF_SIGNED|ERR_TLS|HANDSHAKE/i.test(code + ' ' + msg)) return 'tls';
  if (code === 'ETIMEDOUT' || /timed? out/i.test(msg)) return 'timeout';
  return 'network';
}

// Clasifica un resultado ya obtenido (código, cuerpo, ms) → objeto listo para guardar.
// `expect` indica la validación de contenido ('semilla' por ahora).
function classifyResponse({ httpCode, body, ms, degradedMs, expect = 'semilla' }) {
  if (httpCode < 200 || httpCode >= 400) {
    return { ok: false, degraded: false, status: 'down', error_type: 'http', http_code: httpCode, response_ms: ms, error_detail: sanitize(`HTTP ${httpCode}`) };
  }
  const valid = expect === 'semilla' ? validateSemilla(body) : { ok: true };
  if (!valid.ok) {
    return { ok: false, degraded: false, status: 'invalid', error_type: 'invalid', http_code: httpCode, response_ms: ms, error_detail: sanitize(valid.reason) };
  }
  const degraded = ms > degradedMs;
  return { ok: true, degraded, status: degraded ? 'degraded' : 'ok', error_type: null, http_code: httpCode, response_ms: ms, error_detail: null };
}

// Ejecuta la comprobación real contra el endpoint permitido. `fetchImpl` se puede
// inyectar en pruebas; por defecto usa el fetch global de Node.
async function runCheck({ url, method = 'GET', timeoutMs = 10000, degradedMs = 3000, expect = 'semilla' }, fetchImpl = globalThis.fetch) {
  if (!isAllowedUrl(url)) {
    return { ok: false, degraded: false, status: 'invalid', error_type: 'invalid', http_code: null, response_ms: 0, error_detail: 'Endpoint no permitido' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const resp = await fetchImpl(url, {
      method,
      redirect: 'manual',
      signal: controller.signal,
      headers: { Accept: 'application/xml, text/xml, application/json;q=0.9, */*;q=0.1', 'User-Agent': 'DirectMonitor/1.0 (+monitoreo de disponibilidad)' },
    });
    const ms = Date.now() - start;
    let body = '';
    try { body = await resp.text(); } catch { body = ''; }
    return classifyResponse({ httpCode: resp.status, body, ms, degradedMs, expect });
  } catch (err) {
    const ms = Date.now() - start;
    const type = classifyError(err);
    const label = { dns: 'Error de DNS', tls: 'Error TLS/SSL', timeout: 'Tiempo de espera agotado', network: 'Error de red' }[type];
    return { ok: false, degraded: false, status: 'down', error_type: type, http_code: null, response_ms: ms, error_detail: sanitize(label) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sanitize, validateSemilla, classifyError, classifyResponse, runCheck };
