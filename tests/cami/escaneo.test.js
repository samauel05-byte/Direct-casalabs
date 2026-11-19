// CAMI · reporte B02 escaneado: la validación de lo que transcribe la IA (sin llamar a la IA).
const test = require('node:test');
const assert = require('node:assert');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'x';
const { normalize, num, ymd, currency } = require('../../lib/cami-escaneo');

const row = (o = {}) => ({ factura: '3676', ncf: 'B0200003531', fecha: '02/10/2026', total_facturado: '122.88', mas_itbis: '22.12', total_pagado: '145.00', condiciones: 'AL CONTADO', moneda_seccion: 'DOLLAR', nota: null, ...o });

test('una fila del reporte (USD, ITBIS incluido) cuadra: base + ITBIS = total pagado', () => {
  const [r] = normalize([row()]);
  assert.deepEqual({ ncf: r.ncf, fecha: r.fecha, base: r.base, itbis: r.itbis, total: r.total, moneda: r.moneda }, { ncf: 'B0200003531', fecha: '20261002', base: 122.88, itbis: 22.12, total: 145, moneda: 'USD' });
  assert.deepEqual(r.flags, []);
});

test('marca NCF repetido, base + ITBIS que no cuadra, NCF que no es B02 y devoluciones', () => {
  const rows = normalize([row(), row({ factura: '3677' }), row({ ncf: 'B0100000001', total_pagado: '150.00' }), row({ ncf: 'B0200003534', nota: 'DEV. - 125' })]);
  assert.ok(rows[0].flags.includes('NCF repetido') && rows[1].flags.includes('NCF repetido'));
  assert.ok(rows[2].flags.includes('NCF no es B02/E32') && rows[2].flags.includes('Base + ITBIS ≠ total pagado'));
  assert.ok(rows[3].flags.includes('Devolución / anulada'));
});

test('lectura de números, fechas y monedas', () => {
  assert.equal(num('1,234.50'), 1234.5); assert.equal(num('RD$ 20.00'), 20); assert.equal(num(null), null);
  assert.equal(ymd('2/10/2026'), '20261002'); assert.equal(ymd('2026-10-31'), '20261031'); assert.equal(ymd('xx'), null);
  assert.equal(currency('EURO'), 'EUR'); assert.equal(currency('€'), 'EUR'); assert.equal(currency('DOLLAR'), 'USD'); assert.equal(currency('Pesos'), 'DOP'); assert.equal(currency(''), null);
});

test('faltan montos o NCF: se marcan, no se inventan', () => {
  const [r] = normalize([row({ ncf: null, total_facturado: null })]);
  assert.ok(r.flags.includes('Sin NCF') && r.flags.includes('Faltan montos'));
});
