const test = require('node:test');
const assert = require('node:assert');
const T = require('../../public/js/totp.js');

// Vectores de RFC 6238 (secreto ASCII «12345678901234567890» = base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ).
const S1 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
test('RFC 6238: SHA-1, 8 dígitos', async () => {
  const cfg = { ...T.parse(S1), digits: 8 };
  assert.strictEqual((await T.generate(cfg, 59 * 1000)).code, '94287082');
  assert.strictEqual((await T.generate(cfg, 1111111109 * 1000)).code, '07081804');
  assert.strictEqual((await T.generate(cfg, 20000000000 * 1000)).code, '65353130');
});
test('6 dígitos y cuenta regresiva de 30 s', async () => {
  const r = await T.generate(S1, 59 * 1000);
  assert.strictEqual(r.code, '287082'); assert.strictEqual(r.remaining, 1); assert.strictEqual(r.period, 30);
  assert.strictEqual((await T.generate(S1, 60 * 1000)).remaining, 30);
});
test('acepta la clave con espacios/guiones/minúsculas y el enlace otpauth', async () => {
  const spaced = 'gezd gnbv-gy3t qojq gezd gnbv gy3t qojq';
  assert.strictEqual((await T.generate(spaced, 59000)).code, '287082');
  const link = `otpauth://totp/DGII:QUIDDOMUS?secret=${S1}&issuer=DGII&period=30&digits=6&algorithm=SHA1`;
  assert.strictEqual((await T.generate(link, 59000)).code, '287082');
  assert.strictEqual(T.parse(`otpauth://totp/x?secret=${S1}&digits=8&period=60`).period, 60);
});
test('SHA-256 (RFC 6238, secreto de 32 bytes)', async () => {
  const s256 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA'; // «12345678901234567890123456789012»
  const cfg = { ...T.parse(`otpauth://totp/x?secret=${s256}&algorithm=SHA256&digits=8`) };
  assert.strictEqual((await T.generate(cfg, 59000)).code, '46119246');
});
test('claves inválidas fallan con mensaje claro', () => {
  assert.throws(() => T.parse(''), /Falta/);
  assert.throws(() => T.parse('hola!!'), /no es válida/);
  assert.throws(() => T.parse('ABCD'), /corta/);
  assert.strictEqual(T.isValid(S1), true); assert.strictEqual(T.isValid('xx'), false);
});
