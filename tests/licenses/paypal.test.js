// Cobro con PayPal: el webhook crea la licencia, el cliente la activa y cada
// cobro mensual renueva la firma. PayPal se emula con un servidor local.
// Run: npm run test:licenses
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { Client } = require('pg');
const { startStack } = require('../nala/support/stack');

let stack, db, fake, fakeBase;
const subs = {};
const sessions = {};
const day = 864e5;
const ROOT_ID = '00000000-0000-0000-0000-00000000a001';

function startFakePayPal() {
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { /* el token va como formulario */ }
      const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/v1/oauth2/token') return send(200, { access_token: 'tok', expires_in: 3600 });
      if (req.url === '/v1/notifications/verify-webhook-signature') return send(200, { verification_status: body.transmission_sig === 'bad' ? 'FAILURE' : 'SUCCESS' });
      let m;
      if ((m = /^\/v1\/billing\/subscriptions\/([^/]+)$/.exec(req.url))) return subs[m[1]] ? send(200, subs[m[1]]) : send(404, { name: 'RESOURCE_NOT_FOUND' });
      if ((m = /^\/v1\/billing\/plans\/([^/]+)$/.exec(req.url))) return send(200, { id: m[1], name: 'Direct Mensual' });
      send(404, {});
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function login(u, p) {
  const r = await fetch(`${stack.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
  const d = await r.json(); assert.equal(r.status, 200, JSON.stringify(d));
  sessions[u] = { authorization: `Bearer ${d.access_token}`, 'x-direct-session': d.session_id };
  return d;
}
async function call(user, method, route, body, extra = {}) {
  const r = await fetch(`${stack.base}${route}`, { method, headers: { ...(user ? sessions[user] : {}), ...extra, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = { raw: t }; }
  return { status: r.status, data: d };
}
const hook = (event, sig = 'ok') => call(null, 'POST', '/api/licenses/paypal-webhook', event, { 'paypal-transmission-sig': sig, 'paypal-transmission-id': 't', 'paypal-transmission-time': 'now', 'paypal-cert-url': 'x', 'paypal-auth-algo': 'x' });
const crypt = { userSalt: 'v2$' + 'A'.repeat(22) + '==', vaultKeyIv: 'AAAAAAAAAAAAAAAA', vaultKeyCt: 'A'.repeat(64), vaultSalt: 'A'.repeat(22) + '==', verifierIv: 'AAAAAAAAAAAAAAAA', verifierCt: 'A'.repeat(64) };

test.before(async () => {
  fake = await startFakePayPal(); fakeBase = `http://127.0.0.1:${fake.address().port}`;
  Object.assign(process.env, { PAYPAL_BASE_URL: fakeBase, PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_WEBHOOK_ID: 'WH-1', PAYPAL_PLANS: JSON.stringify({ 'P-MES': { plan: 'Completo', max_users: 3 } }) });
  stack = await startStack({ openai: false });
  db = new Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/nala_test' }); await db.connect();
  await db.query('update direct_profiles set is_platform_admin = true where id = $1', [ROOT_ID]);
  await login('admin', 'Admin#2026');
});
test.after(async () => { await db?.end(); await stack?.stop(); fake?.close(); });

test('un aviso con firma inválida o sin PayPal configurado se rechaza', async () => {
  const ev = { id: 'EV-bad', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-1' } };
  assert.equal((await hook(ev, 'bad')).status, 400);
  assert.equal((await hook({ nope: true })).status, 400);
  assert.equal((await call(null, 'GET', '/api/licenses/paypal-webhook')).status, 405);
  assert.equal((await db.query('select count(*)::int n from direct_licenses where source = $1', ['paypal'])).rows[0].n, 0);
});

test('suscripción activada: se crea la licencia con lo pagado y el plan; los avisos repetidos no duplican', async () => {
  const next = new Date(Date.now() + 30 * day).toISOString();
  subs['I-1'] = { id: 'I-1', status: 'ACTIVE', plan_id: 'P-MES', subscriber: { email_address: 'Cliente@Firma.com', name: { given_name: 'Ana', surname: 'Pérez' } }, billing_info: { next_billing_time: next } };
  const r = await hook({ id: 'EV-1', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-1' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const { rows } = await db.query("select * from direct_licenses where paypal_subscription_id = 'I-1'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].customer_email, 'cliente@firma.com'); assert.equal(rows[0].customer_name, 'Ana Pérez');
  assert.equal(rows[0].plan, 'Completo'); assert.equal(rows[0].max_users, 3); assert.equal(rows[0].source, 'paypal'); assert.equal(rows[0].status, 'pending');
  assert.equal(new Date(rows[0].paid_until).toISOString(), next);
  assert.equal((await hook({ id: 'EV-1', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-1' } })).data.duplicate, true);
  await hook({ id: 'EV-2', event_type: 'PAYMENT.SALE.COMPLETED', resource: { billing_agreement_id: 'I-1' } });
  assert.equal((await db.query("select count(*)::int n from direct_licenses where paypal_subscription_id = 'I-1'")).rows[0].n, 1, 'el primer cobro no crea otra licencia');
  state.licId = rows[0].id; state.next = next;
});
const state = {};

test('una suscripción que no está activa o no existe no crea licencia', async () => {
  subs['I-2'] = { id: 'I-2', status: 'APPROVAL_PENDING', plan_id: 'P-MES', subscriber: { email_address: 'x@y.com' }, billing_info: {} };
  assert.equal((await hook({ id: 'EV-3', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-2' } })).status, 200);
  assert.equal((await db.query("select count(*)::int n from direct_licenses where paypal_subscription_id = 'I-2'")).rows[0].n, 0);
  const missing = await hook({ id: 'EV-4', event_type: 'PAYMENT.SALE.COMPLETED', resource: { billing_agreement_id: 'I-404' } });
  assert.equal(missing.status, 500, 'PayPal reintentará el aviso');
  assert.equal((await db.query("select count(*)::int n from direct_paypal_events where event_id = 'EV-4'")).rows[0].n, 0, 'un aviso fallido no se da por procesado');
});

test('el cliente activa con el enlace: la firma hereda lo pagado y el tope de usuarios; luego cada cobro la renueva', async () => {
  const re = await call('admin', 'POST', '/api/licenses/resend', { id: state.licId });
  assert.equal(re.status, 200);
  const token = new URL(re.data.link).searchParams.get('t');
  const act = await call(null, 'POST', '/api/licenses/activate', { token, firmName: 'Firma de Ana', username: 'ana.firma', password: 'ClaveSegura#1', ...crypt });
  assert.equal(act.status, 200, JSON.stringify(act.data));
  const t = (await db.query("select * from direct_tenants where paypal_subscription_id = 'I-1'")).rows[0];
  assert.equal(t.name, 'Firma de Ana'); assert.equal(t.max_users, 3); assert.equal(t.license_plan, 'Completo');
  assert.equal(new Date(t.license_until).toISOString(), state.next);

  const next2 = new Date(Date.now() + 61 * day).toISOString();
  subs['I-1'].billing_info.next_billing_time = next2;
  assert.equal((await hook({ id: 'EV-5', event_type: 'PAYMENT.SALE.COMPLETED', resource: { billing_agreement_id: 'I-1' } })).status, 200);
  const t2 = (await db.query('select license_until from direct_tenants where id = $1', [t.id])).rows[0];
  assert.equal(new Date(t2.license_until).toISOString(), next2, 'el mes pagado se suma a la firma');
  assert.equal((await db.query("select paid_until from direct_licenses where id = $1", [state.licId])).rows[0].paid_until.toISOString(), next2);
  state.tenantId = t.id; state.next2 = next2;
});

test('cancelar o fallar el cobro no quita lo ya pagado; una suspensión manual de root no se revierte', async () => {
  subs['I-1'].status = 'CANCELLED';
  assert.equal((await hook({ id: 'EV-6', event_type: 'BILLING.SUBSCRIPTION.CANCELLED', resource: { id: 'I-1' } })).status, 200);
  const lic = (await db.query('select paypal_status from direct_licenses where id = $1', [state.licId])).rows[0];
  assert.equal(lic.paypal_status, 'CANCELLED');
  assert.equal(new Date((await db.query('select license_until from direct_tenants where id = $1', [state.tenantId])).rows[0].license_until).toISOString(), state.next2);

  subs['I-1'].status = 'ACTIVE';
  assert.equal((await call('admin', 'POST', '/api/licenses/suspend', { tenant_id: state.tenantId })).status, 200);
  subs['I-1'].billing_info.next_billing_time = new Date(Date.now() + 91 * day).toISOString();
  await hook({ id: 'EV-7', event_type: 'PAYMENT.SALE.COMPLETED', resource: { billing_agreement_id: 'I-1' } });
  assert.equal((await db.query('select license_status from direct_tenants where id = $1', [state.tenantId])).rows[0].license_status, 'suspended');
});

test('el panel de root informa que PayPal está configurado y marca las licencias de PayPal', async () => {
  const d = (await call('admin', 'GET', '/api/licenses/list')).data;
  assert.equal(d.paypalConfigured, true);
  assert.ok(d.licenses.some(l => l.source === 'paypal' && l.paypal_status));
  assert.ok(d.tenants.some(t => t.paypal_subscription_id === 'I-1'));
});
