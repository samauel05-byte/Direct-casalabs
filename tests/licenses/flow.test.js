// Licencias de Direct de punta a punta en el stack local: emisión por root,
// activación con enlace de un solo uso, aislamiento de la firma nueva,
// vencimiento, suspensión y tope de usuarios. Run: npm run test:licenses
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { startStack } = require('../nala/support/stack');
let L; // se carga tras levantar el stack (necesita SUPABASE_URL)

let stack; let db;
const sessions = {};
const ROOT_ID = '00000000-0000-0000-0000-00000000a001'; // admin@direct.local del sembrado: lo usamos de «root»

async function login(username, password) {
  const r = await fetch(`${stack.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const data = await r.json();
  if (r.status === 200) sessions[username] = { authorization: `Bearer ${data.access_token}`, 'x-direct-session': data.session_id };
  return { status: r.status, data };
}
async function call(user, method, route, body) {
  const r = await fetch(`${stack.base}${route}`, { method, headers: { ...(user ? sessions[user] : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: r.status, data };
}
const crypt = { userSalt: 'v2$' + 'A'.repeat(22) + '==', vaultKeyIv: 'AAAAAAAAAAAAAAAA', vaultKeyCt: 'A'.repeat(64), vaultSalt: 'A'.repeat(22) + '==', verifierIv: 'AAAAAAAAAAAAAAAA', verifierCt: 'A'.repeat(64) };
const tokenOf = link => new URL(link).searchParams.get('t');

test.before(async () => {
  stack = await startStack({ openai: false });
  L = require('../../lib/licenses');
  db = new Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/nala_test' });
  await db.connect();
  await db.query('update direct_profiles set is_platform_admin = true where id = $1', [ROOT_ID]);
  await login('admin', 'Admin#2026');
});
test.after(async () => { await db?.end(); await stack?.stop(); });

test('solo el administrador de la plataforma emite y ve licencias', async () => {
  await login('oficial', 'Oficial#2026'); await login('otraadmin', 'Otra#2026');
  assert.equal((await call(null, 'GET', '/api/licenses/list')).status, 401);
  assert.equal((await call('oficial', 'GET', '/api/licenses/list')).status, 403);
  assert.equal((await call('otraadmin', 'POST', '/api/licenses/create', { customer_name: 'X Y', customer_email: 'x@y.com', months: 1 })).status, 403); // admin de otra firma, no de la plataforma
  const r = await call('admin', 'GET', '/api/licenses/list');
  assert.equal(r.status, 200); assert.ok(r.data.tenants.some(t => t.slug === 'save'));
  const me = await login('admin', 'Admin#2026'); assert.equal(me.data.platformAdmin, true);
  assert.notEqual((await login('oficial', 'Oficial#2026')).data.platformAdmin, true);
});

test('emitir, validar datos y activar: crea firma, administrador y bóveda; el enlace sirve una sola vez', async () => {
  const bad = await call('admin', 'POST', '/api/licenses/create', { customer_name: 'A', customer_email: 'mal', months: 99 });
  assert.equal(bad.status, 400);
  const c = await call('admin', 'POST', '/api/licenses/create', { customer_name: 'Contadores Nuevos SRL', customer_email: 'nuevo@cliente.com', plan: 'Completo', months: 3, max_users: 2, send_email: false });
  assert.equal(c.status, 201); assert.equal(c.data.emailSent, false);
  const token = tokenOf(c.data.link);
  const { rows: [stored] } = await db.query('select token_hash from direct_licenses limit 1');
  assert.notEqual(stored.token_hash, token); assert.equal(stored.token_hash.length, 64); // nunca se guarda el token en claro

  const info = await call(null, 'GET', `/api/licenses/activate?token=${token}`);
  assert.equal(info.status, 200); assert.equal(info.data.customerName, 'Contadores Nuevos SRL');
  assert.equal((await call(null, 'GET', '/api/licenses/activate?token=nada-nada-nada-nada-nada')).status, 404);

  const body = { token, firmName: 'Contadores Nuevos SRL', username: 'nuevo.admin', password: 'ClaveSegura#1', ...crypt };
  assert.equal((await call(null, 'POST', '/api/licenses/activate', { ...body, password: 'corta' })).status, 400);
  assert.equal((await call(null, 'POST', '/api/licenses/activate', { ...body, username: 'root' })).status, 400);
  assert.equal((await call(null, 'POST', '/api/licenses/activate', { ...body, userSalt: 'malo' })).status, 400);
  const act = await call(null, 'POST', '/api/licenses/activate', body);
  assert.equal(act.status, 200, JSON.stringify(act.data));
  assert.equal((await call(null, 'POST', '/api/licenses/activate', body)).status, 404, 'el enlace ya se usó');
  assert.equal((await call(null, 'GET', `/api/licenses/activate?token=${token}`)).status, 404);

  const lg = await login('nuevo.admin', 'ClaveSegura#1');
  assert.equal(lg.status, 200, JSON.stringify(lg.data));
  assert.equal(lg.data.role, 'admin'); assert.equal(lg.data.vaultKeyCt, crypt.vaultKeyCt);
  assert.equal(lg.data.license.code, 'active');
  assert.equal(lg.data.config.vaultSalt, crypt.vaultSalt); // la bóveda de la firma nueva viaja con su login
  const { rows: [t] } = await db.query("select t.* from direct_tenants t join direct_profiles p on p.tenant_id = t.id join auth.users u on u.id = p.id where u.email = 'nuevo.admin@direct.local'");
  assert.equal(t.name, 'Contadores Nuevos SRL'); assert.equal(t.license_plan, 'Completo'); assert.equal(t.max_users, 2);
  assert.ok(new Date(t.license_until) > new Date(Date.now() + 80 * 864e5));
  assert.equal((await db.query("select status from direct_licenses where tenant_id = $1", [t.id])).rows[0].status, 'activated');
  // La firma nueva está aislada: no ve los clientes de otras firmas y no administra licencias.
  const cl = await call('nuevo.admin', 'GET', '/api/clients');
  assert.equal(cl.status, 200); assert.equal(cl.data.clients.length, 0);
  assert.equal((await call('nuevo.admin', 'GET', '/api/licenses/list')).status, 403);
  state.tenantId = t.id;
});
const state = {};

test('usuario repetido: 409 y la licencia queda pendiente para reintentar', async () => {
  const c = await call('admin', 'POST', '/api/licenses/create', { customer_name: 'Otra Firma SA', customer_email: 'otra@cliente.com', months: 1, send_email: false });
  const token = tokenOf(c.data.link);
  const dup = await call(null, 'POST', '/api/licenses/activate', { token, firmName: 'Otra Firma SA', username: 'nuevo.admin', password: 'ClaveSegura#2', ...crypt });
  assert.equal(dup.status, 409);
  assert.equal((await db.query("select status from direct_licenses where customer_email = 'otra@cliente.com'")).rows[0].status, 'pending');
  assert.equal((await db.query("select count(*)::int n from direct_tenants where name = 'Otra Firma SA'")).rows[0].n, 0, 'no queda firma a medias');
  const ok = await call(null, 'POST', '/api/licenses/activate', { token, firmName: 'Otra Firma SA', username: 'otra.firma', password: 'ClaveSegura#2', ...crypt });
  assert.equal(ok.status, 200);
});

test('reenviar y anular licencias pendientes', async () => {
  const c = await call('admin', 'POST', '/api/licenses/create', { customer_name: 'Cliente Pendiente', customer_email: 'p@cliente.com', months: 1, send_email: false });
  const old = tokenOf(c.data.link);
  const re = await call('admin', 'POST', '/api/licenses/resend', { id: c.data.id });
  assert.equal(re.status, 200); assert.notEqual(tokenOf(re.data.link), old);
  assert.equal((await call(null, 'GET', `/api/licenses/activate?token=${old}`)).status, 404, 'el enlace anterior deja de servir');
  assert.equal((await call('admin', 'POST', '/api/licenses/revoke', { id: c.data.id })).status, 200);
  assert.equal((await call(null, 'GET', `/api/licenses/activate?token=${tokenOf(re.data.link)}`)).status, 404);
  assert.equal((await call('admin', 'POST', '/api/licenses/revoke', { id: c.data.id })).status, 409);
});

test('tope de usuarios de la licencia', async () => {
  const mk = u => call('nuevo.admin', 'POST', '/api/users', { username: u, password: 'ClaveSegura#3', role: 'user', userSalt: crypt.userSalt, vaultKeyIv: crypt.vaultKeyIv, vaultKeyCt: crypt.vaultKeyCt });
  assert.equal((await mk('empleado.uno')).status, 200);
  const over = await mk('empleado.dos');
  assert.equal(over.status, 403); assert.match(over.data.error, /hasta 2 usuarios/);
});

test('vencimiento: gracia, bloqueo y renovación; la firma de la plataforma nunca vence', async () => {
  await db.query('delete from rate_limits'); // el límite de inicios de sesión (10 por 15 min) no es lo que se prueba aquí
  const day = 864e5;
  await db.query('update direct_tenants set license_until = $2 where id = $1', [state.tenantId, new Date(Date.now() - 2 * day)]); L.forget(state.tenantId);
  const grace = await login('nuevo.admin', 'ClaveSegura#1');
  assert.equal(grace.status, 200); assert.equal(grace.data.license.code, 'grace');
  await db.query('update direct_tenants set license_until = $2 where id = $1', [state.tenantId, new Date(Date.now() - 9 * day)]); L.forget(state.tenantId);
  const blocked = await login('nuevo.admin', 'ClaveSegura#1');
  assert.equal(blocked.status, 403); assert.match(blocked.data.error, /venció/);
  assert.equal((await call('nuevo.admin', 'GET', '/api/clients')).status, 401, 'la sesión abierta también deja de servir');
  const ext = await call('admin', 'POST', '/api/licenses/extend', { tenant_id: state.tenantId, months: 1 });
  assert.equal(ext.status, 200);
  assert.equal((await login('nuevo.admin', 'ClaveSegura#1')).status, 200, 'renovada, vuelve a entrar');
  const saveId = (await db.query("select id from direct_tenants where slug = 'save'")).rows[0].id;
  assert.equal((await call('admin', 'POST', '/api/licenses/suspend', { tenant_id: saveId })).status, 409);
  assert.equal((await call('admin', 'POST', '/api/licenses/extend', { tenant_id: saveId, months: 1 })).status, 409);
});

test('suspender y reactivar una firma', async () => {
  await db.query('delete from rate_limits');
  assert.equal((await call('admin', 'POST', '/api/licenses/suspend', { tenant_id: state.tenantId })).status, 200);
  const s = await login('nuevo.admin', 'ClaveSegura#1');
  assert.equal(s.status, 403); assert.match(s.data.error, /suspendida/);
  assert.equal((await call('admin', 'POST', '/api/licenses/resume', { tenant_id: state.tenantId })).status, 200);
  assert.equal((await login('nuevo.admin', 'ClaveSegura#1')).status, 200);
  // Las firmas anteriores a las licencias no tienen vencimiento y siguen entrando igual.
  assert.equal((await login('oficial', 'Oficial#2026')).data.license.code, 'unlimited');
});
