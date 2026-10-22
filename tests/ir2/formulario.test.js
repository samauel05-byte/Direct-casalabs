// Formulario IR-2: fórmulas de las casillas y llenado de la plantilla oficial.
// Valores de referencia: Excel «ESTIMACION ALMA 6 INVERSIONES SRL 2026» (casillas 12 = 440,180.2290…, 23 = 0.0690…).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const F = require('../../public/ir2/formulario.js');

const ALMA = { AB18: 32067462.250000004, AB19: 32067462.250000004, AB20: 3643243.9100000048, AB27: 2012946.7652533334, T32: 440180.16000000009 };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≠ ${b}`);

test('compute reproduce las casillas del Excel de referencia', () => {
  const r = F.compute(ALMA);
  near(r.AB26, 3643243.910000005); near(r.AB28, 1630297.1447466714);
  near(r.AB31, 440180.2290816013); near(r.AB42, 0.0690816012211144);
  assert.strictEqual(r.AB43, 0); near(r.AB50, 0.0690816012211144); assert.strictEqual(r.AB52, 0);
});

test('una casilla calculada escrita a mano reemplaza la fórmula y arrastra las siguientes', () => {
  const r = F.compute({ ...ALMA, AB31: 500000 }, new Set(['AB31']));
  near(r.AB31, 500000); near(r.AB42, 500000 - 440180.16);
});

test('saldo a favor y recargos', () => {
  const r = F.compute({ AB20: 100000, T32: 50000, P44: 10 });
  near(r.AB31, 27000); near(r.AB43, 23000); assert.strictEqual(r.AB42, 0);
  const s = F.compute({ AB20: 100000, T32: 0, P44: 10, W48: 5 });
  near(s.AB42, 27000); near(s.T44, 2700); near(s.AB48, 1350); near(s.AB50, 27000 + 2700 + 1350);
});

test('buildXlsx llena la plantilla sin enlaces externos y conserva las fórmulas', async () => {
  const tpl = fs.readFileSync(path.join(__dirname, '../../public/ir2/IR-2.template.xlsx'));
  const out = await F.buildXlsx(JSZip, tpl, { general: { anio: 2025, rnc: '132-55821-9', razon: 'ALMA 6 & CIA <SRL>' }, inputs: ALMA, manual: new Set() });
  const zip = await JSZip.loadAsync(out);
  assert.ok(!Object.keys(zip.files).some(n => /externalLink|calcChain/.test(n)));
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.ok(!xml.includes('[1]'));
  assert.match(xml, /<c r="AB31"[^>]*><f>IF\(AB30&gt;0/);           // fórmula conservada
  assert.match(xml, /<c r="AB18"[^>]*><v>32067462\.25/);           // valor escrito
  assert.match(xml, /ALMA 6 &amp; CIA &lt;SRL&gt;/);               // texto escapado
  const man = await F.buildXlsx(JSZip, tpl, { general: {}, inputs: { ...ALMA, AB31: 500000 }, manual: new Set(['AB31']) });
  const mxml = await (await JSZip.loadAsync(man)).file('xl/worksheets/sheet1.xml').async('string');
  assert.match(mxml, /<c r="AB31"[^>]*><v>500000<\/v><\/c>/);       // a mano: sin fórmula
});
