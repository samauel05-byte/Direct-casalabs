const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'x';
const root = path.join(__dirname, '../..');
const stub = (rel, exp) => { const f = require.resolve(path.join(root, rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };

const DATA = {
  direct_clients: [{ id: 'c1', legal_name: 'EMPRESA PRUEBA SRL', rnc: '131557122', cedula: null, status: 'active' }],
  nala_members: [], nala_member_clients: [],
  nala_invoices: [
    { id: 'i1', client_id: 'c1', format: '606', period: '202609', status: 'approved', corrected_fields: [], fields: { ncf: 'B0100000001', fecha_comprobante: '2026-09-05', rnc_cedula: '101010101', tipo_bienes_servicios: '02', monto_servicios: '1000.00', monto_bienes: '0.00', itbis: '180.00', forma_pago: '01' }, counterpart_id: '101010101' },
    { id: 'i2', client_id: 'c1', format: '606', period: '202609', status: 'pending_review', corrected_fields: [], fields: { ncf: 'B0100000002', fecha_comprobante: '2026-09-06' } },
  ],
};
const query = table => {
  let rows = DATA[table] || []; const q = {
    select() { return q; }, eq(k, v) { rows = rows.filter(r => r[k] === undefined || r[k] === v); return q; }, in(k, vs) { rows = rows.filter(r => vs.includes(r[k])); return q; },
    neq(k, v) { rows = rows.filter(r => r[k] !== v); return q; }, limit() { return q; }, maybeSingle() { return Promise.resolve({ data: rows[0] || null, error: null }); },
    then(res) { return Promise.resolve({ data: rows, error: null }).then(res); },
  };
  return q;
};
stub('lib/supabase.js', { from: query });
stub('lib/nala/settings.js', { load: async () => ({ rules: {} }) });
const { handle } = require(path.join(root, 'lib/cami-nala.js'));

const run = (session, q) => new Promise(resolve => {
  const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); }, end() { resolve({ code: this.code }); } };
  handle({ method: 'GET', query: q }, res, session);
});
const sess = { role: 'user', access_cami: true, tenantId: 't1', userId: 'u1' };

test('trae solo lo aprobado, con columnas oficiales, y cuenta los pendientes', async () => {
  const r = await run(sess, { rnc: '131-55712-2', periodo: '202609' });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.client.legal_name, 'EMPRESA PRUEBA SRL');
  const f = r.body.formatos['606'];
  assert.strictEqual(f.aprobados, 1); assert.strictEqual(f.pendientes, 1);
  assert.ok(f.headers.includes('NCF') && f.headers.includes('Tipo Bienes y Servicios Comprados') && f.headers.includes('Forma de Pago'));
  assert.strictEqual(f.rows.length, 1);
  assert.strictEqual(f.rows[0]['NCF'], 'B0100000001');
  assert.strictEqual(f.rows[0]['Monto Facturado en Servicios'], '1000.00');
  assert.strictEqual(r.body.formatos['607'].aprobados, 0);
});
test('sin permiso, sin RNC o período inválido, y empresa desconocida', async () => {
  assert.strictEqual((await run({ role: 'user', tenantId: 't1' }, { rnc: '1', periodo: '202609' })).code, 403);
  assert.strictEqual((await run(sess, { periodo: '202609' })).code, 400);
  assert.strictEqual((await run(sess, { rnc: '131557122', periodo: '2026-13' })).code, 400);
  const r = await run(sess, { rnc: '999999999', periodo: '202609' });
  assert.strictEqual(r.body.client, null);
});
test('un usuario con alcance limitado en NALA no ve empresas no asignadas', async () => {
  DATA.nala_members = [{ user_id: 'u1', all_clients: false }]; DATA.nala_member_clients = [];
  assert.strictEqual((await run(sess, { rnc: '131557122', periodo: '202609' })).code, 403);
  DATA.nala_member_clients = [{ user_id: 'u1', client_id: 'c1' }];
  assert.strictEqual((await run(sess, { rnc: '131557122', periodo: '202609' })).code, 200);
});
