// Toda pantalla (HTML) de Direct y de sus módulos debe declarar un favicon que exista, y /favicon.ico debe ser válido
// (los navegadores lo piden solos cuando una página no declara ícono: sin él la pestaña sale en blanco).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '../../public');
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? (e.name === 'vendor' ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]));
const pages = walk(PUBLIC).filter(f => f.endsWith('.html'));

test('hay páginas que revisar', () => assert.ok(pages.length >= 14));

for (const file of pages) {
  test(`favicon declarado y existente: ${path.relative(PUBLIC, file)}`, () => {
    const html = fs.readFileSync(file, 'utf8');
    const links = [...html.matchAll(/<link\s+[^>]*rel="(?:shortcut )?icon"[^>]*>/gi)].map(m => /href="([^"]+)"/.exec(m[0])?.[1]).filter(Boolean);
    assert.ok(links.length > 0, 'la página no declara ningún <link rel="icon">');
    for (const href of links) {
      const target = href.startsWith('/') ? path.join(PUBLIC, href.split('?')[0]) : path.join(path.dirname(file), href.split('?')[0]);
      assert.ok(fs.existsSync(target), `el ícono ${href} no existe`);
    }
  });
}

test('/favicon.ico es un ICO válido con imágenes PNG', () => {
  const b = fs.readFileSync(path.join(PUBLIC, 'favicon.ico'));
  assert.equal(b.readUInt16LE(0), 0); assert.equal(b.readUInt16LE(2), 1);
  const n = b.readUInt16LE(4); assert.ok(n >= 2);
  for (let i = 0; i < n; i++) {
    const size = b.readUInt32LE(6 + i * 16 + 8); const off = b.readUInt32LE(6 + i * 16 + 12);
    assert.equal(b.slice(off, off + 8).toString('hex'), '89504e470d0a1a0a', 'la imagen del ICO no es PNG');
    assert.ok(off + size <= b.length);
  }
});

test('cada módulo abre con su propio logo y Direct con el suyo', () => {
  const MOD = { 'conciliacion/index.html': 'conciliacion', 'dgii/index.html': 'dgii', 'estados/index.html': 'estados', 'ir2/index.html': 'ir2', 'mora/index.html': 'mora', 'monitor/index.html': 'monitor', 'nomina/index.html': 'nomina' };
  for (const [f, k] of Object.entries(MOD)) {
    const html = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    assert.match(html, new RegExp(`/img/favicon-${k}-32\\.png`), `${f} debe usar su ícono propio`);
    assert.doesNotMatch(html, /\/img\/favicon-32\.png|href="\/favicon\.ico"/, `${f} no debe usar el ícono de Direct`);
  }
  assert.match(fs.readFileSync(path.join(PUBLIC, 'nala/index.html'), 'utf8'), /favicon-nala-32\.png/);
  assert.match(fs.readFileSync(path.join(PUBLIC, 'cami/index.html'), 'utf8'), /assets\/favicon-32\.png/);
});

test('los íconos de pestaña no tienen fondo negro (esquinas transparentes o color de marca)', () => {
  const zlib = require('zlib');
  const png = f => { const b = fs.readFileSync(path.join(PUBLIC, 'img', f)); let o = 8, idat = [], w, h, ct; while (o < b.length) { const len = b.readUInt32BE(o), t = b.slice(o + 4, o + 8).toString(); if (t === 'IHDR') { w = b.readUInt32BE(o + 8); h = b.readUInt32BE(o + 12); ct = b[o + 17]; } if (t === 'IDAT') idat.push(b.slice(o + 8, o + 8 + len)); o += 12 + len; } return { w, h, ct, raw: zlib.inflateSync(Buffer.concat(idat)) }; };
  for (const f of ['favicon-32.png', 'favicon-48.png', 'favicon-nomina-32.png', 'favicon-mora-32.png']) {
    const { ct } = png(f); assert.equal(ct, 6, `${f} debe ser RGBA (con transparencia en las esquinas)`);
  }
  const big = png('apple-touch-icon.png'); assert.ok(big.ct === 2 || big.ct === 6);
});
