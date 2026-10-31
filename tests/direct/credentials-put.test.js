const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Prueba el handler PUT/DELETE /api/credentials/:id con la sesión y la base simuladas.
function loadHandler({ session, rows }) {
  const authPath = require.resolve('../../lib/auth');
  const dbPath = require.resolve('../../lib/db');
  const handlerPath = require.resolve('../../api/credentials/[id].js');
  const writes = []; const deletes = [];
  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { authenticate: async () => session } };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
    getCredential: async (_t, id) => rows[id] || null,
    upsertCredential: async (...a) => { writes.push(a); },
    deleteCredential: async (...a) => { deletes.push(a); },
  } };
  delete require.cache[handlerPath];
  return { handler: require(handlerPath), writes, deletes };
}
const call = (handler, method, id, body) => new Promise(resolve => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); }, end() { resolve({ status: this.statusCode, body: null }); } };
  handler({ method, query: { id }, body, headers: {} }, res);
});
const base = { userId: 'u', tenantId: 't', access_direct: true, portals_direct: ['tss', 'dgii'], companies_direct: null };
const rows = { tss_1: { id: 'tss_1', institution: 'tss', category: 'acceso' }, sirla_1: { id: 'sirla_1', institution: 'sirla', category: 'acceso' } };
const body = (institution = 'tss') => ({ institution, category: 'acceso', iv: 'iv', ct: 'ct' });

test('usuario normal: puede actualizar la clave de una empresa que ve', async () => {
  const { handler, writes } = loadHandler({ session: { ...base, role: 'user' }, rows });
  const r = await call(handler, 'PUT', 'tss_1', body());
  assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.equal(writes.length, 1);
});

test('usuario normal: no crea empresas, no cambia de portal, no ve portales ajenos ni empresas no asignadas', async () => {
  let h = loadHandler({ session: { ...base, role: 'user' }, rows });
  assert.equal((await call(h.handler, 'PUT', 'nueva_1', body())).status, 403, 'no crea');
  assert.equal((await call(h.handler, 'PUT', 'tss_1', body('dgii'))).status, 403, 'no cambia el portal');
  assert.equal((await call(h.handler, 'PUT', 'sirla_1', body('sirla'))).status, 403, 'portal no permitido');
  h = loadHandler({ session: { ...base, role: 'user', companies_direct: ['otra'] }, rows });
  assert.equal((await call(h.handler, 'PUT', 'tss_1', body())).status, 403, 'empresa no asignada');
  assert.equal(h.writes.length, 0);
});

test('usuario normal: no elimina; sin acceso a Direct no entra; el administrador conserva todo', async () => {
  let h = loadHandler({ session: { ...base, role: 'user' }, rows });
  assert.equal((await call(h.handler, 'DELETE', 'tss_1')).status, 403); assert.equal(h.deletes.length, 0);
  h = loadHandler({ session: { ...base, role: 'user', access_direct: false }, rows });
  assert.equal((await call(h.handler, 'PUT', 'tss_1', body())).status, 403);
  h = loadHandler({ session: { ...base, role: 'admin', portals_direct: [] }, rows });
  assert.equal((await call(h.handler, 'PUT', 'nueva_1', body('sirla'))).status, 200, 'admin crea');
  assert.equal((await call(h.handler, 'DELETE', 'tss_1')).status, 200); assert.equal(h.deletes.length, 1);
});
