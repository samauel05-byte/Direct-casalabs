// Envío de correo de Direct: SIEMPRE desde el buzón corporativo (obligatorio).
//
// - Se envía por SMTP con la cuenta del buzón empresarial. IMAP no puede enviar:
//   se usa para guardar una copia en la carpeta «Enviados» del mismo buzón, para
//   que cada correo quede visible allí como si se hubiera escrito a mano.
// - No hay proveedor alternativo (Resend, Gmail, etc.): si el buzón corporativo
//   no está configurado, el correo NO se envía.
// - El remitente es siempre la cuenta del buzón (MAIL_FROM solo puede cambiar el
//   nombre mostrado, nunca la dirección).
//
// Variables (con compatibilidad hacia atrás con LICENSE_* y MONITOR_*):
//   MAIL_SMTP_HOST, MAIL_SMTP_PORT (587), MAIL_SMTP_USER, MAIL_SMTP_PASS
//   MAIL_FROM_NAME (opcional, nombre visible)
//   MAIL_IMAP_HOST, MAIL_IMAP_PORT (993), MAIL_IMAP_USER, MAIL_IMAP_PASS,
//   MAIL_IMAP_SENT (carpeta; por omisión se detecta la de «Enviados»)

const env = () => process.env;
const first = (...v) => v.find(x => x !== undefined && x !== null && String(x).trim() !== '') || '';

function config(e = env()) {
  const user = first(e.MAIL_SMTP_USER, e.LICENSE_SMTP_USER, e.MONITOR_SMTP_USER);
  const pass = first(e.MAIL_SMTP_PASS, e.LICENSE_SMTP_PASS, e.MONITOR_SMTP_PASS);
  const host = first(e.MAIL_SMTP_HOST, e.LICENSE_SMTP_HOST, e.MONITOR_SMTP_HOST);
  const port = Number(first(e.MAIL_SMTP_PORT, e.LICENSE_SMTP_PORT, e.MONITOR_SMTP_PORT, 587));
  const name = first(e.MAIL_FROM_NAME);
  const imapHost = first(e.MAIL_IMAP_HOST);
  return {
    smtp: { host, port, user, pass, ok: !!(host && user && pass) },
    // El remitente es siempre la cuenta del buzón; solo se admite un nombre visible.
    from: name ? { name, address: user } : user,
    imap: imapHost ? {
      host: imapHost, port: Number(first(e.MAIL_IMAP_PORT, 993)),
      user: first(e.MAIL_IMAP_USER, user), pass: first(e.MAIL_IMAP_PASS, pass), sent: first(e.MAIL_IMAP_SENT),
    } : null,
  };
}

function configured() { return config().smtp.ok; }

// Copia en «Enviados» por IMAP. Nunca tumba el envío: si falla, se informa.
async function saveToSent(imap, raw) {
  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({ host: imap.host, port: imap.port, secure: imap.port === 993, auth: { user: imap.user, pass: imap.pass }, logger: false });
  await client.connect();
  try {
    let folder = imap.sent;
    if (!folder) {
      const boxes = await client.list();
      folder = (boxes.find(b => b.specialUse === '\\Sent') || boxes.find(b => /^(sent|enviados|sent items|elementos enviados)$/i.test(b.name)) || {}).path || 'Sent';
    }
    await client.append(folder, raw, ['\\Seen']);
    return folder;
  } finally { await client.logout().catch(() => {}); }
}

// Devuelve { ok, error?, copy: 'ok'|'no_configurada'|'falló: …' }. Lanza solo por error de SMTP.
async function send({ to, subject, text, html, replyTo }) {
  const c = config();
  if (!c.smtp.ok) return { ok: false, error: 'buzon_corporativo_no_configurado' };
  const nodemailer = require('nodemailer');
  const msg = { from: c.from, to, subject, text, html, ...(replyTo ? { replyTo } : {}) };
  const t = nodemailer.createTransport({ host: c.smtp.host, port: c.smtp.port, secure: c.smtp.port === 465, auth: { user: c.smtp.user, pass: c.smtp.pass } });
  try { await t.sendMail(msg); } catch (e) { return { ok: false, error: ('smtp: ' + String(e.message || e)).slice(0, 180) }; }
  let copy = 'no_configurada';
  if (c.imap) {
    try {
      const MailComposer = require('nodemailer/lib/mail-composer');
      const raw = await new MailComposer({ ...msg, date: new Date() }).compile().build();
      await saveToSent(c.imap, raw);
      copy = 'ok';
    } catch (e) { copy = ('falló: ' + String(e.message || e)).slice(0, 120); }
  }
  return { ok: true, copy };
}

module.exports = { config, configured, send };
