// Envío por correo (SMTP con la cuenta propia de Cobros) y WhatsApp (Twilio por fetch). Nunca lanzan: devuelven {ok, error}.
// Cada envío —también el fallido— se registra en cobros_log. Respeta opt_in_* del cliente.
const supabase = require('../supabase');

// Correo: por SMTP con la cuenta PROPIA de Cobros (COBROS_SMTP_USER / COBROS_SMTP_PASS sobre el mismo servidor SMTP de Direct).
// Estricto: si no está configurada NO se usa el buzón compartido de licencias/Monitor; el envío falla y queda registrado.
const cobrosAccount = () => require('../mail').accountConfig('COBROS');
async function sendEmail(to, subject, text, attachments, headers) {
  const mail = require('../mail');
  const account = cobrosAccount();
  if (!account.smtp.ok) return { ok: false, error: 'Falta configurar el correo de Cobros (COBROS_SMTP_USER y COBROS_SMTP_PASS; el servidor se hereda del SMTP de Direct)' };
  try {
    const r = await mail.send({ to, subject, text, attachments, headers }, account);
    return r.ok ? { ok: true } : { ok: false, error: `Correo: ${r.error || 'no se pudo enviar'}` };
  } catch (e) { return { ok: false, error: `Correo: ${String(e.message || e).slice(0, 180)}` }; }
}

async function sendWhatsApp(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_WHATSAPP_FROM;
  if (!sid || !token || !from) return { ok: false, error: 'Falta configurar TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN o TWILIO_WHATSAPP_FROM' };
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: from, To: `whatsapp:${String(to).replace(/^whatsapp:/, '')}`, Body: body }),
    });
    if (!res.ok) return { ok: false, error: `Twilio ${res.status}: ${(await res.text()).slice(0, 300)}` };
    return { ok: true };
  } catch (e) { return { ok: false, error: `Twilio: ${e.message || 'error de red'}` }; }
}

const providers = () => ({
  email: require('../mail').accountConfig('COBROS').smtp.ok,
  paypal: require('../paypal').hasCredentials(),
  whatsapp: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM),
});

// Devuelve null (sin enviar ni registrar) si el cliente no aceptó el canal o no tiene el dato.
async function dispatch({ tenantId, channel, kind, client, subject, body, invoiceId, campaignId, attachments, headers }) {
  const dest = channel === 'email' ? client.email : client.phone;
  const optedIn = channel === 'email' ? client.opt_in_email : client.opt_in_whatsapp;
  if (!optedIn || !dest) return null;
  const result = channel === 'email' ? await sendEmail(dest, subject, body, attachments, headers) : await sendWhatsApp(dest, body);
  try {
    await supabase.from('cobros_log').insert({
      tenant_id: tenantId, client_id: client.id, invoice_id: invoiceId || null, campaign_id: campaignId || null,
      channel, kind, recipient: dest, body: channel === 'email' ? `${subject}\n\n${body}` : body,
      status: result.ok ? 'sent' : 'failed', error: result.ok ? null : (result.error || 'Error desconocido'),
    });
  } catch (_) { /* el registro nunca debe tumbar el envío */ }
  return result;
}

module.exports = { sendEmail, sendWhatsApp, dispatch, providers };
