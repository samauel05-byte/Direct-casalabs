// CAMI · 607: monto GRAVADO puesto a mano por factura (facturas con parte exenta, p. ej. GARBO).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

test('el monto gravado manual fija la tasa (ITBIS ÷ gravado), el exento y los totales; vacío lo quita', async t => {
  let chromium; try { ({ chromium } = require('playwright')); } catch { return t.skip('playwright no disponible'); }
  const root = path.join(__dirname, '../../public');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
  const srv = http.createServer((q, r) => {
    const f = path.join(root, decodeURIComponent(q.url.split('?')[0]));
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.statusCode = 404; return r.end(); }
    r.setHeader('content-type', types[path.extname(f)] || 'application/octet-stream'); r.end(fs.readFileSync(f));
  });
  await new Promise(ok => srv.listen(0, ok));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('direct_tour_v1:anon:cami', '1'); } catch {} });
    await page.goto(`http://127.0.0.1:${srv.address().port}/cami/itbis-web.html`);
    await page.waitForFunction(() => typeof process607 === 'function');
    const out = await page.evaluate(() => {
      const rows = [{ NCF: 'B0100000812', 'Fecha Comprobante': '20261001', 'Monto Facturado': 251694.00, 'ITBIS Facturado': 38394.00 }, { NCF: 'B0100000813', 'Fecha Comprobante': '20261001', 'Monto Facturado': 118179.75, 'ITBIS Facturado': 16321.50 }];
      STATE['607'] = process607(rows); render607(STATE['607'], 'x.csv');
      const antes = { grav: STATE['607'].summary.totGrav, ex: STATE['607'].summary.totExento };
      setGravado607(1, '90675');
      const f = STATE['607'].facturas[1];
      const con = { grav: f.grav, exento: f.exento, manual: f.gravManual, t18: STATE['607'].summary.byTasa.t18, totExento: STATE['607'].summary.totExento };
      setGravado607(1, '');
      return { antes, con, quitado: { ov: STATE['607'].gravOverrides, grav: STATE['607'].summary.totGrav } };
    });
    assert.equal(out.con.grav, 90675);
    assert.equal(out.con.exento, 11183.25, 'exento = total − ITBIS − gravado');
    assert.equal(out.con.manual, 90675);
    assert.equal(out.con.t18.count, 2, 'ITBIS ÷ gravado = 18 %: la factura pasa a la tasa del 18 %');
    assert.equal(out.con.totExento, 11183.25);
    assert.deepEqual(out.quitado.ov, {});
    assert.equal(out.quitado.grav, out.antes.grav, 'al vaciar vuelve a lo automático');
  } finally { await browser.close(); srv.close(); }
});
