// Envío por correo (Resend) y WhatsApp (Twilio) con fetch, sin SDKs. Nunca lanzan: devuelven {ok, error}.
// Cada envío —también el fallido— se registra en cobros_log. Respeta opt_in_* del cliente.
const supabase = require('../supabase');

async function sendEmail(to, subject, text) {
  const key = process.env.RESEND_API_KEY, from = process.env.RESEND_FROM;
  if (!key || !from) return { ok: false, error: 'Falta configurar RESEND_API_KEY o RESEND_FROM' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${(await res.text()).slice(0, 300)}` };
    return { ok: true };
  } catch (e) { return { ok: false, error: `Resend: ${e.message || 'error de red'}` }; }
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
  email: !!(process.env.RESEND_API_KEY && process.env.RESEND_FROM),
  whatsapp: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM),
});

// Devuelve null (sin enviar ni registrar) si el cliente no aceptó el canal o no tiene el dato.
async function dispatch({ tenantId, channel, kind, client, subject, body, invoiceId, campaignId }) {
  const dest = channel === 'email' ? client.email : client.phone;
  const optedIn = channel === 'email' ? client.opt_in_email : client.opt_in_whatsapp;
  if (!optedIn || !dest) return null;
  const result = channel === 'email' ? await sendEmail(dest, subject, body) : await sendWhatsApp(dest, body);
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
