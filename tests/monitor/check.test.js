'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { runCheck } = require('../../lib/monitor/check');
const { urlForEndpointKey, isAllowedUrl } = require('../../lib/monitor/endpoints');

// URL oficial permitida (allowlist). Se inyecta fetch para controlar la respuesta.
const URL_OK = 'https://ecf.dgii.gov.do/testecf/autenticacion/api/autenticacion/semilla';

function fakeResponse(status, body) {
  return { status, async text() { return body; } };
}

test('runCheck: respuesta válida → ok', async () => {
  const r = await runCheck({ url: URL_OK, degradedMs: 3000, timeoutMs: 5000 },
    async () => fakeResponse(200, '<SemillaModel><valor>abc</valor><fecha>2026</fecha></SemillaModel>'));
  assert.equal(r.status, 'ok'); assert.equal(r.ok, true);
});

test('runCheck: respuesta lenta pero válida → degraded', async () => {
  const r = await runCheck({ url: URL_OK, degradedMs: 20, timeoutMs: 5000 },
    async () => { await new Promise(res => setTimeout(res, 60)); return fakeResponse(200, '<valor>abc</valor>'); });
  assert.equal(r.status, 'degraded'); assert.equal(r.ok, true); assert.equal(r.degraded, true);
});

test('runCheck: error HTTP → down/http', async () => {
  const r = await runCheck({ url: URL_OK }, async () => fakeResponse(500, 'Internal Error'));
  assert.equal(r.status, 'down'); assert.equal(r.error_type, 'http'); assert.equal(r.http_code, 500);
});

test('runCheck: formato incorrecto → invalid', async () => {
  const r = await runCheck({ url: URL_OK }, async () => fakeResponse(200, '<html>mantenimiento</html>'));
  assert.equal(r.status, 'invalid'); assert.equal(r.error_type, 'invalid');
});

test('runCheck: timeout (fetch abortado) → down/timeout', async () => {
  const r = await runCheck({ url: URL_OK, timeoutMs: 5000 }, async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
  assert.equal(r.status, 'down'); assert.equal(r.error_type, 'timeout');
});

test('runCheck: error DNS → down/dns', async () => {
  const r = await runCheck({ url: URL_OK }, async () => { throw { cause: { code: 'ENOTFOUND' } }; });
  assert.equal(r.error_type, 'dns');
});

test('runCheck: endpoint NO permitido se rechaza sin salir a la red', async () => {
  let called = false;
  const r = await runCheck({ url: 'https://malicioso.example.com/x' }, async () => { called = true; return fakeResponse(200, '<valor>x</valor>'); });
  assert.equal(called, false);
  assert.equal(r.status, 'invalid');
  assert.equal(r.error_detail, 'Endpoint no permitido');
});

test('runCheck: http no permitido (solo https DGII)', async () => {
  const r = await runCheck({ url: 'http://ecf.dgii.gov.do/testecf/autenticacion/api/autenticacion/semilla' }, async () => fakeResponse(200, '<valor>x</valor>'));
  assert.equal(r.status, 'invalid');
});

// ── Subsistema de estatus e-CF (statusecf): clave y host oficial permitidos ──
test('urlForEndpointKey: statusecf_subsistema apunta al host oficial statusecf', () => {
  const url = urlForEndpointKey('statusecf_subsistema');
  assert.equal(url, 'https://statusecf.dgii.gov.do/api-docs/v1/definition.json');
  assert.equal(isAllowedUrl(url), true);
});

test('runCheck: check_type http → cualquier 2xx es ok (no exige semilla)', async () => {
  const url = urlForEndpointKey('statusecf_subsistema');
  const r = await runCheck({ url, expect: 'http', degradedMs: 3000, timeoutMs: 5000 },
    async () => fakeResponse(200, '{"openapi":"3.0.0"}'));
  assert.equal(r.status, 'ok'); assert.equal(r.ok, true);
});

test('runCheck: check_type http → no-2xx sigue siendo down', async () => {
  const url = urlForEndpointKey('statusecf_subsistema');
  const r = await runCheck({ url, expect: 'http' }, async () => fakeResponse(503, 'Service Unavailable'));
  assert.equal(r.status, 'down'); assert.equal(r.error_type, 'http');
});
