'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { validateSemilla, classifyError, classifyResponse, sanitize } = require('../../lib/monitor/check');
const { decideIncident, availability, coverage, expectedRuns } = require('../../lib/monitor/incidents');

// ── Validación del contenido de la semilla ──────────────────────────────────
test('validateSemilla: XML con <valor> es válido', () => {
  assert.equal(validateSemilla('<SemillaModel><valor>abc-123</valor><fecha>2026-10-14</fecha></SemillaModel>').ok, true);
});
test('validateSemilla: respuesta vacía es inválida', () => {
  assert.equal(validateSemilla('').ok, false);
});
test('validateSemilla: HTML/otra cosa sin semilla es inválida', () => {
  assert.equal(validateSemilla('<html><body>Error 500</body></html>').ok, false);
});

// ── Clasificación de errores de red ─────────────────────────────────────────
test('classifyError: AbortError → timeout', () => {
  const e = new Error('abort'); e.name = 'AbortError';
  assert.equal(classifyError(e), 'timeout');
});
test('classifyError: ENOTFOUND → dns', () => {
  assert.equal(classifyError({ cause: { code: 'ENOTFOUND' } }), 'dns');
});
test('classifyError: error TLS → tls', () => {
  assert.equal(classifyError({ cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }), 'tls');
});
test('classifyError: otro → network', () => {
  assert.equal(classifyError({ cause: { code: 'ECONNRESET' } }), 'network');
});

// ── Clasificación de la respuesta (válida / lenta / error / malformada) ──────
test('classifyResponse: 200 con semilla y rápida → ok', () => {
  const r = classifyResponse({ httpCode: 200, body: '<valor>x</valor>', ms: 500, degradedMs: 3000 });
  assert.equal(r.status, 'ok'); assert.equal(r.ok, true); assert.equal(r.degraded, false);
});
test('classifyResponse: 200 con semilla pero lenta → degraded', () => {
  const r = classifyResponse({ httpCode: 200, body: '<valor>x</valor>', ms: 4000, degradedMs: 3000 });
  assert.equal(r.status, 'degraded'); assert.equal(r.ok, true); assert.equal(r.degraded, true);
});
test('classifyResponse: 200 con cuerpo malformado → invalid', () => {
  const r = classifyResponse({ httpCode: 200, body: 'no es una semilla', ms: 300, degradedMs: 3000 });
  assert.equal(r.status, 'invalid'); assert.equal(r.ok, false); assert.equal(r.error_type, 'invalid');
});
test('classifyResponse: HTTP 500 → down/http', () => {
  const r = classifyResponse({ httpCode: 500, body: '', ms: 200, degradedMs: 3000 });
  assert.equal(r.status, 'down'); assert.equal(r.ok, false); assert.equal(r.error_type, 'http');
});

// ── Máquina de incidentes (abrir tras 3 fallos, cerrar tras 2 ok) ───────────
const F = { ok: false }, O = { ok: true };
test('incidente: abre tras 3 fallos consecutivos', () => {
  assert.equal(decideIncident([F, F, F], false, 3, 2), 'open');
});
test('incidente: NO abre con 2 fallos', () => {
  assert.equal(decideIncident([F, F, O], false, 3, 2), 'none');
});
test('incidente: cierra tras 2 ok consecutivos si está abierto', () => {
  assert.equal(decideIncident([O, O, F], true, 3, 2), 'resolve');
});
test('incidente: abierto sigue abierto con 1 ok', () => {
  assert.equal(decideIncident([O, F, F], true, 3, 2), 'none');
});
test('incidente: un fallo aislado no abre incidente', () => {
  assert.equal(decideIncident([F, O, O, O], false, 3, 2), 'none');
});

// ── Métricas ────────────────────────────────────────────────────────────────
test('availability = válidas/ejecutadas', () => {
  assert.equal(availability(100, 99), 99);
  assert.equal(availability(0, 0), null); // sin datos
});
test('coverage = ejecutadas/esperadas, acotada a 100', () => {
  assert.equal(coverage(50, 100), 50);
  assert.equal(coverage(120, 100), 100);
  assert.equal(coverage(10, 0), null);
});
test('expectedRuns respeta la puesta en marcha (no cuenta antes)', () => {
  const now = 1_000_000_000_000;
  const from = now - 3600 * 1000;          // hace 1 hora
  const started = now - 1800 * 1000;       // el monitoreo empezó hace 30 min
  // 30 min activos / 60 s = 30 esperadas
  assert.equal(expectedRuns(from, now, started, 60), 30);
});

test('sanitize recorta y limpia caracteres de control', () => {
  assert.equal(sanitize('a\n\tb   c'), 'a b c');
  assert.equal(sanitize('x'.repeat(1000)).length, 400);
});
