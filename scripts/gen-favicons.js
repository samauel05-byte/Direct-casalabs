// Genera los íconos de pestaña de Direct y de cada módulo (sin fondo negro).
//  - Direct: la nube con llave en blanco sobre una ficha azul redondeada (parte del logo original, public/img/favicon.png).
//  - Módulos: ficha con el degradado de su tarjeta en Accesos y un símbolo blanco propio.
// Uso: node scripts/gen-favicons.js   (requiere playwright/chromium; no usa red)
const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright');
const IMG = path.join(__dirname, '../public/img');
const G = '#fff';
const st = 'fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"';
const MODS = {
  nomina: { a: '#b45309', b: '#f59e0b', glyph: `<rect x="9" y="19" width="46" height="26" rx="4" ${st}/><circle cx="32" cy="32" r="6" fill="${G}"/><circle cx="16" cy="32" r="1.8" fill="${G}"/><circle cx="48" cy="32" r="1.8" fill="${G}"/>` },
  ir2: { a: '#7c3aed', b: '#a78bfa', glyph: `<circle cx="21" cy="21" r="6.5" ${st}/><circle cx="43" cy="43" r="6.5" ${st}/><path d="M45 17 19 47" ${st}/>` },
  dgii: { a: '#004e89', b: '#0060e0', glyph: `<rect x="15" y="9" width="34" height="46" rx="5" ${st}/><rect x="21" y="15" width="22" height="10" rx="1.5" fill="${G}"/>` + [[24, 35], [32, 35], [40, 35], [24, 44], [32, 44], [40, 44]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.8" fill="${G}"/>`).join('') },
  estados: { a: '#5b21b6', b: '#a855f7', glyph: `<rect x="13" y="34" width="9" height="16" rx="1.5" fill="${G}"/><rect x="27.5" y="24" width="9" height="26" rx="1.5" fill="${G}"/><rect x="42" y="13" width="9" height="37" rx="1.5" fill="${G}"/><path d="M9 55H55" ${st}/>` },
  conciliacion: { a: '#0e7490', b: '#22d3ee', glyph: `<path d="M11 24H50M41 14l10 10-10 10" ${st}/><path d="M53 42H14M23 32 13 42l10 10" ${st}/>` },
  monitor: { a: '#be123c', b: '#f43f5e', glyph: `<path d="M7 34h12l7-17 10 31 7-14h14" ${st}/>` },
  mora: { a: '#92400e', b: '#f59e0b', glyph: `<circle cx="32" cy="32" r="19" ${st}/><path d="M32 19v14l9 6" ${st}/>` },
};
const svgTile = (m, rx = 14) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${m.a}"/><stop offset="1" stop-color="${m.b}"/></linearGradient></defs><rect width="64" height="64" rx="${rx}" fill="url(#g)"/>${m.glyph}</svg>`;

(async () => {
  const b = await chromium.launch(); const page = await b.newPage();
  const raster = async (svg, size) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<body style="margin:0;background:transparent"><img id="i" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" style="width:${size}px;height:${size}px;display:block"></body>`);
    await page.waitForFunction(() => document.getElementById('i').complete);
    return page.screenshot({ type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  };
  // ── Módulos
  for (const [k, m] of Object.entries(MODS)) {
    fs.writeFileSync(path.join(IMG, `favicon-${k}.svg`), svgTile(m));
    fs.writeFileSync(path.join(IMG, `favicon-${k}-32.png`), await raster(svgTile(m), 32));
    fs.writeFileSync(path.join(IMG, `favicon-${k}-48.png`), await raster(svgTile(m), 48));
    fs.writeFileSync(path.join(IMG, `apple-touch-${k}.png`), await raster(svgTile(m, 0), 180));
  }
  // ── Direct: silueta blanca de la nube con llave (a partir del logo) sobre ficha azul
  const logo = fs.readFileSync(path.join(IMG, 'favicon.png')).toString('base64');
  await page.setViewportSize({ width: 600, height: 600 });
  await page.setContent('<canvas id="c" width="1254" height="1254"></canvas>');
  const tileData = await page.evaluate(async (logo) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + logo; await img.decode();
    const c = document.getElementById('c'); const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, 1254, 1254); const p = d.data; let minx = 1254, maxx = 0, miny = 1254, maxy = 0;
    for (let i = 0; i < p.length; i += 4) {
      const lum = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
      const a = Math.max(0, Math.min(1, (lum - 28) / 60));
      p[i] = p[i + 1] = p[i + 2] = 255; p[i + 3] = Math.round(a * 255);
      if (a > 0.5) { const px = (i / 4) % 1254, py = Math.floor(i / 4 / 1254); if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py; }
    }
    x.putImageData(d, 0, 0);
    const sil = document.createElement('canvas'); sil.width = maxx - minx + 1; sil.height = maxy - miny + 1;
    sil.getContext('2d').drawImage(c, minx, miny, sil.width, sil.height, 0, 0, sil.width, sil.height);
    const make = (size, radius) => {
      const o = document.createElement('canvas'); o.width = o.height = size; const g = o.getContext('2d');
      const grad = g.createLinearGradient(0, 0, size, size); grad.addColorStop(0, '#00A6FF'); grad.addColorStop(1, '#0B3BE0');
      g.fillStyle = grad; g.beginPath();
      if (radius) { g.roundRect(0, 0, size, size, size * radius); } else g.rect(0, 0, size, size);
      g.fill();
      const w = size * 0.74, h = w * sil.height / sil.width; g.imageSmoothingQuality = 'high';
      g.drawImage(sil, (size - w) / 2, (size - h) / 2, w, h);
      return o.toDataURL('image/png');
    };
    return { s32: make(32, 0.22), s48: make(48, 0.22), s128: make(128, 0.22), a180: make(180, 0), i192: make(192, 0), i512: make(512, 0), s256: make(256, 0.22) };
  }, logo);
  const buf = u => Buffer.from(u.split(',')[1], 'base64');
  fs.writeFileSync(path.join(IMG, 'favicon-32.png'), buf(tileData.s32));
  fs.writeFileSync(path.join(IMG, 'favicon-48.png'), buf(tileData.s48));
  fs.writeFileSync(path.join(IMG, 'apple-touch-icon.png'), buf(tileData.a180));
  fs.writeFileSync(path.join(IMG, 'icon-192.png'), buf(tileData.i192));
  fs.writeFileSync(path.join(IMG, 'icon-512.png'), buf(tileData.i512));
  fs.writeFileSync(path.join(IMG, 'favicon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128"><image width="128" height="128" href="${tileData.s128}"/></svg>\n`);
  // favicon.ico (32 y 48 px, PNG dentro del ICO)
  const p32 = buf(tileData.s32), p48 = buf(tileData.s48);
  const hdr = Buffer.alloc(6); hdr.writeUInt16LE(0, 0); hdr.writeUInt16LE(1, 2); hdr.writeUInt16LE(2, 4);
  const ent = (w, len, off) => { const e = Buffer.alloc(16); e[0] = w; e[1] = w; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(len, 8); e.writeUInt32LE(off, 12); return e; };
  fs.writeFileSync(path.join(__dirname, '../public/favicon.ico'), Buffer.concat([hdr, ent(32, p32.length, 38), ent(48, p48.length, 38 + p32.length), p32, p48]));
  await b.close(); console.log('ok');
})();
