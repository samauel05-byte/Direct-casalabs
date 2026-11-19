// CAMI · restaurantes: el 607 trae la propina legal dentro de la forma de pago. El consumo y el ITBIS de ventas
// deben salir iguales al cuadre manual (reporte de la tarjeta − crédito fiscal), sin «diferencia» de propina.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

test('607 con propina legal + reporte CardNET: consumo, ITBIS y formas de pago cuadran', async t => {
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
      const row = (ncf, base, itbis, propina) => ({ 'RNC/Cédula o Pasaporte': '131000001', 'Número Comprobante Fiscal': ncf, 'Fecha Comprobante': 20260805, 'Monto Facturado': base, 'ITBIS Facturado': itbis, 'Monto Propina Legal': propina, 'Efectivo': '', 'Cheque/ Transferencia/ Depósito': '', 'Tarjeta Débito/Crédito': base + itbis + propina, 'Venta a Crédito': '' });
      const s7 = process607([row('B0100000001', 10000, 1800, 1000), row('B0100000002', 5000, 900, 500)]);
      STATE['607'] = s7;
      CARD_STATE.cardnet = processCardReport([{ 'Fecha': '1', 'Monto Facturado': 115000, 'ITBIS Pagado': 20700, 'ITBIS Retenido': 2300 }], 'CardNET');
      const sum = s7.summary, consol = getCardConsolidation(sum), sales = getIT1SalesBreakdown(sum);
      return { card607: consol.card607, additionalBase: consol.additionalBase, itbisVentas: getGlobalSalesItbis(sum), discrepancy: sales.discrepancy, consumo: getIT1NCFBreakdown(sum).groups.consumo.monto };
    });
    assert.equal(out.card607, 17700, 'tarjeta del 607 sin propina (monto + ITBIS)');
    assert.equal(out.additionalBase, 100000, 'consumo = base del reporte (115,000) − crédito fiscal (15,000)');
    assert.equal(out.consumo, 100000);
    assert.equal(out.itbisVentas, 20700, 'ITBIS de ventas = 18 % de la base del reporte');
    assert.equal(out.discrepancy, 0, 'sin diferencia entre ventas y formas de pago');
  } finally { await browser.close(); srv.close(); }
});
