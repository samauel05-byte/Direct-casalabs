// Cotización y factura comercial en PDF (pdf-lib) con el formato de CaSa Labs: logo, «FACTURADO A», detalle en tabla,
// notas, pago recibido, términos y aceptación con la firma. SIN ITBIS y SIN NCF: son documentos comerciales, no fiscales.
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const L = require('./logic');
const assets = require('./assets');

const NAVY = rgb(0.17, 0.23, 0.51), GREEN = rgb(0.12, 0.34, 0.2), GOLD = rgb(0.78, 0.6, 0.12), INK = rgb(0.1, 0.1, 0.12),
  MUTE = rgb(0.4, 0.4, 0.43), LIGHT = rgb(0.9, 0.92, 0.97), GRAY = rgb(0.95, 0.95, 0.96), LINE = rgb(0.72, 0.74, 0.8);

// Las fuentes estándar solo admiten WinAnsi: lo demás se cambia por «?» para no tumbar la generación.
const safe = t => String(t == null ? '' : t).replace(/[^\x20-\x7E -ÿ€‘’“”•–—…]/g, '?');

const fmtDate = v => { if (!v) return ''; const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v)); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v); };
const cur = c => (c === 'USD' ? 'US$' : 'RD$');
const money = (n, c) => `${cur(c)}${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const tagline = () => process.env.COBROS_TAGLINE || 'Desarrollo Web & Tecnología';
const place = () => process.env.COBROS_PLACE || 'Punta Cana, República Dominicana';
const BUSINESS = () => process.env.BUSINESS_NAME || 'CaSa Labs';

function defaultTerms(kind, validUntil) {
  if (process.env.COBROS_TERMS) return process.env.COBROS_TERMS.split('\n').map(s => s.trim()).filter(Boolean);
  const base = ['Cualquier alcance adicional no contemplado en este documento será facturado por separado.',
    `${BUSINESS()} se reserva el derecho de actualizar tarifas para ciclos futuros, notificando al cliente con antelación.`];
  return kind === 'COTIZACIÓN'
    ? [`Esta cotización ${validUntil ? `es válida hasta el ${fmtDate(validUntil)}` : 'tiene una vigencia limitada'}; pasada esa fecha los precios pueden variar.`,
      'La contratación y el inicio del servicio se realizan al aceptar esta cotización y confirmar el pago acordado.', ...base]
    : ['La contratación y activación del servicio se realizan al confirmar el pago de esta factura.', ...base];
}

/**
 * opts: { kind:'FACTURA'|'COTIZACIÓN', number, date (YYYY-MM-DD), extra:'Vence: 30/11/2026'|'Válida hasta: …', client, items, currency, total,
 *         notes:[…], payment: { paid, method, txId, amountLabel, paidDate, ref, dueDate, link }, validUntil, signName }
 */
async function buildPdf(o) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${o.kind === 'FACTURA' ? 'Factura' : 'Cotización'} ${o.number}`); pdf.setAuthor(BUSINESS()); pdf.setProducer(BUSINESS());
  const f = await pdf.embedFont(StandardFonts.TimesRoman), fb = await pdf.embedFont(StandardFonts.TimesRomanBold), fi = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const logo = await pdf.embedJpg(Buffer.from(assets.logoJpg, 'base64')), firma = await pdf.embedPng(Buffer.from(assets.firmaPng, 'base64'));
  const W = 612, H = 792, M = 38, CW = W - 2 * M;
  let page, y;
  const font = b => (b === 'i' ? fi : b ? fb : f);
  const tw = (t, s, b) => font(b).widthOfTextAtSize(safe(t), s);
  const txt = (t, x, yy, s = 9, b, color = INK) => page.drawText(safe(t), { x, y: yy, size: s, font: font(b), color });
  const rtxt = (t, xr, yy, s = 9, b, color = INK) => txt(t, xr - tw(t, s, b), yy, s, b, color);
  const wrap = (t, s, maxW, b) => {
    const out = [];
    for (const para of String(t == null ? '' : t).split('\n')) {
      let line = '';
      for (const w of safe(para).split(/\s+/).filter(Boolean)) { const test = line ? line + ' ' + w : w; if (tw(test, s, b) <= maxW) line = test; else { if (line) out.push(line); line = w; } }
      out.push(line);
    }
    return out.length ? out : [''];
  };
  const footer = () => {
    page.drawLine({ start: { x: M, y: 52 }, end: { x: W - M, y: 52 }, thickness: 1, color: GOLD });
    const t = `${BUSINESS()}  ·  ${tagline()}  ·  ${place()}`; txt(t, (W - tw(t, 8)) / 2, 40, 8, false, MUTE);
  };
  const newPage = () => { page = pdf.addPage([W, H]); y = H - 36; };
  const need = h => { if (y - h < 70) { footer(); newPage(); } };
  const heading = t => { need(40); y -= 22; txt(t, M, y, 11, true, GREEN); y -= 4; };

  newPage();
  // Encabezado: logo a la izquierda, datos del documento a la derecha
  const lh = 50, lw = lh * (logo.width / logo.height);
  page.drawImage(logo, { x: M + 4, y: y - lh, width: lw, height: lh });
  rtxt(o.kind, W - M, y - 14, 16, true, NAVY);
  rtxt(`N.º ${o.number}`, W - M, y - 28, 9, false, MUTE); rtxt(`Fecha: ${fmtDate(o.date)}`, W - M, y - 40, 9, false, MUTE);
  if (o.extra) rtxt(o.extra, W - M, y - 52, 9, false, MUTE);
  y -= lh + 12; page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1.2, color: GOLD });

  // Facturado a
  y -= 18; txt(o.kind === 'FACTURA' ? 'FACTURADO A' : 'COTIZADO A', M, y, 11, true, GREEN);
  y -= 15; txt(o.client.name || '', M, y, 14, true);
  for (const l of [o.client.company, o.client.email, o.client.phone].filter(Boolean)) { y -= 11; txt(l, M, y, 9, false, MUTE); }
  y -= 12; txt(`Emitido por: ${BUSINESS()} — ${tagline()}`, M, y, 9, false, MUTE);

  // Detalle
  heading(o.kind === 'FACTURA' ? 'DETALLE DE LA FACTURA' : 'DETALLE DE LA COTIZACIÓN');
  const c1 = 170, c3 = 108, c2 = CW - c1 - c3, x1 = M, x2 = M + c1, x3 = M + c1 + c2;
  const head = () => { page.drawRectangle({ x: M, y: y - 17, width: CW, height: 19, color: NAVY });
    txt('Concepto', x1 + 7, y - 11, 9, true, rgb(1, 1, 1)); txt('Descripción', x2 + 7, y - 11, 9, true, rgb(1, 1, 1)); rtxt(`Monto (${cur(o.currency)})`, W - M - 7, y - 11, 9, true, rgb(1, 1, 1)); y -= 19; };
  need(60); head();
  for (const it of o.items) {
    const detail = it.detail ? (it.qty !== 1 ? `${it.qty} × ${money(it.price, o.currency)}. ${it.detail}` : it.detail) : `${it.qty} × ${money(it.price, o.currency)}`;
    const a = wrap(it.desc, 9, c1 - 14, true), b = wrap(detail, 8, c2 - 14);
    const h = Math.max(a.length * 11, b.length * 10) + 18;
    if (y - h < 90) { footer(); newPage(); head(); }
    for (const [x, w] of [[x1, c1], [x2, c2], [x3, c3]]) page.drawRectangle({ x, y: y - h, width: w, height: h, borderColor: LINE, borderWidth: 0.7 });
    a.forEach((ln, i) => txt(ln, x1 + 7, y - 15 - i * 11, 9, true));
    b.forEach((ln, i) => txt(ln, x2 + 7, y - 14 - i * 10, 8, false, MUTE));
    rtxt(money(L.lineTotal(it), o.currency), W - M - 7, y - h / 2 - 3, 10);
    y -= h;
  }
  need(30);
  page.drawRectangle({ x: M, y: y - 22, width: c1 + c2, height: 22, color: LIGHT, borderColor: LINE, borderWidth: 0.7 });
  page.drawRectangle({ x: x3, y: y - 22, width: c3, height: 22, color: LIGHT, borderColor: LINE, borderWidth: 0.7 });
  rtxt('TOTAL', x3 - 8, y - 15, 10, true, NAVY); rtxt(money(o.total, o.currency), W - M - 7, y - 15, 11, true, NAVY); y -= 22;

  // Notas
  const notes = [`Los montos están expresados en ${o.currency === 'USD' ? 'dólares estadounidenses (US$)' : 'pesos dominicanos (RD$)'}.`, ...(o.notes || []),
    'Documento comercial sin valor fiscal: no incluye NCF.'];
  heading('NOTAS');
  for (const n of notes) { const ls = wrap(n, 9, CW - 24); need(ls.length * 11 + 4); y -= 12;
    page.drawCircle({ x: M + 12, y: y + 3, size: 1.6, color: GOLD }); ls.forEach((ln, i) => { txt(ln, M + 22, y - i * 11, 9); }); y -= (ls.length - 1) * 11; }

  // Pago
  const p = o.payment;
  if (p) {
    heading(p.paid ? 'PAGO RECIBIDO' : 'PAGO');
    const rows = p.paid ? [['Estado:', 'Pagada'], ['Método:', p.method || 'Pago registrado'], ['ID de transacción:', p.txId || '—']]
      : [['Estado:', 'Pendiente de pago'], ['Vence:', fmtDate(p.dueDate)], ...(p.link ? [['Enlace de pago:', p.link]] : [])];
    const lines = rows.map(([k, v]) => ({ k, ls: wrap(v, 9, CW - 130) }));
    const bh = lines.reduce((a, r) => a + r.ls.length * 12, 0) + 12; need(bh + 70);
    page.drawRectangle({ x: M, y: y - bh - 4, width: CW, height: bh, color: GRAY, borderColor: LINE, borderWidth: 0.6 }); y -= 6;
    for (const r of lines) { y -= 12; txt(r.k, M + 9, y, 9, true); r.ls.forEach((ln, i) => txt(ln, M + 9 + tw(r.k, 9, true) + 5, y - i * 12, 9)); y -= (r.ls.length - 1) * 12; }
    y -= 12;
    if (p.paid) {
      y -= 8; const bh2 = 52, half = CW / 2;
      page.drawRectangle({ x: M, y: y - bh2, width: half, height: bh2, color: NAVY });
      page.drawRectangle({ x: M + half, y: y - bh2, width: half, height: bh2, color: GREEN });
      txt(`MONTO COBRADO (${cur(p.currency || o.currency)})`, M + 9, y - 15, 9, true, rgb(1, 1, 1)); txt(p.ref || '', M + 9, y - 28, 7.5, 'i', rgb(0.85, 0.88, 1));
      txt('Monto:', M + 9, y - 44, 9, true, rgb(1, 1, 1)); rtxt(p.amountLabel, M + half - 9, y - 44, 13, true, rgb(0.97, 0.78, 0.25));
      txt('FECHA DE PAGO', M + half + 9, y - 15, 9, true, rgb(1, 1, 1)); txt('Fecha en que se confirmó el cobro', M + half + 9, y - 28, 7.5, 'i', rgb(0.85, 1, 0.9));
      txt('Fecha:', M + half + 9, y - 44, 9, true, rgb(1, 1, 1)); rtxt(fmtDate(p.paidDate), W - M - 9, y - 44, 13, true, rgb(0.97, 0.78, 0.25));
      y -= bh2 + 12; txt('Pago recibido, gracias. Conserve esta factura como comprobante de su pago. ¡Gracias por su confianza!', M, y, 8.5, 'i', MUTE);
    }
  }

  // Términos
  heading('TÉRMINOS Y CONDICIONES GENERALES');
  for (const n of defaultTerms(o.kind, o.validUntil)) { const ls = wrap(n, 9, CW - 24); need(ls.length * 11 + 4); y -= 12;
    page.drawCircle({ x: M + 12, y: y + 3, size: 1.6, color: GOLD }); ls.forEach((ln, i) => txt(ln, M + 22, y - i * 11, 9)); y -= (ls.length - 1) * 11; }

  // Aceptación con firma
  need(130); heading('ACEPTACIÓN');
  const ack = `Al firmar este documento, ${o.client.name} confirma la recepción y conformidad con los conceptos y montos ${o.kind === 'FACTURA' ? 'facturados' : 'cotizados'}.`;
  for (const ln of wrap(ack, 9, CW)) { y -= 12; txt(ln, M, y, 9, false, MUTE); }
  y -= 54; const fw = 105, fh = fw * (firma.height / firma.width);
  page.drawImage(firma, { x: M + 4, y: y - 2, width: fw, height: fh });
  const lx2 = M + CW * 0.57;
  page.drawLine({ start: { x: M, y }, end: { x: M + CW * 0.48, y }, thickness: 0.8, color: INK });
  page.drawLine({ start: { x: lx2, y }, end: { x: W - M, y }, thickness: 0.8, color: INK });
  txt(`Firma — ${BUSINESS()}`, M, y - 10, 7.5, false, MUTE); txt(`Firma — ${o.client.name}`, lx2, y - 10, 7.5, false, MUTE);

  footer();
  return Buffer.from(await pdf.save());
}

module.exports = { buildPdf, safe, fmtDate };
