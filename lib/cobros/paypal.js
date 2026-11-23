// Enlace de cobro con PayPal para un cobro de Cobros, usando la API de Facturas (v2/invoicing):
// crea la factura, la «envía» sin notificar (solo para obtener el enlace del pagador) y la consulta después.
// PayPal no admite DOP: un cobro en RD$ se factura en US$ con la tasa (RD$ por US$) indicada.
const paypal = require('../paypal');

const toUsd = (amount, rate) => Math.round((Number(amount) / Number(rate)) * 100) / 100;
const ymd = d => String(d).slice(0, 10);
const idFromHref = href => String(href || '').split('/').pop();

function usdAmount(inv, rate) {
  if (inv.currency === 'USD') return Number(inv.amount);
  const r = Number(rate);
  if (!(r > 20 && r < 500)) { const e = new Error('Para cobrar en RD$ por PayPal indica la tasa (RD$ por cada US$), por ejemplo 60.50.'); e.status = 400; throw e; }
  return toUsd(inv.amount, r);
}

async function createInvoiceLink(inv, client, rate) {
  if (!paypal.hasCredentials()) { const e = new Error('PayPal no está configurado en el servidor (PAYPAL_CLIENT_ID y PAYPAL_CLIENT_SECRET).'); e.status = 503; throw e; }
  if (!client.email) { const e = new Error('El cliente necesita un correo para generar el enlace de PayPal.'); e.status = 400; throw e; }
  const usd = usdAmount(inv, rate);
  if (!(usd >= 1)) { const e = new Error('El monto en US$ debe ser de al menos 1.00 para PayPal.'); e.status = 400; throw e; }

  const next = await paypal.api('/v2/invoicing/generate-next-invoice-number', { method: 'POST', body: '{}' });
  const note = inv.currency === 'DOP' ? `Equivale a RD$ ${Number(inv.amount).toFixed(2)} a tasa ${Number(rate).toFixed(2)} RD$ por US$.` : undefined;
  const name = String(client.name || '').trim();
  const created = await paypal.api('/v2/invoicing/invoices', {
    method: 'POST',
    body: JSON.stringify({
      detail: {
        invoice_number: next.invoice_number, currency_code: 'USD', invoice_date: ymd(new Date().toISOString()),
        payment_term: { due_date: ymd(inv.due_date) }, ...(note ? { note } : {}),
      },
      primary_recipients: [{ billing_info: { name: { given_name: name.slice(0, 140) || 'Cliente' }, email_address: client.email } }],
      items: [{ name: String(inv.concept).slice(0, 200), quantity: '1', unit_amount: { currency_code: 'USD', value: usd.toFixed(2) } }],
      configuration: { allow_tip: false },
    }),
  });
  const id = idFromHref(created.href);
  if (!id) throw new Error('PayPal no devolvió el identificador de la factura.');
  // send_to_recipient:false → PayPal no escribe al cliente; Cobros manda el recordatorio por su cuenta.
  const sent = await paypal.api(`/v2/invoicing/invoices/${encodeURIComponent(id)}/send`, { method: 'POST', body: JSON.stringify({ send_to_recipient: false, send_to_invoicer: false }) });
  let url = sent && /^https:\/\//.test(sent.href || '') && !/\/v2\/invoicing\//.test(sent.href) ? sent.href : '';
  if (!url) {
    const full = await paypal.api(`/v2/invoicing/invoices/${encodeURIComponent(id)}`);
    url = full?.detail?.metadata?.recipient_view_url || '';
  }
  if (!url) throw new Error('PayPal no devolvió el enlace de pago.');
  return { id, url, usd, rate: inv.currency === 'DOP' ? Number(rate) : null };
}

// 'paid' | 'open' | 'cancelled'
async function invoiceState(paypalInvoiceId) {
  const d = await paypal.api(`/v2/invoicing/invoices/${encodeURIComponent(paypalInvoiceId)}`);
  const s = String(d.status || '').toUpperCase();
  if (s === 'PAID' || s === 'MARKED_AS_PAID') return 'paid';
  if (s === 'CANCELLED' || s === 'MARKED_AS_REFUNDED' || s === 'REFUNDED') return 'cancelled';
  return 'open';
}

module.exports = { createInvoiceLink, invoiceState, usdAmount, toUsd };
