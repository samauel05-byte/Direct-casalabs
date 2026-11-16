// Orden de las facturas de una lista: documento → página → posición fijada por la persona → orden de lectura → fecha.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'x';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cmpRows } = require('../../lib/nala/api/invoices');

const r = (id, o = {}) => ({ id, document_id: 'd1', page_from: 69, page_to: 69, sort_pos: null, extraction_key: null, invoice_date: '2026-10-01', ...o });

test('la posición fijada manda sobre la fecha y el orden de lectura', () => {
  const rows = [r('a', { sort_pos: 3, invoice_date: '2026-10-01' }), r('b', { sort_pos: 1, invoice_date: '2026-10-31' }), r('c', { sort_pos: 2 })];
  assert.deepEqual(rows.sort(cmpRows).map(x => x.id), ['b', 'c', 'a']);
});

test('sin posición fijada, sigue el orden en que se leyó la lista (último número de extraction_key)', () => {
  const rows = [r('x', { extraction_key: 'job:70:10' }), r('y', { extraction_key: 'job:70:2' }), r('z', { extraction_key: 'job:70:9' })];
  assert.deepEqual(rows.sort(cmpRows).map(x => x.id), ['y', 'z', 'x']);
});

test('las que tienen posición van antes que las que no, y la página manda sobre la posición', () => {
  const rows = [r('p70', { page_from: 70, page_to: 70, sort_pos: 1 }), r('manual', { extraction_key: 'manual:abc', invoice_date: '2026-10-02' }), r('p69', { sort_pos: 5 })];
  assert.deepEqual(rows.sort(cmpRows).map(x => x.id), ['p69', 'manual', 'p70']);
});
