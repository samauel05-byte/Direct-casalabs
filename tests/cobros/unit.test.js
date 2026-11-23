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
