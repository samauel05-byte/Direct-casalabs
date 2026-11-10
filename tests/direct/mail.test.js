const test = require('node:test');
const assert = require('node:assert/strict');
const { config } = require('../../lib/mail');

test('mail: sin buzón corporativo no hay envío', () => {
  const c = config({});
  assert.equal(c.smtp.ok, false);
  assert.equal(c.imap, null);
});

test('mail: remitente siempre es la cuenta del buzón (solo cambia el nombre visible)', () => {
  const c = config({ MAIL_SMTP_HOST: 'smtp.x.com', MAIL_SMTP_USER: 'samuel@saveconsult.net', MAIL_SMTP_PASS: 'p', MAIL_FROM_NAME: 'Direct', MAIL_FROM: 'otro@gmail.com' });
  assert.equal(c.smtp.ok, true);
  assert.deepEqual(c.from, { name: 'Direct', address: 'samuel@saveconsult.net' });
});

test('mail: respeta las variables anteriores LICENSE_/MONITOR_ y activa la copia IMAP solo si se configura', () => {
  const old = config({ MONITOR_SMTP_HOST: 'h', MONITOR_SMTP_USER: 'u@d.com', MONITOR_SMTP_PASS: 'p' });
  assert.equal(old.smtp.ok, true);
  assert.equal(old.imap, null);
  const withImap = config({ MAIL_SMTP_HOST: 'h', MAIL_SMTP_USER: 'u@d.com', MAIL_SMTP_PASS: 'p', MAIL_IMAP_HOST: 'imap.d.com' });
  assert.equal(withImap.imap.user, 'u@d.com');
  assert.equal(withImap.imap.port, 993);
});
