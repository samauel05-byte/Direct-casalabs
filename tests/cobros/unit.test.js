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
