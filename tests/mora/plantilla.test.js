const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const XLSX = require('xlsx');

const wb = XLSX.readFile(path.join(__dirname, '../../public/mora/Plantilla_liquidacion_impuestos.xlsx'), { cellFormula: true });

test('la plantilla trae las hojas esperadas', () => {
  for (const n of ['Instrucciones', 'Liquidación', 'Resumen por año', 'Parámetros', 'Calc']) assert.ok(wb.SheetNames.includes(n), 'falta la hoja ' + n);
});

test('el ejemplo (100,000, 39 meses, 10 % + 4 %, 1.10 % compuesto) trae los valores calculados', () => {
  const ws = wb.Sheets['Liquidación'];
  assert.equal(ws.F6.v, 39); assert.equal(ws.G6.v, 162); assert.equal(ws.H6.v, 162000);
  assert.ok(Math.abs(ws.I6.v - 53212.81) < 0.02, 'interés compuesto ' + ws.I6.v);
  assert.ok(Math.abs(ws.J6.v - 315212.81) < 0.02);
  assert.match(ws.I6.f, /ROUND/);
});

test('la hoja de parámetros trae los regímenes marcados para verificar y el límite de amnistía', () => {
  const ws = wb.Sheets['Parámetros'];
  assert.match(String(ws.F9.v), /VERIFICAR/); assert.match(String(ws.F10.v), /VERIFICAR/);
  assert.match(String(ws.A6.v), /amnistía/i);
});

test('el resumen por año suma lo escrito en Liquidación', () => {
  const ws = wb.Sheets['Resumen por año'];
  const fila2022 = Object.keys(ws).find(k => /^A\d+$/.test(k) && ws[k].v === 2022).replace('A', '');
  assert.equal(ws['B' + fila2022].v, 100000); assert.ok(Math.abs(ws['E' + fila2022].v - 315212.81) < 0.02);
});
