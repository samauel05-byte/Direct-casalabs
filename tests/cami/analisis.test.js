// CAMI · análisis guardados: permisos, aislamiento por tenant, borrador por usuario y reglas de borrado.
// Usa una base en memoria con la parte del cliente de Supabase que usa lib/cami-analisis.js.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

let rows = []; let seq = 0;
function builder() {
  const st = { op: 'select', filters: [], order: null, limit: null, payload: null, single: false, maybe: false, cols: null };
  const pick = r => (r && st.cols ? Object.fromEntries(st.cols.filter(c => c in r).map(c => [c, r[c]])) : r);
  const run = () => {
    let data = rows.filter(r => st.filters.every(([k, v]) => r[k] === v));
    if (st.op === 'insert') {
      const dup = st.payload.borrador && rows.some(r => r.borrador && r.tenant_id === st.payload.tenant_id && r.created_by === st.payload.created_by);
      if (dup) return { data: null, error: { code: '23505', message: 'duplicate' } };
      const row = { id: '00000000-0000-4000-8000-' + String(++seq).padStart(12, '0'), created_at: new Date().toISOString(), resumen: {}, ...st.payload }; rows.push(row);
      return { data: st.single ? row : [row], error: null };
    }
    if (st.op === 'update') { data.forEach(r => Object.assign(r, st.payload)); }
    else if (st.op === 'delete') { rows = rows.filter(r => !data.includes(r)); return { data: null, error: null }; }
    if (st.order) data = [...data].sort((a, b) => String(b[st.order]).localeCompare(String(a[st.order])));
    if (st.limit) data = data.slice(0, st.limit);
    data = data.map(pick);
    if (st.single || st.maybe) return { data: data[0] || null, error: (st.single && !data[0]) ? { message: 'no rows' } : null };
    return { data, error: null };
  };
  const b = {
    select: c => { st.cols = c && c !== '*' ? c.split(',').map(x => x.trim()) : null; return b; }, eq: (k, v) => { st.filters.push([k, v]); return b; }, order: k => { st.order = k; return b; }, limit: n => { st.limit = n; return b; },
    insert: p => { st.op = 'insert'; st.payload = p; return b; }, update: p => { st.op = 'update'; st.payload = p; return b; }, delete: () => { st.op = 'delete'; return b; },
    single: () => { st.single = true; return b; }, maybeSingle: () => { st.maybe = true; return b; },
    then: (ok, ko) => Promise.resolve(run()).then(ok, ko),
  };
  return b;
}
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (parent && parent.filename && parent.filename.endsWith(path.join('lib', 'cami-analisis.js')) && request === './supabase') return { from: () => builder() };
  return origLoad.call(this, request, parent, ...rest);
};
const { handle } = require('../../lib/cami-analisis.js');
Module._load = origLoad;

const mkRes = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, end() { return r; } }; return r; };
const call = async (method, session, { query = {}, body } = {}) => { const res = mkRes(); await handle({ method, query, body }, res, session); return res; };
const ana = { userId: 'u1', role: 'user', access_cami: true, tenantId: 't1' };
const bob = { userId: 'u2', role: 'user', access_cami: true, tenantId: 't1' };
const admin = { userId: 'u9', role: 'admin', access_cami: false, tenantId: 't1' };
const otro = { userId: 'u3', role: 'user', access_cami: true, tenantId: 't2' };
const DATA = { v: 1, gz: 'AAAA' };

test.beforeEach(() => { rows = []; seq = 0; });

test('sin acceso a CAMI → 403; sin tenant → 409', async () => {
  assert.strictEqual((await call('GET', { ...ana, access_cami: false })).code, 403);
  assert.strictEqual((await call('GET', { ...ana, tenantId: null })).code, 409);
  assert.strictEqual((await call('GET', admin)).code, 200); // el administrador siempre entra
});

test('el borrador es uno por usuario: se sobrescribe y no lo ve otro usuario', async () => {
  let r = await call('POST', ana, { body: { borrador: true, data: DATA, rnc: '1', resumen: { a: 1 } } }); assert.strictEqual(r.code, 200);
  r = await call('POST', ana, { body: { borrador: true, data: { v: 1, gz: 'BBBB' } } }); assert.strictEqual(rows.filter(x => x.borrador).length, 1);
  assert.strictEqual((await call('GET', ana, { query: { borrador: '1' } })).body.record.data.gz, 'BBBB');
  assert.strictEqual((await call('GET', bob, { query: { borrador: '1' } })).body.record, null);
  const id = rows[0].id;
  assert.strictEqual((await call('GET', bob, { query: { id } })).code, 404); // borrador ajeno
  assert.strictEqual((await call('DELETE', bob, { query: { id } })).code, 403);
});

test('copias guardadas: se listan para el equipo, sin data, y se pueden actualizar', async () => {
  const c = await call('POST', ana, { body: { nombre: '  LATVIA 2026-09  ', rnc: '133024381', periodo: '2026-09', data: DATA, resumen: { r606: { n: 3 } } } });
  assert.strictEqual(c.code, 201); const id = c.body.id;
  const l = (await call('GET', bob)).body; assert.strictEqual(l.items.length, 1); assert.strictEqual(l.items[0].nombre, 'LATVIA 2026-09'); assert.strictEqual('data' in l.items[0], false); assert.strictEqual(l.items[0].mio, false);
  assert.strictEqual((await call('POST', bob, { body: { id, nombre: 'Renombrada' } })).code, 200);
  assert.strictEqual((await call('GET', ana, { query: { id } })).body.record.nombre, 'Renombrada');
  assert.strictEqual((await call('GET', ana, { query: { id } })).body.record.data.gz, 'AAAA'); // renombrar no toca data
});

test('aislamiento por tenant', async () => {
  const id = (await call('POST', ana, { body: { nombre: 'X', data: DATA } })).body.id;
  assert.strictEqual((await call('GET', otro)).body.items.length, 0);
  assert.strictEqual((await call('GET', otro, { query: { id } })).code, 404);
  assert.strictEqual((await call('POST', otro, { body: { id, nombre: 'hack' } })).code, 404);
  assert.strictEqual((await call('DELETE', otro, { query: { id } })).code, 404);
  assert.strictEqual(rows[0].nombre, 'X');
});

test('borrar: el autor o un administrador; otro usuario no', async () => {
  const id = (await call('POST', ana, { body: { nombre: 'X', data: DATA } })).body.id;
  assert.strictEqual((await call('DELETE', bob, { query: { id } })).code, 403); assert.strictEqual(rows.length, 1);
  assert.strictEqual((await call('DELETE', admin, { query: { id } })).code, 200); assert.strictEqual(rows.length, 0);
  const id2 = (await call('POST', ana, { body: { nombre: 'Y', data: DATA } })).body.id;
  assert.strictEqual((await call('DELETE', ana, { query: { id: id2 } })).code, 200);
});

test('validaciones: nombre, datos, tamaño, ids', async () => {
  assert.strictEqual((await call('POST', ana, { body: { data: DATA } })).code, 400);                  // sin nombre
  assert.strictEqual((await call('POST', ana, { body: { nombre: 'X' } })).code, 400);                 // sin datos
  assert.strictEqual((await call('POST', ana, { body: { nombre: 'X', data: [1] } })).code, 400);      // data no objeto
  assert.strictEqual((await call('POST', ana, { body: { nombre: 'X', data: { gz: 'a'.repeat(4 * 1024 * 1024) } } })).code, 413);
  assert.strictEqual((await call('GET', ana, { query: { id: "x' or 1=1" } })).code, 400);
  assert.strictEqual((await call('DELETE', ana, { query: {} })).code, 400);
  assert.strictEqual((await call('PUT', ana)).code, 405);
});
