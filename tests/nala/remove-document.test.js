// NALA · quitar UN archivo de un lote (subido al formato equivocado): borra sus comprobantes y deja nota en el
// historial; se niega si ya fue exportado. Usa una base en memoria (no necesita Postgres).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'x';
const root = path.join(__dirname, '../..');
const stub = (rel, exp) => { const f = require.resolve(path.join(root, rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };

const T = 'tenant-1', B = '11111111-1111-4111-8111-111111111111', D1 = '22222222-2222-4222-8222-222222222222', D2 = '33333333-3333-4333-8333-333333333333';
let db, removed, events;
const reset = () => {
  db = {
    nala_documents: [{ id: D1, tenant_id: T, batch_id: B, original_name: 'FACTURA A EMPRESA.pdf', sha256: 'a'.repeat(64), storage_path: 't/b/d1/f.pdf', status: 'processed', parent_id: null },
      { id: D2, tenant_id: T, batch_id: B, original_name: 'VENTAS.pdf', sha256: 'b'.repeat(64), storage_path: 't/b/d2/v.pdf', status: 'processed', parent_id: null }],
    nala_invoices: [{ id: 'i1', tenant_id: T, document_id: D1, ncf: 'B0100001815', status: 'excluded' }, { id: 'i2', tenant_id: T, document_id: D2, ncf: 'B0100000079', status: 'approved' }],
    nala_export_lines: [], nala_batches: [{ id: B, tenant_id: T, client_id: 'c1', name: '607 10/2026' }],
  };
  removed = []; events = [];
};
const from = table => {
  let rows = db[table] || []; let op = 'select'; const f = [];
  const q = {
    select() { return q; }, delete() { op = 'delete'; return q; },
    eq(k, v) { f.push(r => r[k] === v); return q; }, in(k, vs) { f.push(r => vs.includes(r[k])); return q; }, limit() { return q; },
    maybeSingle() { return Promise.resolve({ data: apply()[0] || null, error: null }); },
    then(ok, bad) { return Promise.resolve(run()).then(ok, bad); },
  };
  const apply = () => rows.filter(r => f.every(fn => fn(r)));
  const run = () => { const hit = apply(); if (op === 'delete') { db[table] = rows.filter(r => !hit.includes(r)); return { data: null, error: null }; } return { data: hit, error: null }; };
  return q;
};
stub('lib/supabase.js', { from, rpc: async () => ({ data: null, error: null }) });
stub('lib/nala/storage.js', { remove: async paths => { removed.push(...paths); } });
stub('lib/nala/store.js', { logEvent: async (ctx, e) => { events.push(e); }, getClient: async () => ({}), getBatch: async (ctx, id) => db.nala_batches.find(b => b.id === id), getInvoice: async () => ({}), findDuplicates: async () => [], evaluate: async () => ({}), stripComputed: x => x, refreshPeers: async () => {} });
const batches = require('../../lib/nala/api/batches');
const ctx = { tenantId: T, require: () => {}, requireClient: () => {} };

test('quita el archivo, sus comprobantes y el original; deja nota; no toca los demás archivos', async () => {
  reset();
  const r = await batches.removeDocument(ctx, D1);
  assert.deepEqual(r, { removed: true, invoices: 1 });
  assert.deepEqual(db.nala_documents.map(d => d.id), [D2]);
  assert.deepEqual(db.nala_invoices.map(i => i.id), ['i2'], 'los comprobantes del otro archivo siguen');
  assert.deepEqual(removed, ['t/b/d1/f.pdf']);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'document_removed');
  assert.equal(events[0].details.original_name, 'FACTURA A EMPRESA.pdf');
  assert.equal(events[0].details.invoices[0].ncf, 'B0100001815');
});

test('se niega si algún comprobante ya está en una exportación', async () => {
  reset(); db.nala_export_lines.push({ invoice_id: 'i1' });
  await assert.rejects(() => batches.removeDocument(ctx, D1), e => e.status === 409 && /exportaci/i.test(e.message));
  assert.equal(db.nala_documents.length, 2); assert.equal(events.length, 0);
});

test('documento inexistente o de otra empresa: 404', async () => {
  reset();
  await assert.rejects(() => batches.removeDocument({ ...ctx, tenantId: 'otro' }, D1), e => e.status === 404);
});
