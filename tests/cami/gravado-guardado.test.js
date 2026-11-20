// CAMI · el monto gravado manual y los tipos de ITBIS puestos a mano viajan con el análisis guardado:
// capturar → empaquetar → desempaquetar → restaurar deja los mismos montos.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

test('guardar y reabrir el análisis conserva el gravado manual y el tipo de ITBIS', async t => {
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
    await page.route('**/api/**', r => r.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
    await page.goto(`http://127.0.0.1:${srv.address().port}/cami/itbis-web.html`);
    await page.waitForFunction(() => typeof process607 === 'function' && window.CAMI_ANALISIS);
    const out = await page.evaluate(async () => {
      const rows = [{ NCF: 'B0100000812', 'Fecha Comprobante': '20261001', 'Monto Facturado': 251694.00, 'ITBIS Facturado': 38394.00 }, { NCF: 'B0100000813', 'Fecha Comprobante': '20261001', 'Monto Facturado': 118179.75, 'ITBIS Facturado': 16321.50 }];
      STATE['607'] = process607(rows); render607(STATE['607'], 'x.csv');
      setGravado607(1, '90675'); setTipo607([[0, 18]]);
      const antes = { grav: STATE['607'].summary.totGrav, ex: STATE['607'].summary.totExento };
      const snap = await CAMI_ANALISIS.unpack(await CAMI_ANALISIS.pack(CAMI_ANALISIS.capture()));
      resetMod('607');
      CAMI_ANALISIS.restore(snap);
      await new Promise(r => setTimeout(r, 200));
      const d = STATE['607'];
      return { antes, despues: { grav: d.summary.totGrav, ex: d.summary.totExento }, gravOverrides: d.gravOverrides, overrides: d.overrides, input: document.querySelector('.grav-inp[data-i="1"]')?.value };
    });
    assert.deepEqual(out.gravOverrides, { 1: 90675 });
    assert.deepEqual(out.overrides, { 0: 18 });
    assert.equal(out.despues.grav, out.antes.grav);
    assert.equal(out.despues.ex, out.antes.ex);
    assert.equal(out.input, '90675.00');
  } finally { await browser.close(); srv.close(); }
});
