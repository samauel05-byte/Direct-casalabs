// Cotización y factura comercial en PDF (pdf-lib). SIN ITBIS y SIN NCF: son documentos comerciales, no fiscales.
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const L = require('./logic');

// Helvetica estándar solo admite WinAnsi: lo demás se cambia por «?» para no tumbar la generación.
const safe = t => String(t == null ? '' : t).replace(/[^\x20-\x7E -ÿ€‘’“”•–—…]/g, '?');
const wrap = (font, text, size, maxW) => {
  const out = []; let line = '';
  for (const w of safe(text).split(/\s+/)) {
    const test = line ? line + ' ' + w : w;
    if (font.widthOfTextAtSize(test, size) <= maxW) line = test; else { if (line) out.push(line); line = w; }
  }
  if (line) out.push(line); return out.length ? out : [''];
};

// kind: 'COTIZACIÓN' | 'FACTURA'
async function buildPdf({ kind, number, date, secondLabel, secondDate, client, items, currency, total, notes, business, footer }) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 595, H = 842, M = 48, ink = rgb(.1, .14, .12), mute = rgb(.4, .45, .42), acc = rgb(.06, .54, .37);
  let page = pdf.addPage([W, H]), y = H - M;
  const text = (t, x, yy, o = {}) => page.drawText(safe(t), { x, y: yy, size: o.size || 10, font: o.bold ? bold : font, color: o.color || ink });
  const right = (t, xr, yy, o = {}) => { const f = o.bold ? bold : font, s = o.size || 10; text(t, xr - f.widthOfTextAtSize(safe(t), s), yy, o); };

  text(business, M, y, { size: 16, bold: true, color: acc }); right(kind, W - M, y, { size: 16, bold: true }); y -= 20;
  right(number, W - M, y, { size: 12, bold: true }); y -= 14;
  right('Fecha: ' + date, W - M, y, { color: mute }); y -= 13;
  if (secondLabel && secondDate) { right(secondLabel + ': ' + secondDate, W - M, y, { color: mute }); y -= 13; }
  y -= 14;
  text('Cliente', M, y, { size: 9, color: mute }); y -= 13;
  text(client.name || '', M, y, { bold: true, size: 11 }); y -= 13;
  for (const l of [client.company, client.email, client.phone]) if (l) { text(l, M, y, { color: mute }); y -= 12; }
  y -= 14;

  const cDesc = M, cQtyR = 330, cPriceR = 440, cTot = W - M;
  const header = () => { page.drawRectangle({ x: M - 4, y: y - 5, width: W - 2 * M + 8, height: 18, color: rgb(.92, .96, .94) });
    text('Descripción', cDesc, y, { bold: true, size: 9 }); right('Cant.', cQtyR, y, { bold: true, size: 9 }); right('Precio', cPriceR, y, { bold: true, size: 9 }); right('Importe', cTot, y, { bold: true, size: 9 }); y -= 22; };
  header();
  for (const it of items) {
    const lines = wrap(font, it.desc, 10, cQtyR - cDesc - 50);
    if (y - lines.length * 12 < 120) { page = pdf.addPage([W, H]); y = H - M; header(); }
    lines.forEach((ln, i) => text(ln, cDesc, y - i * 12));
    right(String(it.qty), cQtyR, y); right(L.money(it.price, currency), cPriceR, y); right(L.money(L.lineTotal(it), currency), cTot, y);
    y -= lines.length * 12 + 10;
    page.drawLine({ start: { x: M, y: y + 11 }, end: { x: W - M, y: y + 11 }, thickness: .4, color: rgb(.85, .88, .86) });
  }
  y -= 8;
  right('TOTAL ' + (currency === 'USD' ? 'US$' : 'RD$'), cPriceR - 10, y, { bold: true, size: 11 }); right(L.money(total, currency), cTot, y, { bold: true, size: 12, color: acc }); y -= 26;
  if (notes) { text('Notas', M, y, { size: 9, color: mute }); y -= 12; for (const ln of wrap(font, notes, 10, W - 2 * M)) { text(ln, M, y); y -= 12; } }
  text(footer, M, 36, { size: 8, color: mute });
  return Buffer.from(await pdf.save());
}

module.exports = { buildPdf, safe };
