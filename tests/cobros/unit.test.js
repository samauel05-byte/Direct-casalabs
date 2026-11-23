const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const L = require('../../lib/cobros/logic');
const ROOT = path.join(__dirname, '../..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('recordatorios: 3 días antes, 1 día antes, el día y cada 3 días en mora; máximo uno por día', () => {
  const today = '2026-11-23';
  const due = (d) => ({ due_date: d, last_reminder_at: null });
  assert.equal(L.shouldRemindToday(due('2026-11-26'), today), true);   // -3
  assert.equal(L.shouldRemindToday(due('2026-11-24'), today), true);   // -1
  assert.equal(L.shouldRemindToday(due('2026-11-23'), today), true);   // hoy
  assert.equal(L.shouldRemindToday(due('2026-11-25'), today), false);  // 2 días antes: no toca
  assert.equal(L.shouldRemindToday(due('2026-11-20'), today), true);   // 3 de mora
  assert.equal(L.shouldRemindToday(due('2026-11-17'), today), true);   // 6 de mora
  assert.equal(L.shouldRemindToday(due('2026-11-21'), today), false);  // 2 de mora
  assert.equal(L.shouldRemindToday({ due_date: '2026-11-23', last_reminder_at: '2026-11-23T15:00:00Z' }, today), false); // ya avisado hoy
});

test('totales: RD$ y US$ separados, vencido incluye pendientes con fecha pasada, cobrado solo del mes', () => {
  const today = '2026-11-23';
  const t = L.totals([
    { amount: 1000, currency: 'DOP', status: 'pending', due_date: '2026-12-01' },
    { amount: 500, currency: 'DOP', status: 'pending', due_date: '2026-11-10' },
    { amount: 250, currency: 'DOP', status: 'overdue', due_date: '2026-11-01' },
    { amount: 100, currency: 'USD', status: 'pending', due_date: '2026-11-30' },
    { amount: 80, currency: 'USD', status: 'paid', due_date: '2026-11-05', paid_at: '2026-11-10T16:00:00Z' },
    { amount: 999, currency: 'USD', status: 'paid', due_date: '2026-10-05', paid_at: '2026-10-10T16:00:00Z' },
  ], today);
  assert.deepEqual(t.DOP, { receivable: 1750, overdue: 750, paid: 0 });
  assert.deepEqual(t.USD, { receivable: 100, overdue: 0, paid: 80 });
});

test('variables de la promoción y mensaje de recordatorio', () => {
  process.env.BUSINESS_NAME = 'Casa Labs';
  assert.equal(L.fillVars('Hola {{nombre}} de {{ empresa }} — {{negocio}}', { name: 'Ana', company: 'Garbo' }), 'Hola Ana de Garbo — Casa Labs');
  const m = L.reminderMessage({ concept: 'Hosting', amount: 1500, currency: 'DOP', due_date: '2026-11-20', payment_link: 'https://pago.example/x' }, { name: 'Ana' }, -3);
  assert.match(m.subject, /vencido/i);
  assert.match(m.body, /3 día\(s\) de atraso/);
  assert.match(m.body, /https:\/\/pago\.example\/x/);
  assert.match(m.body, /RD\$/);
  assert.match(L.money(10, 'USD'), /US\$/);
  assert.deepEqual(L.parseTags(' Web, web ,Mantenimiento,, '), ['web', 'mantenimiento']);
});

test('envío sin credenciales falla de forma controlada y respeta el consentimiento', async () => {
  const logged = [];
  const stub = { from: () => ({ insert: async row => { logged.push(row); return { error: null }; } }) };
  require.cache[require.resolve('../../lib/supabase')] = { id: 'x', filename: 'x', loaded: true, exports: stub };
  delete require.cache[require.resolve('../../lib/cobros/messaging')];
  for (const k of ['MAIL_SMTP_HOST', 'MAIL_SMTP_USER', 'MAIL_SMTP_PASS', 'LICENSE_SMTP_HOST', 'LICENSE_SMTP_USER', 'LICENSE_SMTP_PASS', 'MONITOR_SMTP_HOST', 'MONITOR_SMTP_USER', 'MONITOR_SMTP_PASS', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM']) delete process.env[k];
  const { dispatch } = require('../../lib/cobros/messaging');
  const client = { id: 'c1', email: 'a@b.co', phone: '+18095551234', opt_in_email: true, opt_in_whatsapp: false };
  const r = await dispatch({ tenantId: 't', channel: 'email', kind: 'promo', client, subject: 's', body: 'b' });
  assert.equal(r.ok, false); assert.match(r.error, /buzón corporativo/);
  assert.equal(logged.length, 1); assert.equal(logged[0].status, 'failed'); assert.ok(logged[0].error);
  const none = await dispatch({ tenantId: 't', channel: 'whatsapp', kind: 'promo', client, subject: 's', body: 'b' });
  assert.equal(none, null);                 // no aceptó WhatsApp: no se envía
  assert.equal(logged.length, 1);           // y no se registra
});

test('la API de Cobros exige access_cobros (sin atajo para admin) y el cron exige secreto', async () => {
  let session = null;
  require.cache[require.resolve('../../lib/auth')] = { id: 'a', filename: 'a', loaded: true, exports: { authenticate: async () => session } };
  delete require.cache[require.resolve('../../api/cobros')];
  const handler = require('../../api/cobros');
  const call = async (route, method = 'GET', headers = {}) => {
    const out = {}; const res = { setHeader() {}, status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } };
    await handler({ method, query: { route }, headers, body: {} }, res); return out;
  };
  assert.equal((await call('dashboard')).code, 401);
  session = { userId: 'u', role: 'admin', access_cobros: false, tenantId: 't' };
  assert.equal((await call('dashboard')).code, 403);
  assert.equal((await call('nada')).code, 404);
  process.env.CRON_SECRET = 'x'.repeat(24);
  assert.equal((await call('cron')).code, 401);
  assert.equal((await call('cron', 'GET', { authorization: 'Bearer wrong' })).code, 401);
});

test('integración con Direct: tarjeta en «Otros accesos», permiso por usuario, ruta y cron', () => {
  const html = read('public/index.html');
  assert.match(html, /keys:\['digisign','gdmail','nexo','cobros'\]/);
  assert.match(html, /if \(currentUser\?\.access_cobros\) allowed\.push\('cobros'\)/);
  assert.match(html, /id="u-access-cobros"/);
  assert.match(html, /cobros:openCobros/);
  assert.match(html, /cobros-ready/);
  assert.match(html, /key==='cobros'\?'Clientes y avisos':'606\/607 · IT-1'/); // la tarjeta no hereda la etiqueta de CAMI
  assert.match(read('api/users/index.js'), /access_cobros: access_cobros === true/);
  assert.match(read('api/users/[id].js'), /update\.access_cobros/);
  assert.match(read('lib/auth.js'), /access_cobros: profile\.access_cobros === true/);
  assert.match(read('api/auth/login.js'), /access_cobros/);
  const v = JSON.parse(read('vercel.json'));
  assert.ok(v.rewrites.some(r => r.source === '/api/cobros/:path*'));
  assert.ok(v.crons.some(c => c.path === '/api/cobros/cron'));
  const sql = read('supabase/migrations/202611230001_cobros.sql');
  for (const t of ['cobros_clients', 'cobros_invoices', 'cobros_campaigns', 'cobros_log']) assert.match(sql, new RegExp(`alter table public\\.${t} enable row level security`));
  assert.match(sql, /'camila@direct\.local'/);
  assert.match(sql, /check \(currency in \('DOP','USD'\)\)/);
});

test('PayPal: RD$ se factura en US$ con la tasa; sin tasa o sin correo se rechaza; devuelve el enlace del pagador', async () => {
  const calls = [];
  const stub = {
    hasCredentials: () => true,
    api: async (p, init = {}) => {
      calls.push({ p, body: init.body ? JSON.parse(init.body) : null });
      if (p.endsWith('generate-next-invoice-number')) return { invoice_number: '0001' };
      if (p === '/v2/invoicing/invoices') return { href: 'https://api-m.paypal.com/v2/invoicing/invoices/INV2-AAA' };
      if (p.endsWith('/send')) return { href: 'https://www.paypal.com/invoice/p/#INV2-AAA' };
      return { status: 'PAID' };
    },
  };
  require.cache[require.resolve('../../lib/paypal')] = { id: 'p', filename: 'p', loaded: true, exports: stub };
  delete require.cache[require.resolve('../../lib/cobros/paypal')];
  const pp = require('../../lib/cobros/paypal');
  const inv = { concept: 'Hosting', amount: 6050, currency: 'DOP', due_date: '2026-12-01' };
  const client = { name: 'Ana', email: 'ana@x.co' };
  assert.equal(pp.toUsd(6050, 60.5), 100);
  await assert.rejects(() => pp.createInvoiceLink(inv, client, ''), /tasa/);
  await assert.rejects(() => pp.createInvoiceLink(inv, { name: 'Ana' }, 60.5), /correo/);
  const r = await pp.createInvoiceLink(inv, client, 60.5);
  assert.equal(r.id, 'INV2-AAA'); assert.equal(r.url, 'https://www.paypal.com/invoice/p/#INV2-AAA'); assert.equal(r.usd, 100); assert.equal(r.rate, 60.5);
  const created = calls.find(c => c.p === '/v2/invoicing/invoices').body;
  assert.equal(created.detail.currency_code, 'USD');
  assert.equal(created.items[0].unit_amount.value, '100.00');
  assert.equal(created.primary_recipients[0].billing_info.email_address, 'ana@x.co');
  const send = calls.find(c => c.p.endsWith('/send')).body;
  assert.equal(send.send_to_recipient, false);           // PayPal no escribe al cliente: lo hace Cobros
  const usd = await pp.createInvoiceLink({ ...inv, currency: 'USD', amount: 50 }, client);
  assert.equal(usd.usd, 50); assert.equal(usd.rate, null);
  assert.equal(await pp.invoiceState('INV2-AAA'), 'paid');
  stub.hasCredentials = () => false;
  await assert.rejects(() => pp.createInvoiceLink(inv, client, 60.5), /PayPal no está configurado/);
});

test('comprobante de pago: contenido, número estable y aviso de que no es fiscal; cobrar lo envía una sola vez', async () => {
  process.env.BUSINESS_NAME = 'Casa Labs';
  const inv = { id: '12345678-aaaa-bbbb-cccc-1234567890ab', concept: 'Hosting', amount: 6050, currency: 'DOP', paid_at: '2026-11-23T16:00:00Z', paypal_usd_amount: 100, paypal_rate: 60.5 };
  const m = L.receiptMessage(inv, { name: 'Ana' });
  assert.equal(L.receiptNumber(inv), 'REC-12345678');
  assert.match(m.subject, /Comprobante de pago REC-12345678/);
  assert.match(m.body, /RD\$/); assert.match(m.body, /US\$/); assert.match(m.body, /no sustituye un comprobante fiscal/);

  // Flujo completo con base y mensajería simuladas
  const rows = { inv: { id: 'i1', tenant_id: 't', client_id: 'c1', status: 'pending', concept: 'Hosting', amount: 100, currency: 'USD', due_date: '2026-12-01', receipt_sent_at: null }, updates: [], sends: [] };
  const client = { id: 'c1', name: 'Ana', email: 'a@x.co', phone: null, opt_in_email: true, opt_in_whatsapp: false };
  const chain = (table) => { const q = { _t: table, _u: null };
    q.select = () => q; q.eq = () => q; q.maybeSingle = async () => ({ data: table === 'cobros_invoices' ? { ...rows.inv } : client, error: null });
    q.update = u => { q._u = u; return q; }; q.then = (res) => { if (q._u) { rows.updates.push(q._u); Object.assign(rows.inv, q._u); } res({ data: null, error: null }); };
    return q; };
  require.cache[require.resolve('../../lib/supabase')] = { id: 'x', filename: 'x', loaded: true, exports: { from: chain } };
  require.cache[require.resolve('../../lib/cobros/messaging')] = { id: 'm', filename: 'm', loaded: true, exports: { providers: () => ({}), dispatch: async o => { rows.sends.push(o); return o.channel === 'email' ? { ok: true } : null; } } };
  delete require.cache[require.resolve('../../lib/cobros/api')];
  const api = require('../../lib/cobros/api');
  const r1 = await api.markPaid({ tenantId: 't' }, '11111111-1111-4111-8111-111111111111');
  assert.match(r1.message, /marcado como pagado/); assert.match(r1.message, /Comprobante de pago enviado/);
  assert.equal(rows.sends.length >= 1 && rows.sends[0].kind, 'receipt');
  assert.ok(rows.updates.some(u => u.status === 'paid')); assert.ok(rows.updates.some(u => u.receipt_sent_at));
  const before = rows.sends.length;
  rows.inv.status = 'pending'; // simula un segundo cobro del mismo registro ya con comprobante
  await api.markPaid({ tenantId: 't' }, '11111111-1111-4111-8111-111111111111');
  assert.equal(rows.sends.length, before);               // receipt_sent_at impide el doble envío
});

test('integración: botones de PayPal y comprobante en la pantalla, migraciones y ruta', () => {
  const ui = read('public/cobros/index.html');
  assert.match(ui, /data-pplink/); assert.match(ui, /data-ppcheck/); assert.match(ui, /name="paypal"/); assert.match(ui, /Comprobante/);
  assert.match(read('api/cobros.js'), /paypal-check/);
  assert.match(read('supabase/migrations/202611240001_cobros_paypal.sql'), /paypal_invoice_id/);
  assert.match(read('supabase/migrations/202611240002_cobros_recibos.sql'), /receipt_sent_at/);
  assert.match(read('supabase/migrations/202611240002_cobros_recibos.sql'), /'receipt'/);
});

test('días de aviso por cobro: lista elegida, por defecto 3 y 1, el vencimiento y la mora siguen igual', () => {
  const today = '2026-11-23';
  const inv = (due, days) => ({ due_date: due, last_reminder_at: null, remind_days: days });
  assert.deepEqual(L.parseDays('7, 3,1'), [7, 3, 1]);
  assert.deepEqual(L.parseDays('1;7 7'), [7, 1]);
  assert.equal(L.parseDays(''), null);
  assert.equal(L.parseDays(undefined), null);
  for (const bad of ['0', '61', 'a', '2.5', '1,2,3,4,5,6,7']) assert.throws(() => L.parseDays(bad), /días|Máximo/);
  assert.equal(L.shouldRemindToday(inv('2026-11-30', [7, 2]), today), true);   // 7 días antes
  assert.equal(L.shouldRemindToday(inv('2026-11-25', [7, 2]), today), true);   // 2 días antes
  assert.equal(L.shouldRemindToday(inv('2026-11-26', [7, 2]), today), false);  // 3 ya no avisa si se eligió otra lista
  assert.equal(L.shouldRemindToday(inv('2026-11-26', null), today), true);     // por defecto: 3
  assert.equal(L.shouldRemindToday(inv('2026-11-24', null), today), true);     // por defecto: 1
  assert.equal(L.shouldRemindToday(inv('2026-11-23', [7]), today), true);      // el día del vencimiento siempre
  assert.equal(L.shouldRemindToday(inv('2026-11-20', [7]), today), true);      // mora: cada 3 días
  const ui = read('public/cobros/index.html');
  assert.match(ui, /data-ndays/);
  assert.match(read('api/cobros.js'), /notice-days/);
});

test('avisos por cantidad: «N desde D» reparte los días; tasa automática con margen y redondeo hacia arriba', async () => {
  assert.deepEqual(L.spreadDays(2, 3), [3, 1]);          // valores por defecto = 3 y 1 antes
  assert.deepEqual(L.spreadDays(3, 9), [9, 5, 1]);
  assert.deepEqual(L.spreadDays(1, 7), [7]);
  assert.deepEqual(L.spreadDays(6, 3), [3, 2, 1]);       // no más avisos que días disponibles
  assert.deepEqual(L.parseSchedule('3 desde 9'), [9, 5, 1]);
  assert.deepEqual(L.parseSchedule('7, 3, 1'), [7, 3, 1]);
  assert.equal(L.parseSchedule(''), null);
  assert.throws(() => L.parseSchedule('9 desde 5'), /1 a 6 avisos/);
  const fx = require('../../lib/cobros/fx');
  assert.equal(fx.withMarkup(60.039, 0), 60.04);
  assert.equal(fx.withMarkup(60, 1.5), 60.9);
  delete process.env.COBROS_RATE_MARKUP_PCT;
  const ok = await fx.getRate(async () => ({ ok: true, json: async () => ({ rates: { DOP: 60.03921 }, time_last_update_utc: 'hoy' }) }));
  assert.equal(ok.rate, 60.04); assert.equal(ok.source, 'open.er-api.com');
  process.env.COBROS_RATE_MARKUP_PCT = '2';             // cambia el margen: se recalcula (la caché no lo ignora)
  const mk = await fx.getRate(async () => ({ ok: true, json: async () => ({ rates: { DOP: 60 } }) }));
  assert.equal(mk.rate, 61.2);
  delete process.env.COBROS_RATE_MARKUP_PCT;
  process.env.COBROS_RATE_MARKUP_PCT = '3';
  await assert.rejects(() => fx.getRate(async () => { throw new Error('red'); }), /escríbela a mano/);
  delete process.env.COBROS_RATE_MARKUP_PCT;
  const ui = read('public/cobros/index.html');
  assert.match(ui, /name="remind_count"/); assert.match(ui, /name="remind_from"/); assert.match(read('api/cobros.js'), /\^fx\$/);
});

test('cotizaciones y factura: líneas sin ITBIS, numeración, PDF válido y envío con adjunto', async () => {
  assert.throws(() => L.cleanItems([]), /al menos una línea/);
  assert.throws(() => L.cleanItems([{ desc: '', qty: 1, price: 5 }]), /descripción/);
  assert.throws(() => L.cleanItems([{ desc: 'x', qty: 0, price: 5 }]), /cantidad/);
  assert.throws(() => L.cleanItems([{ desc: 'x', qty: 1, price: -1 }]), /negativo/);
  const items = L.cleanItems([{ desc: 'Diseño web', qty: 1, price: 25000 }, { desc: 'Hosting', qty: '2', price: '3500.505' }, { desc: '', qty: '', price: '' }]);
  assert.equal(items.length, 2);
  assert.equal(L.itemsTotal(items), 32001.02);              // suma de líneas (precio 3500.505 → 3500.51), sin ITBIS
  assert.equal(L.docNumber('COT', 7), 'COT-0007'); assert.equal(L.docNumber('FAC', 123), 'FAC-0123');

  const docs = require('../../lib/cobros/docs');
  const pdf = await docs.buildPdf({ kind: 'FACTURA', number: 'FAC-0001', date: '2026-11-23', extra: 'Vence: 30/11/2026', client: { name: 'Ana Ñandú' }, items, currency: 'USD', total: 32001.02, notes: ['Gracias — «ok» ✓'],
    payment: { paid: true, method: 'PayPal', txId: 'INV2-X', amountLabel: 'US$32,001.02', currency: 'USD', paidDate: '2026-11-23', ref: 'Factura FAC-0001' } });
  assert.equal(pdf.slice(0, 5).toString(), '%PDF-');          // el símbolo ✓ (fuera de WinAnsi) no tumba la generación
  assert.ok((pdf.toString('latin1').match(/\/Subtype\s*\/Image/g) || []).length >= 2, 'lleva el logo y la firma de CaSa Labs');
  const cot = await docs.buildPdf({ kind: 'COTIZACIÓN', number: 'COT-0001', date: '2026-11-23', validUntil: '2026-11-30', client: { name: 'Ana' }, items, currency: 'DOP', total: 32001.02 });
  assert.equal(cot.slice(0, 5).toString(), '%PDF-');
  const many = L.cleanItems(Array.from({ length: 40 }, (_, i) => ({ desc: 'Línea ' + i + ' con un texto largo para que ocupe varias líneas dentro de la celda de la tabla de detalle', qty: 1, price: 10 })));
  const multi = await docs.buildPdf({ kind: 'FACTURA', number: 'FAC-0002', date: '2026-11-23', client: { name: 'Ana' }, items: many, currency: 'DOP', total: 400 });
  const { PDFDocument } = require('pdf-lib');
  assert.ok((await PDFDocument.load(multi)).getPageCount() >= 2, 'una factura larga pasa a una segunda página');
  assert.equal((await PDFDocument.load(pdf)).getPageCount(), 1);

  // Envío de la factura: por correo, con el PDF adjunto, número asignado una sola vez y registro del envío
  const state = { inv: { id: 'i1', tenant_id: 't', client_id: 'c1', concept: 'Hosting', amount: 100, currency: 'USD', due_date: '2026-12-01', status: 'pending', created_at: '2026-11-23T10:00:00Z', factura_seq: null, items: null, payment_link: 'https://pago.example/x' }, sends: [], updates: [] };
  const client = { id: 'c1', name: 'Ana', email: 'a@x.co', phone: null, opt_in_email: true, opt_in_whatsapp: false };
  const q = table => { const o = { _u: null }; const self = o;
    o.select = () => o; o.eq = () => o; o.is = () => o; o.not = () => o; o.order = () => o; o.limit = () => o;
    o.single = async () => ({ data: { ...state.inv, ...(o._u || {}) }, error: null });
    o.maybeSingle = async () => ({ data: table === 'cobros_invoices' ? { ...state.inv } : client, error: null });
    o.update = u => { o._u = u; Object.assign(state.inv, u); state.updates.push(u); return o; };
    o.then = res => res({ data: table === 'cobros_invoices' ? [{ factura_seq: state.inv.factura_seq }] : null, error: null });
    return self; };
  require.cache[require.resolve('../../lib/supabase')] = { id: 's', filename: 's', loaded: true, exports: { from: q } };
  require.cache[require.resolve('../../lib/cobros/messaging')] = { id: 'm', filename: 'm', loaded: true, exports: { providers: () => ({}), dispatch: async o => { state.sends.push(o); return { ok: true }; } } };
  delete require.cache[require.resolve('../../lib/cobros/api')];
  const api = require('../../lib/cobros/api');
  const r = await api.facturar({ tenantId: 't' }, '11111111-1111-4111-8111-111111111111');
  assert.equal(r.sent, true); assert.equal(r.number, 'FAC-0001');
  const s = state.sends[0];
  assert.equal(s.kind, 'factura'); assert.equal(s.channel, 'email');
  assert.equal(s.attachments[0].filename, 'FAC-0001.pdf'); assert.equal(s.attachments[0].content.slice(0, 5).toString(), '%PDF-');
  assert.match(s.body, /https:\/\/pago\.example\/x/);
  assert.ok(state.updates.some(u => u.factura_sent_at));
  const pdfOnly = await api.facturaPdf({ tenantId: 't' }, '11111111-1111-4111-8111-111111111111');
  assert.equal(pdfOnly.filename, 'FAC-0001.pdf');            // el número ya asignado no cambia
  assert.equal(Buffer.from(pdfOnly.base64, 'base64').slice(0, 5).toString(), '%PDF-');
});

test('integración: pestaña Cotizaciones, botones de factura, rutas y migración (sin ITBIS)', () => {
  const ui = read('public/cobros/index.html');
  assert.match(ui, /\['cotizaciones','Cotizaciones'\]/); assert.match(ui, /data-fact/); assert.match(ui, /data-qconv/); assert.match(ui, /data-fpdf/);
  assert.doesNotMatch(ui, /name="itbis"|ITBIS \(18/i);           // este sistema no maneja ITBIS
  const a = read('api/cobros.js');
  for (const r of ['quotes\\\\/', 'factura', 'pdf']) assert.ok(a.includes(r.replace(/\\\\/g, '\\')), r);
  const sql = read('supabase/migrations/202611250002_cobros_cotizaciones.sql');
  assert.match(sql, /cobros_quotes/); assert.match(sql, /factura_seq/); assert.match(sql, /'quote','factura'/);
  assert.match(read('lib/mail.js'), /attachments/);
});

test('lista de correos pegada: se limpia, respeta bajas y clientes sin consentimiento, solo correo, y personaliza', async () => {
  const n = L.normalizeRecipients([{ email: ' Ana@Empresa.com ', name: 'Ana' }, { email: 'ana@empresa.com' }, { email: 'malo@' }, { email: 'sin-arroba' }, { email: 'luis@otra.co', name: 'Luis' }, { email: 'baja@x.com' }, { email: '' }]);
  assert.deepEqual(n.valid.map(r => r.email), ['ana@empresa.com', 'luis@otra.co', 'baja@x.com']);
  assert.equal(n.invalid, 2); assert.equal(n.duplicates, 1);
  assert.equal(L.fillVars('Hola {{nombre}}, somos {{negocio}}', { name: '' }), 'Hola, somos ' + L.businessName());   // sin nombre no queda «Hola ,»

  const sent = [], tables = {};
  const data = { cobros_optouts: [{ email: 'baja@x.com' }], cobros_clients: [{ email: 'luis@otra.co', opt_in_email: false }] };
  const q = table => { const o = {}; ['select', 'eq', 'in', 'contains', 'order', 'limit'].forEach(k => { o[k] = () => o; });
    o.insert = row => { tables[table] = row; return o; }; o.update = () => o; o.single = async () => ({ data: { id: 'camp1' }, error: null });
    o.then = res => res({ data: data[table] || [], error: null }); return o; };
  require.cache[require.resolve('../../lib/supabase')] = { id: 's', filename: 's', loaded: true, exports: { from: q } };
  require.cache[require.resolve('../../lib/cobros/messaging')] = { id: 'm', filename: 'm', loaded: true, exports: { providers: () => ({}), dispatch: async o => { sent.push(o); return { ok: true }; } } };
  delete require.cache[require.resolve('../../lib/cobros/api')];
  const api = require('../../lib/cobros/api');
  const emails = [{ email: 'ana@empresa.com', name: 'Ana' }, { email: 'ANA@empresa.com' }, { email: 'luis@otra.co', name: 'Luis' }, { email: 'baja@x.com' }, { email: 'roto@' }];
  const base = { name: 'Oferta', subject: 'Hola', body: 'Hola {{nombre}}, te ofrecemos páginas web.', confirm: true, audience: 'list', emails };
  await assert.rejects(() => api.sendCampaign({ tenantId: 't' }, { ...base, channel: 'whatsapp' }), /solo admite el canal Correo/);
  await assert.rejects(() => api.sendCampaign({ tenantId: 't' }, { ...base, channel: 'email', confirm: false }), /Confirma/);
  const r = await api.sendCampaign({ tenantId: 't' }, { ...base, channel: 'email' });
  assert.deepEqual(sent.map(s => s.client.email), ['ana@empresa.com']);          // fuera: repetido, inválido, baja y cliente sin consentimiento
  assert.equal(sent[0].kind, 'promo'); assert.equal(sent[0].channel, 'email');
  assert.match(sent[0].body, /^Hola Ana, te ofrecemos/); assert.match(sent[0].body, /responde BAJA/);
  assert.deepEqual(r.skipped, { invalid: 1, duplicates: 1, optout: 2 });
  assert.equal(r.sent, 1);
  const ui = read('public/cobros/index.html');
  assert.match(ui, /id="list-text"/); assert.match(ui, /id="list-file"/); assert.match(ui, /__list/); assert.match(ui, /data-obdel/);
  assert.match(read('api/cobros.js'), /optouts/);
  assert.match(read('supabase/migrations/202611250003_cobros_bajas.sql'), /cobros_optouts/);
});
