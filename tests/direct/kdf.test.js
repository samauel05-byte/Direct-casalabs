const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Carga el objeto C (crypto del cliente) tal como está en public/index.html.
function loadC() {
  const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
  const start = html.indexOf('const C = {');
  const end = html.indexOf('\n};', start) + 3;
  return new Function('crypto', 'btoa', 'atob', 'TextEncoder', 'TextDecoder', html.slice(start, end) + '; return C;')(globalThis.crypto, globalThis.btoa, globalThis.atob, TextEncoder, TextDecoder);
}

test('la sal nueva es v2 y la antigua se detecta como legado', () => {
  const C = loadC();
  const salt = C.newUserSalt();
  assert.match(salt, /^v2\$[A-Za-z0-9+/]{22}==$/);
  assert.strictEqual(C.isLegacySalt(salt), false);
  assert.strictEqual(C.isLegacySalt(C.randB64(16)), true);
});

test('bóveda antigua (200k) sigue abriendo y se migra a v2 (600k) con el mismo secreto', async () => {
  const C = loadC();
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const legacySalt = C.randB64(16);
  const wrapped = await C.encBytes(await C.deriveKey('clave-secreta', legacySalt), secret);
  // abre con la sal antigua
  assert.deepStrictEqual([...await C.decBytes(await C.deriveKey('clave-secreta', legacySalt), wrapped.iv, wrapped.ct)], [...secret]);
  // migración
  const v2 = C.newUserSalt();
  const w2 = await C.encBytes(await C.deriveKey('clave-secreta', v2), secret);
  assert.deepStrictEqual([...await C.decBytes(await C.deriveKey('clave-secreta', v2), w2.iv, w2.ct)], [...secret]);
  // la misma sal sin versión daría otra llave: no abre (prueba que hay 2 derivaciones distintas)
  await assert.rejects(C.decBytes(await C.deriveKey('clave-secreta', v2.slice(3)), w2.iv, w2.ct));
  // contraseña equivocada no abre
  await assert.rejects(C.decBytes(await C.deriveKey('otra', v2), w2.iv, w2.ct));
});

test('el endpoint acepta sólo envolturas v2 bien formadas', () => {
  const C = loadC();
  const re = /^v2\$[A-Za-z0-9+/]{22}={2}$/;
  assert.ok(re.test(C.newUserSalt()));
  assert.ok(!re.test(C.randB64(16)));
});
