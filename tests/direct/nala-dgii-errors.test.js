const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Carga views-export.js (script de navegador) con un NALA mínimo y devuelve NALA.dgiiErrors.
function load() {
  const esc = v => String(v == null ? '' : v);
  const NALA = { esc, money: v => v, int: v => v, period: v => v, views: {}, can: () => false };
  const ctx = { NALA, window: { addEventListener: () => {} }, document: { getElementById: () => null, addEventListener: () => {} }, location: { origin: '' } };
  ctx.window.addEventListener = () => {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public/nala/js/views-export.js'), 'utf8'), ctx);
  // El contexto vm tiene sus propios Array/Object: se normaliza a JSON para comparar con deepEqual.
  const plain = v => JSON.parse(JSON.stringify(v));
  return { match: (snap, text) => plain(NALA.dgiiErrors.match(snap, text)), parse: t => plain(NALA.dgiiErrors.parse(t)) };
}

const snapshot = {
  columns: [{ key: 'rnc_cedula' }, { key: 'tipo_id' }, { key: 'ncf' }, { key: 'total_monto_facturado' }],
  lines: [
    { line_no: 1, invoice_id: 'a', values: ['101000001', '1', 'B0100000001', '100.00'] },
    ...[...Array(7)].map((_, i) => ({ line_no: i + 2, invoice_id: 'x' + i, values: ['101000002', '1', 'B01000000' + (10 + i), '1.00'] })),
    { line_no: 9, invoice_id: 'nine', values: ['130879801', '1', 'E310000014579', '500.00'] },
    { line_no: 49, invoice_id: 'fortynine', values: ['101013834', '1', 'E310002166559', '900.00'] },
  ],
};

test('NALA: errores de la DGII → encuentra las facturas por línea y por RNC-NCF', () => {
  const { match } = load();
  const pegado = `9\tEmisor o receptor del e-CF no coinciden con los registros o el mismo no ha sido aceptado en DGII\t130879801-E310000014579
49\tEmisor o receptor del e-CF no coinciden con los registros o el mismo no ha sido aceptado en DGII\t101013834-E310002166559`;
  const r = match(snapshot, pegado);
  assert.deepEqual(r.matches.map(m => [m.line.line_no, m.line.invoice_id, m.how]), [[9, 'nine', 'RNC-NCF'], [49, 'fortynine', 'RNC-NCF']]);
  assert.deepEqual(r.missing, []);
  assert.ok(r.advice.some(a => /e-CF/.test(a.title)), 'muestra qué hacer con el error de e-CF');
});

test('NALA: errores de la DGII → solo números de línea o solo el NCF', () => {
  const { match } = load();
  assert.deepEqual(match(snapshot, '9, 49').matches.map(m => m.line.invoice_id), ['nine', 'fortynine']);
  assert.deepEqual(match(snapshot, 'revisar B0100000001').matches.map(m => [m.line.invoice_id, m.how]), [['a', 'NCF']]);
  const r = match(snapshot, '9, 777');
  assert.deepEqual(r.matches.map(m => m.line.line_no), [9]);
  assert.deepEqual(r.missing, ['línea 777']);
});

test('NALA: errores de la DGII → RNC distinto cae al NCF y avisa lo que no existe', () => {
  const { match } = load();
  const r = match(snapshot, '999999999-E310000014579\n111111111-B0199999999');
  assert.deepEqual(r.matches.map(m => [m.line.invoice_id, m.how]), [['nine', 'NCF']]);
  assert.deepEqual(r.missing, ['111111111-B0199999999']);
});
