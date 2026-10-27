const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'x';
const root = path.join(__dirname, '../..');
const calls = [];
let rows = 1;
const stub = (rel, exp) => { const f = require.resolve(path.join(root, rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };
const chain = { update(v) { calls.push(['update', v]); return chain; }, eq(k, v) { calls.push(['eq', k, v]); return chain; }, select() { return Promise.resolve({ data: Array(rows).fill({ id: 'u1' }), error: null }); } };
stub('lib/supabase.js', { from: () => chain });
stub('lib/auth.js', { authenticate: async req => (req.headers.authorization ? { userId: 'u1' } : null), loadProfile: async () => ({ profile: null }) });
stub('lib/rate-limit.js', { allow: async () => true });
stub('lib/db.js', {});
const handler = require(path.join(root, 'api/auth/login.js'));

const run = body => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, body: b }); }, end() { resolve({ code: this.statusCode }); } };
  handler({ method: 'PATCH', headers: { authorization: 'Bearer t' }, body }, res);
});
const good = { prevSalt: 'AAAAAAAAAAAAAAAAAAAAAA==', userSalt: 'v2$AAAAAAAAAAAAAAAAAAAAAA==', vaultKeyIv: 'AAAAAAAAAAAAAAAA', vaultKeyCt: 'A'.repeat(62) + '==' };

test('PATCH migra sólo al propio usuario con compare-and-swap de la sal anterior', async () => {
  calls.length = 0;
  const r = await run(good);
  assert.strictEqual(r.code, 200); assert.strictEqual(r.body.updated, 1);
  assert.ok(calls.some(c => c[0] === 'eq' && c[1] === 'id' && c[2] === 'u1'));
  assert.ok(calls.some(c => c[0] === 'eq' && c[1] === 'user_key_salt' && c[2] === good.prevSalt));
});
test('PATCH rechaza sal que no es v2 y datos mal formados', async () => {
  assert.strictEqual((await run({ ...good, userSalt: 'AAAAAAAAAAAAAAAAAAAAAA==' })).code, 400);
  assert.strictEqual((await run({ ...good, vaultKeyIv: 'no base64!' })).code, 400);
  assert.strictEqual((await run({ ...good, vaultKeyCt: 'A'.repeat(300) })).code, 400);
});
test('PATCH sin sesión es 401 y si la sal cambió no actualiza nada', async () => {
  const noAuth = await new Promise(resolve => { const res = { status(c) { this.c = c; return this; }, json() { resolve(this.c); }, end() { resolve(this.c); } }; handler({ method: 'PATCH', headers: {}, body: good }, res); });
  assert.strictEqual(noAuth, 401);
  rows = 0; const r = await run(good); rows = 1;
  assert.strictEqual(r.body.updated, 0);
});
