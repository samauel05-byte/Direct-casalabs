// Rutas del módulo Cobros. Todo filtra por tenant_id en el servidor.
const supabase = require('../supabase');
const { fail, uuid, dbError } = require('../nala/http');
const L = require('./logic');
const { dispatch, providers } = require('./messaging');
const pp = require('./paypal');

const MAX_RECIPIENTS = 150; // sin cola: tope por envío para no pasar el tiempo máximo de la función
const CONCURRENCY = 5;
const s = v => String(v == null ? '' : v).trim();
const PHONE_RE = /^\+\d{8,15}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function must(promise) { const { data, error } = await promise; if (error) throw dbError ? dbError(error) : error; return data; }

async function me(ctx) { return { providers: providers(), business: L.businessName() }; }

async function dashboard(ctx) {
  const today = L.todayDO();
  const [invoices, clients, log] = await Promise.all([
    must(supabase.from('cobros_invoices').select('amount,currency,status,due_date,paid_at').eq('tenant_id', ctx.tenantId)),
    supabase.from('cobros_clients').select('id', { count: 'exact', head: true }).eq('tenant_id', ctx.tenantId),
    must(supabase.from('cobros_log').select('id,channel,kind,recipient,status,error,created_at').eq('tenant_id', ctx.tenantId).order('created_at', { ascending: false }).limit(8)),
  ]);
  return { totals: L.totals(invoices || [], today), clients: clients.count || 0, recent: log || [], providers: providers() };
}

async function listClients(ctx) {
  return { clients: await must(supabase.from('cobros_clients').select('*').eq('tenant_id', ctx.tenantId).order('created_at', { ascending: false })) };
}

async function createClient(ctx, b) {
  const name = s(b.name);
  if (!name) fail(400, 'El nombre es obligatorio.');
  const phone = s(b.phone).replace(/[\s()-]/g, '');
  if (phone && !PHONE_RE.test(phone)) fail(400, 'El teléfono debe tener formato internacional, ej. +18095551234.');
  const email = s(b.email).toLowerCase();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'El correo no es válido.');
  const row = {
    tenant_id: ctx.tenantId, name, email: email || null, phone: phone || null, company: s(b.company) || null,
    tags: L.parseTags(b.tags), notes: s(b.notes) || null,
    opt_in_email: b.opt_in_email !== false, opt_in_whatsapp: b.opt_in_whatsapp === true,
  };
  return { client: await must(supabase.from('cobros_clients').insert(row).select('*').single()) };
}

async function deleteClient(ctx, id) {
  await must(supabase.from('cobros_clients').delete().eq('tenant_id', ctx.tenantId).eq('id', uuid(id)));
  return {};
}

async function optOut(ctx, id, b) {
  const col = b.channel === 'whatsapp' ? 'opt_in_whatsapp' : 'opt_in_email';
  await must(supabase.from('cobros_clients').update({ [col]: false }).eq('tenant_id', ctx.tenantId).eq('id', uuid(id)));
  return {};
}

async function listInvoices(ctx) {
  const [invoices, clients] = await Promise.all([
    must(supabase.from('cobros_invoices').select('*').eq('tenant_id', ctx.tenantId).order('due_date')),
    must(supabase.from('cobros_clients').select('id,name').eq('tenant_id', ctx.tenantId).order('name')),
  ]);
  const names = new Map((clients || []).map(c => [c.id, c.name]));
  return { today: L.todayDO(), providers: providers(), clients: clients || [], invoices: (invoices || []).map(i => ({ ...i, client_name: names.get(i.client_id) || '—' })) };
}

// Envía el recordatorio por los canales aceptados y actualiza last_reminder_at/reminder_count.
async function remind(ctx, inv, client, kind = 'reminder') {
  const { subject, body } = L.reminderMessage(inv, client, L.daysBetween(L.todayDO(), inv.due_date));
  const out = { sent: 0, failed: 0, skipped: false, errors: [] };
  for (const channel of ['email', 'whatsapp']) {
    const r = await dispatch({ tenantId: inv.tenant_id, channel, kind, client, subject, body, invoiceId: inv.id });
    if (!r) continue;
    if (r.ok) out.sent++; else { out.failed++; if (r.error) out.errors.push(r.error); }
  }
  if (!out.sent && !out.failed) out.skipped = true;
  if (out.sent) await supabase.from('cobros_invoices').update({ last_reminder_at: new Date().toISOString(), reminder_count: (inv.reminder_count || 0) + 1 }).eq('id', inv.id);
  return out;
}

function summarize(o) {
  if (o.skipped) return { ok: false, message: 'El cliente no tiene un canal aceptado (consentimiento y dato de contacto).' };
  if (o.failed && !o.sent) return { ok: false, message: `No se pudo enviar: ${o.errors[0] || 'error desconocido'}. Queda registrado en el historial.` };
  if (o.failed) return { ok: true, message: `Enviado por ${o.sent} canal(es); ${o.failed} falló (ver historial).` };
  return { ok: true, message: 'Mensaje enviado.' };
}

async function createInvoice(ctx, b) {
  const amount = Number(String(b.amount ?? '').replace(/,/g, ''));
  const due = s(b.due_date);
  if (!s(b.client_id) || !s(b.concept) || !(amount > 0) || !DATE_RE.test(due)) fail(400, 'Completa cliente, concepto, monto (mayor que 0) y fecha de vencimiento.');
  const link = s(b.payment_link);
  if (link && !/^https?:\/\//i.test(link)) fail(400, 'El enlace de pago debe empezar con http:// o https://');
  const client = await must(supabase.from('cobros_clients').select('*').eq('tenant_id', ctx.tenantId).eq('id', uuid(b.client_id)).maybeSingle());
  if (!client) fail(404, 'Cliente no encontrado.');
  const inv = await must(supabase.from('cobros_invoices').insert({
    tenant_id: ctx.tenantId, client_id: client.id, concept: s(b.concept), amount, currency: b.currency === 'USD' ? 'USD' : 'DOP',
    due_date: due, payment_link: link || null,
  }).select('*').single());
  let message = 'Cobro creado.';
  let current = inv;
  if (b.paypal === true && !inv.payment_link) {
    try { current = await attachPaypal(inv, client, b.rate); message += ' Enlace de PayPal generado.'; }
    catch (e) { message += ` No se pudo generar el enlace de PayPal: ${e.message}. Puedes generarlo después con el botón «Enlace PayPal».`; }
  }
  if (b.notify === true) message += ' ' + summarize(await remind(ctx, current, client, 'invoice')).message;
  return { invoice: current, message };
}

// Envía el comprobante de pago por los canales aceptados (una sola vez: receipt_sent_at).
async function sendReceipt(inv, client) {
  if (inv.receipt_sent_at) return { skipped: true, message: 'El comprobante ya se había enviado.' };
  const { subject, body } = L.receiptMessage(inv, client);
  let sent = 0, failed = 0, firstError = '';
  for (const channel of ['email', 'whatsapp']) {
    const r = await dispatch({ tenantId: inv.tenant_id, channel, kind: 'receipt', client, subject, body, invoiceId: inv.id });
    if (!r) continue;
    if (r.ok) sent++; else { failed++; firstError = firstError || r.error || ''; }
  }
  if (sent) await supabase.from('cobros_invoices').update({ receipt_sent_at: new Date().toISOString() }).eq('id', inv.id);
  const message = sent ? 'Comprobante de pago enviado al cliente.'
    : failed ? `No se pudo enviar el comprobante: ${firstError || 'error desconocido'} (queda en el historial).`
    : 'No se envió comprobante: el cliente no tiene un canal aceptado.';
  return { sent, failed, message };
}

// Marca un cobro como pagado y manda el comprobante automáticamente.
async function settle(inv, client) {
  const paid_at = new Date().toISOString();
  await must(supabase.from('cobros_invoices').update({ status: 'paid', paid_at }).eq('id', inv.id));
  const r = client ? await sendReceipt({ ...inv, status: 'paid', paid_at }, client) : { message: '' };
  return r.message;
}

// Crea la factura en PayPal y guarda el enlace en el cobro.
async function attachPaypal(inv, client, rate) {
  const r = await pp.createInvoiceLink(inv, client, rate);
  const patch = { payment_link: r.url, paypal_invoice_id: r.id, paypal_usd_amount: r.usd, paypal_rate: r.rate };
  await must(supabase.from('cobros_invoices').update(patch).eq('id', inv.id));
  return { ...inv, ...patch };
}

async function paypalLink(ctx, id, b) {
  const inv = await must(supabase.from('cobros_invoices').select('*').eq('tenant_id', ctx.tenantId).eq('id', uuid(id)).maybeSingle());
  if (!inv) fail(404, 'No se encontró el cobro.');
  if (inv.status === 'paid' || inv.status === 'cancelled') fail(400, 'Ese cobro ya no está pendiente.');
  if (inv.paypal_invoice_id) fail(400, 'Ese cobro ya tiene un enlace de PayPal.');
  const client = await must(supabase.from('cobros_clients').select('*').eq('id', inv.client_id).maybeSingle());
  if (!client) fail(404, 'No se encontró el cliente.');
  try { const u = await attachPaypal(inv, client, b.rate); return { payment_link: u.payment_link, message: 'Enlace de PayPal generado.' }; }
  catch (e) { if (e.status) fail(e.status, e.message); fail(502, `No se pudo generar el enlace de PayPal: ${e.message}`); }
}

// Pregunta a PayPal si ya pagaron; si sí, marca el cobro como pagado.
async function checkPaypal(ctx, id) {
  const inv = await must(supabase.from('cobros_invoices').select('*').eq('tenant_id', ctx.tenantId).eq('id', uuid(id)).maybeSingle());
  if (!inv || !inv.paypal_invoice_id) fail(404, 'Ese cobro no tiene factura de PayPal.');
  let state; try { state = await pp.invoiceState(inv.paypal_invoice_id); } catch (e) { fail(502, `No se pudo consultar PayPal: ${e.message}`); }
  let receipt = '';
  if (state === 'paid' && inv.status !== 'paid') {
    const client = await must(supabase.from('cobros_clients').select('*').eq('id', inv.client_id).maybeSingle());
    receipt = await settle(inv, client);
  }
  return { state, message: state === 'paid' ? `PayPal confirma el pago: cobro marcado como pagado. ${receipt}`.trim() : state === 'cancelled' ? 'La factura de PayPal está cancelada.' : 'PayPal todavía no registra el pago.' };
}

async function remindInvoice(ctx, id) {
  const inv = await must(supabase.from('cobros_invoices').select('*').eq('tenant_id', ctx.tenantId).eq('id', uuid(id)).maybeSingle());
  if (!inv) fail(404, 'No se encontró el cobro.');
  if (inv.status === 'paid' || inv.status === 'cancelled') fail(400, 'Ese cobro ya no está pendiente.');
  const client = await must(supabase.from('cobros_clients').select('*').eq('id', inv.client_id).maybeSingle());
  if (!client) fail(404, 'No se encontró el cliente.');
  const r = summarize(await remind(ctx, inv, client));
  return { sent: r.ok, message: r.message };
}

async function markPaid(ctx, id) {
  const inv = await must(supabase.from('cobros_invoices').select('*').eq('tenant_id', ctx.tenantId).eq('id', uuid(id)).maybeSingle());
  if (!inv) fail(404, 'No se encontró el cobro.');
  if (inv.status === 'paid') return { message: 'Ese cobro ya estaba pagado.' };
  const client = await must(supabase.from('cobros_clients').select('*').eq('id', inv.client_id).maybeSingle());
  const receipt = await settle(inv, client);
  return { message: `Cobro marcado como pagado. ${receipt}`.trim() };
}

async function listCampaigns(ctx) {
  const [campaigns, clients] = await Promise.all([
    must(supabase.from('cobros_campaigns').select('id,name,channel,audience_tag,status,sent_count,failed_count,created_at').eq('tenant_id', ctx.tenantId).order('created_at', { ascending: false }).limit(20)),
    must(supabase.from('cobros_clients').select('tags').eq('tenant_id', ctx.tenantId)),
  ]);
  return { campaigns: campaigns || [], tags: [...new Set((clients || []).flatMap(c => c.tags || []))].sort(), providers: providers() };
}

async function sendCampaign(ctx, b) {
  const name = s(b.name), channel = s(b.channel), subject = s(b.subject), body = s(b.body), tag = s(b.tag).toLowerCase();
  if (!name || !body || !['email', 'whatsapp', 'both'].includes(channel)) fail(400, 'Completa nombre, canal y mensaje.');
  if (channel !== 'whatsapp' && !subject) fail(400, 'El asunto es obligatorio para correo.');
  if (b.confirm !== true) fail(400, 'Confirma que los destinatarios aceptaron recibir promociones y que el mensaje incluye la baja.');

  let q = supabase.from('cobros_clients').select('*').eq('tenant_id', ctx.tenantId);
  if (tag) q = q.contains('tags', [tag]);
  let clients = await must(q.limit(MAX_RECIPIENTS + 1)) || [];
  const truncated = clients.length > MAX_RECIPIENTS;
  clients = clients.slice(0, MAX_RECIPIENTS);

  const camp = await must(supabase.from('cobros_campaigns').insert({
    tenant_id: ctx.tenantId, name, channel, subject: subject || null, body, audience_tag: tag || null, status: 'sending',
  }).select('id').single());

  const channels = channel === 'both' ? ['email', 'whatsapp'] : [channel];
  let sent = 0, failed = 0;
  for (let i = 0; i < clients.length; i += CONCURRENCY) {
    await Promise.all(clients.slice(i, i + CONCURRENCY).map(async c => {
      for (const ch of channels) {
        // dispatch respeta opt_in_*: devuelve null (sin enviar) si no lo aceptó
        const r = await dispatch({ tenantId: ctx.tenantId, channel: ch, kind: 'promo', client: c, subject: L.fillVars(subject, c), body: L.fillVars(body, c) + L.UNSUBSCRIBE_FOOTER, campaignId: camp.id });
        if (r && r.ok) sent++; else if (r) failed++;
      }
    }));
  }
  await supabase.from('cobros_campaigns').update({ status: 'sent', sent_count: sent, failed_count: failed }).eq('id', camp.id);
  return { sent, failed, truncated, max: MAX_RECIPIENTS,
    message: `Campaña procesada: ${sent} enviados, ${failed} fallidos.${truncated ? ` Se limitó a ${MAX_RECIPIENTS} destinatarios; repite el envío con una etiqueta más específica.` : ''}` };
}

async function listLog(ctx) {
  const [log, clients] = await Promise.all([
    must(supabase.from('cobros_log').select('*').eq('tenant_id', ctx.tenantId).order('created_at', { ascending: false }).limit(200)),
    must(supabase.from('cobros_clients').select('id,name').eq('tenant_id', ctx.tenantId)),
  ]);
  const names = new Map((clients || []).map(c => [c.id, c.name]));
  return { log: (log || []).map(m => ({ ...m, client_name: names.get(m.client_id) || '—' })) };
}

// Cron diario (todas las firmas): marca vencidos y recuerda según la regla de días. Usa la sesión de servicio.
async function runDaily() {
  const today = L.todayDO();
  const marked = await must(supabase.from('cobros_invoices').update({ status: 'overdue' }).eq('status', 'pending').lt('due_date', today).select('id'));
  let open = await must(supabase.from('cobros_invoices').select('*').in('status', ['pending', 'overdue'])) || [];
  // Pagos hechos por el enlace de PayPal: se marcan como pagados y dejan de recibir recordatorios.
  let paidByPaypal = 0;
  if (require('../paypal').hasCredentials()) {
    for (const inv of open.filter(i => i.paypal_invoice_id)) {
      try {
        if (await pp.invoiceState(inv.paypal_invoice_id) === 'paid') {
          const c = (await supabase.from('cobros_clients').select('*').eq('id', inv.client_id).maybeSingle()).data;
          await settle(inv, c);
          inv.status = 'paid'; paidByPaypal++;
        }
      } catch (_) { /* PayPal caído: se reintenta mañana, y se recuerda igual */ }
    }
    open = open.filter(i => i.status !== 'paid');
  }
  const clientIds = [...new Set(open.map(i => i.client_id))];
  const clients = clientIds.length ? await must(supabase.from('cobros_clients').select('*').in('id', clientIds)) : [];
  const byId = new Map((clients || []).map(c => [c.id, c]));
  // Reintenta los comprobantes que no salieron (cobros pagados en los últimos 3 días sin comprobante enviado).
  const since = new Date(Date.now() - 3 * 86400000).toISOString();
  const pend = await must(supabase.from('cobros_invoices').select('*').eq('status', 'paid').is('receipt_sent_at', null).gte('paid_at', since)) || [];
  let receipts = 0;
  for (const inv of pend) {
    const c = (await supabase.from('cobros_clients').select('*').eq('id', inv.client_id).maybeSingle()).data;
    if (c && (await sendReceipt(inv, c)).sent) receipts++;
  }
  let reminded = 0, failed = 0, skipped = 0;
  for (const inv of open) {
    const client = byId.get(inv.client_id);
    if (!client || !L.shouldRemindToday(inv, today)) continue;
    const r = await remind({}, inv, client);
    if (r.skipped) skipped++; else if (r.sent) reminded++; else failed++;
  }
  return { today, markedOverdue: (marked || []).length, paidByPaypal, receipts, reminded, failed, skipped };
}

module.exports = { me, dashboard, listClients, createClient, deleteClient, optOut, listInvoices, createInvoice, remindInvoice, paypalLink, checkPaypal, markPaid, listCampaigns, sendCampaign, listLog, runDaily };
