// Rutas del módulo Cobros. Todo filtra por tenant_id en el servidor.
const supabase = require('../supabase');
const { fail, uuid, dbError } = require('../nala/http');
const L = require('./logic');
const { dispatch, providers } = require('./messaging');
const pp = require('./paypal');
const fx = require('./fx');
const docs = require('./docs');
const unsub = require('./unsub');
const P = require('./plans');
const enforce = require('./enforce');
const { isPlatformAdmin } = require('../licenses');

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
  const today = L.todayDO();
  const { subject, body } = L.reminderMessage(inv, client, L.daysBetween(today, inv.due_date), kind === 'invoice' ? -1 : undefined);
  const out = { sent: 0, failed: 0, skipped: false, errors: [] };
  for (const channel of ['email', 'whatsapp']) {
    const r = await dispatch({ tenantId: inv.tenant_id, channel, kind, client, subject, body, invoiceId: inv.id });
    if (!r) continue;
    if (r.ok) out.sent++; else { out.failed++; if (r.error) out.errors.push(r.error); }
  }
  if (!out.sent && !out.failed) out.skipped = true;
  if (out.sent && kind === 'reminder') await supabase.from('cobros_invoices').update({ last_reminder_at: new Date().toISOString(), reminder_count: (inv.reminder_count || 0) + 1, last_reminder_day: today, reminders_today: L.sentToday(inv, today) + 1 }).eq('id', inv.id);
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
  let days = null, dates = null;
  try { dates = L.parseDates(b.remind_dates, L.todayDO()); if (!dates) days = b.remind_count ? L.spreadDays(b.remind_count, b.remind_from) : L.parseSchedule(b.remind_days); } catch (e) { fail(400, e.message); }
  const link = s(b.payment_link);
  if (link && !/^https?:\/\//i.test(link)) fail(400, 'El enlace de pago debe empezar con http:// o https://');
  const client = await must(supabase.from('cobros_clients').select('*').eq('tenant_id', ctx.tenantId).eq('id', uuid(b.client_id)).maybeSingle());
  if (!client) fail(404, 'Cliente no encontrado.');
  const inv = await must(supabase.from('cobros_invoices').insert({
    tenant_id: ctx.tenantId, client_id: client.id, concept: s(b.concept), amount, currency: b.currency === 'USD' ? 'USD' : 'DOP',
    due_date: due, payment_link: link || null, remind_days: days, remind_dates: dates, remind_per_day: L.parsePerDay(b.remind_per_day), remind_overdue: b.remind_overdue !== false,
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

// Edita un cobro pendiente o vencido (concepto, monto, moneda, vencimiento, enlace, cliente).
// Si cambian el monto o la moneda y el cobro tiene factura de PayPal, esa factura se cancela (si no, se podría pagar el monto viejo)
// y el enlace se desvincula para generar uno nuevo; las líneas de una cotización se descartan porque ya no suman el monto nuevo.
async function updateInvoice(ctx, id, b) {
  const inv = await must(supabase.from('cobros_invoices').select('*').eq('tenant_id', ctx.tenantId).eq('id', uuid(id)).maybeSingle());
  if (!inv) fail(404, 'No se encontró el cobro.');
  if (inv.status === 'paid' || inv.status === 'cancelled') fail(400, 'Ese cobro ya está pagado o cancelado y no se puede editar.');
  const patch = {};
  if (b.concept !== undefined) { const v = s(b.concept); if (!v) fail(400, 'El concepto no puede estar vacío.'); if (v !== inv.concept) patch.concept = v.slice(0, 200); }
  if (b.amount !== undefined) { const a = Number(String(b.amount).replace(/,/g, '')); if (!(a > 0)) fail(400, 'El monto debe ser mayor que 0.'); if (a !== Number(inv.amount)) patch.amount = a; }
  if (b.currency !== undefined) { const c = b.currency === 'USD' ? 'USD' : 'DOP'; if (c !== inv.currency) patch.currency = c; }
  if (b.due_date !== undefined) { const d = s(b.due_date); if (!DATE_RE.test(d)) fail(400, 'La fecha de vencimiento no es correcta.'); if (d !== String(inv.due_date).slice(0, 10)) patch.due_date = d; }
  if (b.client_id !== undefined && s(b.client_id) && s(b.client_id) !== inv.client_id) {
    const c = await must(supabase.from('cobros_clients').select('id').eq('tenant_id', ctx.tenantId).eq('id', uuid(b.client_id)).maybeSingle());
    if (!c) fail(404, 'Cliente no encontrado.');
    patch.client_id = c.id;
  }
  let link;
  if (b.payment_link !== undefined) {
    link = s(b.payment_link);
    if (link && !/^https?:\/\//i.test(link)) fail(400, 'El enlace de pago debe empezar con http:// o https://');
    if ((link || null) !== (inv.payment_link || null)) patch.payment_link = link || null;
  }
  const moneyChanged = patch.amount !== undefined || patch.currency !== undefined;
  let note = '';
  if (moneyChanged) {
    if (Array.isArray(inv.items) && inv.items.length) patch.items = null;
    if (inv.paypal_invoice_id) {
      try { await pp.cancelInvoice(inv.paypal_invoice_id); note = ' La factura de PayPal anterior se canceló: genera un enlace nuevo con «Enlace PayPal».'; }
      catch (e) { note = ` No se pudo cancelar la factura de PayPal anterior (${e.message}): cancélala en PayPal para que no se pague el monto viejo.`; }
      Object.assign(patch, { paypal_invoice_id: null, paypal_usd_amount: null, paypal_rate: null, payment_link: patch.payment_link !== undefined ? patch.payment_link : null });
    }
  }
  if (patch.due_date && inv.status === 'overdue' && patch.due_date >= L.todayDO()) patch.status = 'pending';   // si lo mueven al futuro deja de estar vencido
  if (!Object.keys(patch).length) return { invoice: inv, message: 'No hay cambios que guardar.' };
  const updated = await must(supabase.from('cobros_invoices').update(patch).eq('tenant_id', ctx.tenantId).eq('id', inv.id).select('*').single());
  return { invoice: updated, message: 'Cobro actualizado.' + note };
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
  if (inv.plan_id) { try { await onPlanInvoicePaid(inv); } catch (e) { console.error('[cobros-plan] pago', e); } }
  return r.message;
}

// Crea la factura en PayPal y guarda el enlace en el cobro.
async function attachPaypal(inv, client, rate) {
  // RD$: si no se escribió la tasa, se toma la automática (la más alta disponible; ver lib/cobros/fx.js).
  if (inv.currency === 'DOP' && !Number(rate)) rate = (await fx.getRate()).rate;
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

// Cambia cuándo se avisa un cobro: calendario (días exactos + correos por día) o, sin días, el valor por defecto (3 y 1 antes).
async function setRemindDays(ctx, id, b) {
  let dates = null, days = null;
  try { dates = L.parseDates(b.dates, L.todayDO()); if (!dates) days = L.parseSchedule(b.days); } catch (e) { fail(400, e.message); }
  const per = L.parsePerDay(b.per_day);
  await must(supabase.from('cobros_invoices').update({ remind_dates: dates, remind_days: days, remind_per_day: per, remind_overdue: b.overdue !== false }).eq('tenant_id', ctx.tenantId).eq('id', uuid(id)));
  const message = dates ? `Avisos programados: ${dates.length} día(s), ${per} correo(s) por día (${dates.length * per} en total).`
    : days ? `Se avisará ${days.length} vez/veces: ${days.join(', ')} día(s) antes del vencimiento.` : 'Se avisará con los días por defecto (3 y 1 antes).';
  return { remind_dates: dates, remind_days: days, remind_per_day: per, message };
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

// ── Cotizaciones y factura comercial (sin ITBIS, sin NCF) ──────────────────────────────────────────
const FOOTER = 'Documento comercial sin valor fiscal (no incluye NCF).';
const pdfFile = (name, buf) => ({ filename: name, base64: buf.toString('base64') });

// Siguiente número por firma (COT-0001, FAC-0001). El índice único evita duplicados si dos personas guardan a la vez.
async function withSeq(table, col, tenantId, write) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data } = await supabase.from(table).select(col).eq('tenant_id', tenantId).not(col, 'is', null).order(col, { ascending: false }).limit(1);
    const seq = ((data && data[0] && data[0][col]) || 0) + 1;
    const { data: row, error } = await write(seq);
    if (!error) return row;
    if (error.code !== '23505') dbError(error);
  }
  fail(409, 'No se pudo asignar el número del documento. Intenta de nuevo.');
}

async function loadClient(id) {
  const c = await must(supabase.from('cobros_clients').select('*').eq('id', id).maybeSingle());
  if (!c) fail(404, 'No se encontró el cliente.');
  return c;
}

async function listQuotes(ctx) {
  const [quotes, clients] = await Promise.all([
    must(supabase.from('cobros_quotes').select('*').eq('tenant_id', ctx.tenantId).order('seq', { ascending: false }).limit(200)),
    must(supabase.from('cobros_clients').select('id,name').eq('tenant_id', ctx.tenantId).order('name')),
  ]);
  const names = new Map((clients || []).map(c => [c.id, c.name]));
  return { today: L.todayDO(), providers: providers(), clients: clients || [], quotes: (quotes || []).map(q => ({ ...q, number: L.docNumber('COT', q.seq), client_name: names.get(q.client_id) || '—' })) };
}

async function createQuote(ctx, b) {
  const title = s(b.title);
  if (!s(b.client_id) || !title) fail(400, 'Completa cliente y título de la cotización.');
  let items; try { items = L.cleanItems(b.items); } catch (e) { fail(400, e.message); }
  const valid = s(b.valid_until);
  if (valid && !DATE_RE.test(valid)) fail(400, 'La fecha de validez no es correcta.');
  const client = await must(supabase.from('cobros_clients').select('id').eq('tenant_id', ctx.tenantId).eq('id', uuid(b.client_id)).maybeSingle());
  if (!client) fail(404, 'Cliente no encontrado.');
  const q = await withSeq('cobros_quotes', 'seq', ctx.tenantId, seq => supabase.from('cobros_quotes').insert({
    tenant_id: ctx.tenantId, client_id: client.id, seq, title, items, currency: b.currency === 'USD' ? 'USD' : 'DOP',
    total: L.itemsTotal(items), valid_until: valid || null, notes: s(b.notes) || null,
  }).select('*').single());
  return { quote: { ...q, number: L.docNumber('COT', q.seq) }, message: `Cotización ${L.docNumber('COT', q.seq)} creada.` };
}

async function loadQuote(ctx, id) {
  const q = await must(supabase.from('cobros_quotes').select('*').eq('tenant_id', ctx.tenantId).eq('id', uuid(id)).maybeSingle());
  if (!q) fail(404, 'No se encontró la cotización.');
  return q;
}

async function quoteBuffer(q, client) {
  return docs.buildPdf({ kind: 'COTIZACIÓN', number: L.docNumber('COT', q.seq), date: L.todayDO(new Date(q.created_at)),
    extra: q.valid_until ? `Válida hasta: ${docs.fmtDate(q.valid_until)}` : '', validUntil: q.valid_until, client, items: q.items, currency: q.currency,
    total: Number(q.total), notes: q.notes ? String(q.notes).split('\n').map(x => x.trim()).filter(Boolean) : [] });
}

async function quotePdf(ctx, id) {
  const q = await loadQuote(ctx, id);
  return pdfFile(`${L.docNumber('COT', q.seq)}.pdf`, await quoteBuffer(q, await loadClient(q.client_id)));
}

async function sendQuote(ctx, id) {
  const q = await loadQuote(ctx, id), client = await loadClient(q.client_id), number = L.docNumber('COT', q.seq);
  const buf = await quoteBuffer(q, client);
  const body = `Hola ${client.name}, te enviamos la cotización ${number} «${q.title}» por ${L.money(q.total, q.currency)}` +
    `${q.valid_until ? `, válida hasta el ${L.dateDO(q.valid_until)}` : ''}. Adjuntamos el detalle en PDF.\n\nQuedamos atentos a tu respuesta.\n${L.businessName()}`;
  const r = await dispatch({ tenantId: ctx.tenantId, channel: 'email', kind: 'quote', client, subject: `Cotización ${number}: ${q.title}`, body,
    attachments: [{ filename: `${number}.pdf`, content: buf, contentType: 'application/pdf' }] });
  if (!r) return { sent: false, message: 'No se envió: el cliente no tiene correo o no aceptó recibir correos.' };
  if (!r.ok) return { sent: false, message: `No se pudo enviar: ${r.error}. Queda en el historial.` };
  await supabase.from('cobros_quotes').update({ status: q.status === 'draft' ? 'sent' : q.status, sent_at: new Date().toISOString() }).eq('id', q.id);
  return { sent: true, message: `Cotización ${number} enviada a ${client.email}.` };
}

async function setQuoteStatus(ctx, id, b) {
  if (!['accepted', 'rejected', 'sent'].includes(b.status)) fail(400, 'Estado no válido.');
  await loadQuote(ctx, id);
  await must(supabase.from('cobros_quotes').update({ status: b.status }).eq('tenant_id', ctx.tenantId).eq('id', uuid(id)));
  return { message: b.status === 'accepted' ? 'Cotización aceptada.' : b.status === 'rejected' ? 'Cotización rechazada.' : 'Cotización marcada como enviada.' };
}

async function deleteQuote(ctx, id) {
  await must(supabase.from('cobros_quotes').delete().eq('tenant_id', ctx.tenantId).eq('id', uuid(id)));
  return {};
}

// Cotización aceptada → cobro (con las mismas líneas); opcionalmente con enlace de PayPal.
async function convertQuote(ctx, id, b) {
  const q = await loadQuote(ctx, id);
  if (q.invoice_id) fail(400, 'Esa cotización ya se convirtió en cobro.');
  if (!(Number(q.total) > 0)) fail(400, 'La cotización tiene total 0; no se puede cobrar.');
  const due = s(b.due_date);
  if (!DATE_RE.test(due)) fail(400, 'Indica la fecha de vencimiento del cobro.');
  const client = await loadClient(q.client_id);
  let days = null; try { days = b.remind_count ? L.spreadDays(b.remind_count, b.remind_from) : null; } catch (e) { fail(400, e.message); }
  const inv = await must(supabase.from('cobros_invoices').insert({
    tenant_id: ctx.tenantId, client_id: q.client_id, concept: q.title, amount: q.total, currency: q.currency, due_date: due, items: q.items, remind_days: days,
  }).select('*').single());
  await must(supabase.from('cobros_quotes').update({ status: 'accepted', invoice_id: inv.id }).eq('id', q.id));
  let message = `Cotización ${L.docNumber('COT', q.seq)} convertida en cobro.`;
  if (b.paypal === true) {
    try { await attachPaypal(inv, client, b.rate); message += ' Enlace de PayPal generado.'; }
    catch (e) { message += ` No se pudo generar el enlace de PayPal: ${e.message}. Puedes generarlo desde Cobros.`; }
  }
  return { invoice_id: inv.id, message };
}

async function facturaData(ctx, id) {
  let inv = await must(supabase.from('cobros_invoices').select('*').eq('tenant_id', ctx.tenantId).eq('id', uuid(id)).maybeSingle());
  if (!inv) fail(404, 'No se encontró el cobro.');
  if (!inv.factura_seq) {
    inv = await withSeq('cobros_invoices', 'factura_seq', ctx.tenantId, seq => supabase.from('cobros_invoices').update({ factura_seq: seq }).eq('id', inv.id).is('factura_seq', null).select('*').single());
  }
  const client = await loadClient(inv.client_id);
  const items = Array.isArray(inv.items) && inv.items.length ? inv.items : [{ desc: inv.concept, qty: 1, price: Number(inv.amount) }];
  const number = L.docNumber('FAC', inv.factura_seq);
  const paid = inv.status === 'paid';
  const notes = [];
  if (inv.paypal_usd_amount) notes.push(`Cobro por PayPal: ${L.money(inv.paypal_usd_amount, 'USD')}${inv.paypal_rate ? ` a tasa de RD$${Number(inv.paypal_rate).toFixed(2)} por US$` : ''}.`);
  const buf = await docs.buildPdf({ kind: 'FACTURA', number, date: L.todayDO(new Date(inv.created_at)), extra: `Vence: ${docs.fmtDate(inv.due_date)}`, client, items,
    currency: inv.currency, total: Number(inv.amount), notes,
    payment: paid ? { paid: true, method: inv.paypal_invoice_id ? 'PayPal — enlace de pago de la factura' : 'Pago registrado', txId: inv.paypal_invoice_id || '', amountLabel: L.money(inv.amount, inv.currency),
      currency: inv.currency, paidDate: inv.paid_at ? L.todayDO(new Date(inv.paid_at)) : L.todayDO(), ref: `Factura ${number}` }
      : { paid: false, dueDate: inv.due_date, link: inv.payment_link || '' } });
  return { inv, client, number, buf };
}

async function facturaPdf(ctx, id) { const f = await facturaData(ctx, id); return pdfFile(`${f.number}.pdf`, f.buf); }

async function facturar(ctx, id) {
  const { inv, client, number, buf } = await facturaData(ctx, id);
  const link = inv.payment_link && inv.status !== 'paid' ? `\n\nPuedes pagar aquí: ${inv.payment_link}` : '';
  const body = `Hola ${client.name}, te enviamos la factura ${number} por «${inv.concept}» por ${L.money(inv.amount, inv.currency)}` +
    `${inv.status === 'paid' ? ' (pagada)' : `, con vencimiento el ${L.dateDO(inv.due_date)}`}. Adjuntamos el detalle en PDF.${link}\n\nGracias,\n${L.businessName()}`;
  const r = await dispatch({ tenantId: ctx.tenantId, channel: 'email', kind: 'factura', client, subject: `Factura ${number}: ${inv.concept}`, body, invoiceId: inv.id,
    attachments: [{ filename: `${number}.pdf`, content: buf, contentType: 'application/pdf' }] });
  if (!r) return { sent: false, number, message: `Factura ${number} lista, pero no se envió: el cliente no tiene correo o no aceptó recibir correos.` };
  if (!r.ok) return { sent: false, number, message: `Factura ${number}: no se pudo enviar (${r.error}). Queda en el historial.` };
  await supabase.from('cobros_invoices').update({ factura_sent_at: new Date().toISOString() }).eq('id', inv.id);
  return { sent: true, number, message: `Factura ${number} enviada a ${client.email}.` };
}


// ── Planes de cobro recurrente (corte automático) ────────────────────────────────────────────────
const hourDR = ms => Number(new Date(ms).toLocaleString('en-GB', { timeZone: 'America/Santo_Domingo', hour: '2-digit', hour12: false })) % 24;
const GENERATE_FROM_HOUR = 8;      // el cobro se crea «en la mañana» del día de crear: no antes de las 8:00 de RD

async function planEvent(plan, period, kind, detail) {
  try { await supabase.from('cobros_plan_events').insert({ tenant_id: plan.tenant_id, plan_id: plan.id, period: period || null, kind, detail: detail || null }); } catch (_) { /* la bitácora nunca tumba el cobro */ }
}
// Registra el evento solo la primera vez en ese período (evita repetir el mismo aviso en cada corrida del cron).
async function planEventOnce(plan, period, kind, detail) {
  try {
    const { data } = await supabase.from('cobros_plan_events').select('id').eq('plan_id', plan.id).eq('period', period || '').eq('kind', kind).limit(1);
    if (data && data.length) return false;
  } catch (_) { /* si no se puede consultar, se registra */ }
  await planEvent(plan, period || '', kind, detail); return true;
}
// Correo de administración (a plan.notify_email) por la cuenta propia de Cobros.
async function planNotify(plan, subject, text) {
  if (!plan.notify_email) return;
  try { await dispatch({ tenantId: plan.tenant_id, channel: 'email', kind: 'plan', client: { id: null, email: plan.notify_email, phone: null, opt_in_email: true, opt_in_whatsapp: false }, subject, body: text }); } catch (_) { /* sin correo no se detiene el plan */ }
}

// Vuelve a leer las marcas de suspensión del plan (por ejemplo, tras un pago que ya reactivó los accesos).
async function refreshPlan(plan) {
  const { data } = await supabase.from('cobros_plans').select('suspended_direct,suspended_nexo,suspended_at').eq('id', plan.id).maybeSingle();
  if (data) Object.assign(plan, data);
}

async function loadClientSafe(id) {
  const { data } = await supabase.from('cobros_clients').select('*').eq('id', id).maybeSingle();
  return data || null;
}

// Asegura el enlace de pago (reintenta si PayPal falló) y manda el aviso de cobro nuevo una sola vez, cuando ya hay enlace.
async function ensureLinkAndNotice(plan, inv, client, period) {
  if (!inv.payment_link) {
    try { inv = await attachPaypal(inv, client); await planEvent(plan, period, 'link_ready', 'Enlace de pago de PayPal generado.'); }
    catch (e) { await planEventOnce(plan, period, 'link_failed', `No se pudo generar el enlace de PayPal: ${e.message}. No se envía nada al cliente hasta que exista el enlace.`); return inv; }
  }
  if (inv.payment_link && !inv.created_notice_at) {
    const r = await remind({}, inv, client, 'invoice');
    if (r.sent) {
      const upd = { created_notice_at: new Date().toISOString() };
      await supabase.from('cobros_invoices').update(upd).eq('id', inv.id); inv = { ...inv, ...upd };
      await planEvent(plan, period, 'notice_sent', `Cobro enviado a ${client.email || 'el cliente'} con su enlace de pago.`);
      await planNotify(plan, `Cobro del mes creado: ${plan.name}`, `Se creó y envió el cobro de ${L.money(inv.amount, inv.currency)} de ${client.name} (${inv.concept}). Vence el ${L.dateDO(inv.due_date)} a las ${plan.cutoff_time}.\n\nEnlace: ${inv.payment_link}`);
    } else if (r.failed) await planEventOnce(plan, period, 'notice_failed', `No se pudo enviar el correo del cobro: ${r.errors[0] || 'error desconocido'}.`);
    else await planEventOnce(plan, period, 'notice_skipped', 'El cliente no tiene correo o no aceptó recibir correos: el cobro no se envió.');
  }
  return inv;
}

async function generatePlanInvoice(plan, cycle, today, client) {
  const row = {
    tenant_id: plan.tenant_id, client_id: plan.client_id, concept: P.invoiceConcept(plan, cycle), amount: plan.amount, currency: 'USD',
    due_date: cycle.dueDate, remind_dates: P.remindDatesFor(plan, cycle, today), remind_per_day: 1, remind_overdue: true, plan_id: plan.id, period: cycle.period,
  };
  const { data, error } = await supabase.from('cobros_invoices').insert(row).select('*').single();
  if (error) { if (error.code === '23505') return null; dbError(error); }
  await planEvent(plan, cycle.period, 'invoice_created', `Cobro de ${L.money(plan.amount, 'USD')} creado para ${P.periodLabel(cycle.period)}; vence el ${L.dateDO(cycle.dueDate)} a las ${plan.cutoff_time}.`);
  return ensureLinkAndNotice(plan, data, client, cycle.period);
}

async function savePlanFlags(plan) {
  const upd = { suspended_direct: !!plan.suspended_direct, suspended_nexo: !!plan.suspended_nexo, suspended_at: (plan.suspended_direct || plan.suspended_nexo) ? (plan.suspended_at || new Date().toISOString()) : null };
  plan.suspended_at = upd.suspended_at;
  await supabase.from('cobros_plans').update(upd).eq('id', plan.id);
}

// Corte real: suspende Direct y Nexo (lo que esté configurado). Cada destino se intenta por separado y se reintenta en la siguiente corrida.
async function suspendPlan(plan, inv) {
  const done = [], errs = [];
  if (!plan.direct_tenant_id && !plan.nexo_org) { await planEventOnce(plan, inv.period, 'blocked_no_targets', 'Venció sin pagar, pero el plan no tiene firma de Direct ni empresa de Nexo configuradas: no hay nada que suspender.'); return [`Sin destinos configurados (período ${inv.period}).`]; }
  const reason = `Pago de ${P.periodLabel(inv.period)} no recibido al ${L.dateDO(inv.due_date)}`;
  if (plan.direct_tenant_id && !plan.suspended_direct) {
    try { await enforce.setDirect(plan.direct_tenant_id, true); plan.suspended_direct = true; done.push('Direct'); } catch (e) { errs.push(e.message); }
  }
  if (plan.nexo_org && !plan.suspended_nexo) {
    try { await enforce.nexoCall('suspend', plan.nexo_org, { reason, period: inv.period }); plan.suspended_nexo = true; done.push('Nexo'); } catch (e) { errs.push(e.message); }
  }
  await savePlanFlags(plan);
  if (done.length) {
    await planEvent(plan, inv.period, 'suspended', `SUSPENDIDO: ${done.join(' y ')}. ${reason}.`);
    await planNotify(plan, `Acceso suspendido: ${plan.name}`, `Se suspendió ${done.join(' y ')} porque ${reason.charAt(0).toLowerCase()}${reason.slice(1)} (hora de corte ${plan.cutoff_time}).\n\nSe reactiva solo cuando se registre el pago.`);
  }
  if (errs.length) await planEventOnce(plan, inv.period, 'suspend_error', `No se pudo suspender todo: ${errs.join(' · ')}. Se reintenta en la próxima revisión.`);
  return [...done.map(d => `${d} suspendido`), ...errs];
}

async function reactivatePlan(plan, reason) {
  const done = [], errs = [];
  if (plan.suspended_direct && plan.direct_tenant_id) { try { await enforce.setDirect(plan.direct_tenant_id, false); plan.suspended_direct = false; done.push('Direct'); } catch (e) { errs.push(e.message); } }
  else if (plan.suspended_direct) plan.suspended_direct = false;
  if (plan.suspended_nexo && plan.nexo_org) { try { await enforce.nexoCall('reactivate', plan.nexo_org, { reason }); plan.suspended_nexo = false; done.push('Nexo'); } catch (e) { errs.push(e.message); } }
  else if (plan.suspended_nexo) plan.suspended_nexo = false;
  await savePlanFlags(plan);
  if (done.length) { await planEvent(plan, '', 'reactivated', `REACTIVADO: ${done.join(' y ')}. ${reason}.`); await planNotify(plan, `Acceso reactivado: ${plan.name}`, `Se reactivó ${done.join(' y ')}. ${reason}.`); }
  if (errs.length) await planEventOnce(plan, 'reactivar', 'reactivate_error', `No se pudo reactivar todo: ${errs.join(' · ')}. Se reintenta en la próxima revisión; también puedes reactivar a mano.`);
  return [...done.map(d => `${d} reactivado`), ...errs];
}

// Avisa a Nexo de un pago registrado en Cobros, para que su regla antigua (settings.payment_reminder, límite el 15) no suspenda a quien ya pagó.
// Nexo cuenta cada ciclo por el mes en que empieza: el cobro que vence en el período P empezó en P-1. Se reintenta en cada revisión hasta lograrlo.
async function syncNexoPaid(plan, inv) {
  if (!plan.nexo_org || !enforce.nexoConfigured()) return false;
  try { const { data } = await supabase.from('cobros_plan_events').select('id').eq('plan_id', plan.id).eq('period', inv.period).eq('kind', 'nexo_synced').limit(1); if (data && data.length) return true; } catch (_) { /* se intenta igual */ }
  try {
    await enforce.nexoCall('mark_paid', plan.nexo_org, { paid_period: P.addMonths(inv.period, -1), reason: `Pago de ${P.periodLabel(inv.period)} recibido en Cobros` });
    await planEvent(plan, inv.period, 'nexo_synced', 'Nexo avisado del pago (su regla antigua ya no suspende este ciclo).');
    return true;
  } catch (e) { await planEventOnce(plan, inv.period, 'nexo_sync_error', `No se pudo avisar a Nexo del pago (${e.message}). Se reintenta en cada revisión; hasta entonces la regla antigua de Nexo podría suspender por falta de pago.`); return false; }
}

// Al cobrar un cobro del plan (botón, PayPal o cron): se registra y, si ya no queda ningún cobro vencido sin pagar, se reactiva.
async function onPlanInvoicePaid(inv) {
  const { data: plan } = await supabase.from('cobros_plans').select('*').eq('id', inv.plan_id).maybeSingle();
  if (!plan) return;
  if (await planEventOnce(plan, inv.period, 'paid', `Pago recibido: ${L.money(inv.amount, inv.currency)} de ${P.periodLabel(inv.period)}.`)) await planNotify(plan, `Pago recibido: ${plan.name}`, `Se registró el pago de ${L.money(inv.amount, inv.currency)} (${P.periodLabel(inv.period)}).`);
  await syncNexoPaid(plan, inv);
  if (plan.suspended_direct || plan.suspended_nexo) {
    const { data: open } = await supabase.from('cobros_invoices').select('id,due_date,status').eq('plan_id', plan.id).in('status', ['pending', 'overdue']);
    const stillLate = (open || []).filter(i => i.id !== inv.id && P.cutoffState(plan, i, Date.now()) === 'cutoff');
    if (!stillLate.length) await reactivatePlan(plan, 'El pago se registró');
  }
}

// Revisa un plan: crea el cobro del ciclo, asegura el enlace y el aviso, confirma pagos con PayPal y, a la hora de corte, suspende (o simula).
// Seguridad: nunca se corta si PayPal no respondió, si el cobro no tiene enlace de pago o si el plan está pausado.
async function processPlan(plan, nowMs = Date.now()) {
  const acts = [];
  const today = L.todayDO(new Date(nowMs)), cycle = P.cycleFor(plan, today);
  const client = await loadClientSafe(plan.client_id);
  if (!client) { await planEventOnce(plan, cycle.period, 'error', 'El cliente del plan ya no existe.'); return { actions: ['El cliente del plan ya no existe.'] }; }
  let invs = (await must(supabase.from('cobros_invoices').select('*').eq('plan_id', plan.id).order('due_date'))) || [];
  let cur = invs.find(i => i.period === cycle.period) || null;
  if (!cur && P.shouldGenerate(plan, today, cycle, false) && hourDR(nowMs) >= GENERATE_FROM_HOUR) {
    cur = await generatePlanInvoice(plan, cycle, today, client);
    if (cur) { invs.push(cur); acts.push(`Cobro de ${P.periodLabel(cycle.period)} creado${cur.payment_link ? ' con su enlace' : ' (sin enlace todavía)'}.`); }
  } else if (cur && cur.status !== 'paid' && cur.status !== 'cancelled') {
    const before = cur.payment_link, beforeN = cur.created_notice_at;
    const upd = await ensureLinkAndNotice(plan, cur, client, cycle.period);
    invs = invs.map(i => (i.id === upd.id ? upd : i));
    if (!before && upd.payment_link) acts.push('Enlace de pago generado.');
    if (!beforeN && upd.created_notice_at) acts.push('Cobro enviado al cliente.');
  }
  // Detecta el pago del cobro abierto en cada revisión (el cron «watch» corre cada 15 min), no solo a la hora de corte.
  // Si PayPal no responde aquí no pasa nada: a la hora de corte se vuelve a confirmar y, si sigue sin responder, no se corta.
  if (require('../paypal').hasCredentials()) {
    for (const inv of invs.filter(i => i.status !== 'paid' && i.status !== 'cancelled' && i.paypal_invoice_id)) {
      try { if ((await pp.invoiceState(inv.paypal_invoice_id)) === 'paid') { await settle(inv, client); inv.status = 'paid'; await refreshPlan(plan); acts.push(`Pago de ${P.periodLabel(inv.period)} detectado.`); } } catch (_) { /* se reintenta */ }
    }
  }
  // Los últimos pagos del plan se le avisan a Nexo (reintenta si falló)
  for (const pi of invs.filter(i => i.status === 'paid').slice(-2)) await syncNexoPaid(plan, pi);
  // Vencidos sin pagar a partir de su hora de corte
  const overdue = () => invs.filter(i => i.status !== 'paid' && i.status !== 'cancelled' && P.cutoffState(plan, i, nowMs) === 'cutoff');
  let due = overdue();
  if (!due.length) {
    if (plan.suspended_direct || plan.suspended_nexo) acts.push(...await reactivatePlan(plan, 'No quedan cobros vencidos sin pagar'));
    return { actions: acts };
  }
  // Última confirmación con PayPal antes de cortar. Si no responde, NO se corta.
  if (require('../paypal').hasCredentials()) {
    for (const inv of due.filter(i => i.paypal_invoice_id)) {
      try { if ((await pp.invoiceState(inv.paypal_invoice_id)) === 'paid') { await settle(inv, client); inv.status = 'paid'; await refreshPlan(plan); acts.push(`Pago de ${inv.period} confirmado por PayPal.`); } }
      catch (e) { await planEventOnce(plan, inv.period, 'paypal_unreachable', `No se pudo confirmar el pago con PayPal (${e.message}). Por seguridad no se suspende; se reintenta en la próxima revisión.`); acts.push('PayPal no respondió: no se corta.'); return { actions: acts }; }
    }
  }
  due = overdue();
  if (!due.length) {
    if (plan.suspended_direct || plan.suspended_nexo) acts.push(...await reactivatePlan(plan, 'Pago confirmado'));
    return { actions: acts };
  }
  const inv = due[0];
  if (!inv.payment_link) { await planEventOnce(plan, inv.period, 'blocked_no_link', 'Venció sin pagar, pero el cobro no tiene enlace de pago (el cliente no pudo pagar): no se suspende.'); acts.push('Sin enlace de pago: no se corta.'); return { actions: acts }; }
  const targets = [plan.direct_tenant_id ? 'Direct' : null, plan.nexo_org ? `Nexo (${plan.nexo_org})` : null].filter(Boolean).join(' y ') || 'nada (sin destinos configurados)';
  if (plan.mode !== 'live') {
    const first = await planEventOnce(plan, inv.period, 'simulated_suspend', `SIMULACIÓN: no se pagó ${P.periodLabel(inv.period)} al ${L.dateDO(inv.due_date)} ${plan.cutoff_time}; en modo real se habría suspendido ${targets}.`);
    if (first) await planNotify(plan, `SIMULACIÓN de corte: ${plan.name}`, `Esto fue una simulación: el cobro de ${P.periodLabel(inv.period)} no se pagó al ${L.dateDO(inv.due_date)} a las ${plan.cutoff_time}.\nEn modo real se habría suspendido: ${targets}.\n\nNo se suspendió nada.`);
    acts.push(`Simulación: se habría suspendido ${targets}.`);
    return { actions: acts };
  }
  acts.push(...await suspendPlan(plan, inv));
  return { actions: acts };
}

async function runPlans(nowMs = Date.now()) {
  const plans = (await must(supabase.from('cobros_plans').select('*').eq('active', true))) || [];
  const out = { plans: plans.length, actions: [] };
  for (const plan of plans) {
    try { const r = await processPlan(plan, nowMs); out.actions.push(...r.actions.map(a => `${plan.name}: ${a}`)); }
    catch (e) {
      console.error('[cobros-plan]', plan.id, e);
      try { const { data } = await supabase.from('cobros_plan_events').select('detail').eq('plan_id', plan.id).eq('kind', 'error').order('created_at', { ascending: false }).limit(1); if (!(data && data[0] && data[0].detail === e.message)) await planEvent(plan, '', 'error', String(e.message || e).slice(0, 300)); } catch (_) { /* nada */ }
    }
  }
  return out;
}

// Solo los planes (para las corridas frecuentes del cron: «watch» cada 15 min y «cutoff» a la hora de corte).
async function runPlansOnly() { return { today: L.todayDO(), plans: await runPlans() }; }

// ── Pantalla y acciones de los planes ───────────────────────────────────────────────────────────
async function requireAdmin(ctx) {
  if (!(await isPlatformAdmin(ctx.userId))) fail(403, 'Solo el administrador de la plataforma (root) puede crear o cambiar planes de cobro recurrente.');
}
async function loadPlan(ctx, id) {
  const plan = await must(supabase.from('cobros_plans').select('*').eq('tenant_id', ctx.tenantId).eq('id', uuid(id)).maybeSingle());
  if (!plan) fail(404, 'No se encontró el plan.');
  return plan;
}

async function listPlans(ctx) {
  const admin = await isPlatformAdmin(ctx.userId);
  const [plans, clients, tenants] = await Promise.all([
    must(supabase.from('cobros_plans').select('*').eq('tenant_id', ctx.tenantId).order('created_at')),
    must(supabase.from('cobros_clients').select('id,name,email').eq('tenant_id', ctx.tenantId).order('name')),
    must(admin ? supabase.from('direct_tenants').select('id,name').order('name') : supabase.from('direct_tenants').select('id,name').eq('id', ctx.tenantId)),
  ]);
  const names = new Map((clients || []).map(c => [c.id, c.name]));
  const now = Date.now();
  const out = [];
  for (const p of plans || []) {
    const cycle = P.cycleFor(p, L.todayDO());
    const [inv, events] = await Promise.all([
      must(supabase.from('cobros_invoices').select('id,status,payment_link,due_date,amount,currency,created_notice_at,paid_at').eq('plan_id', p.id).eq('period', cycle.period).maybeSingle()),
      must(supabase.from('cobros_plan_events').select('kind,period,detail,created_at').eq('plan_id', p.id).order('created_at', { ascending: false }).limit(12)),
    ]);
    out.push({ ...p, client_name: names.get(p.client_id) || '—', cycle, cutoff_at: new Date(P.cutoffAtMs(cycle.dueDate, p.cutoff_time)).toISOString(), invoice: inv || null, events: events || [], suspended: !!(p.suspended_direct || p.suspended_nexo), now: new Date(now).toISOString() });
  }
  return { plans: out, clients: clients || [], tenants: tenants || [], is_admin: admin, nexo_configured: enforce.nexoConfigured(), me_tenant: ctx.tenantId, defaults: { amount: 210, create_day: 25, due_day: 5, cutoff_time: '11:55', remind_offsets: '5, 3, 1, 0', nexo_org: 'Save Consultores' } };
}

async function createPlan(ctx, b) {
  await requireAdmin(ctx);
  let f; try { f = P.cleanPlan(b); } catch (e) { fail(400, e.message); }
  const client = await must(supabase.from('cobros_clients').select('id').eq('tenant_id', ctx.tenantId).eq('id', uuid(b.client_id)).maybeSingle());
  if (!client) fail(400, 'Elige el cliente que paga este plan.');
  let direct = null;
  if (b.direct_tenant_id) { const t = await must(supabase.from('direct_tenants').select('id').eq('id', uuid(b.direct_tenant_id)).maybeSingle()); if (!t) fail(400, 'La firma de Direct no existe.'); direct = t.id; }
  let nf = {}; try { nf = P.cleanPlan({ notify_email: b.notify_email, nexo_org: b.nexo_org }, { requireAll: false }); } catch (e) { fail(400, e.message); }
  const plan = await must(supabase.from('cobros_plans').insert({ ...f, ...nf, tenant_id: ctx.tenantId, client_id: client.id, currency: 'USD', direct_tenant_id: direct, mode: 'simulation', active: true }).select('*').single());
  await planEvent(plan, '', 'plan_created', 'Plan creado en modo SIMULACIÓN: no suspende nada, solo registra lo que haría.');
  return { plan, message: 'Plan creado en modo simulación.' };
}

async function updatePlan(ctx, id, b) {
  await requireAdmin(ctx);
  const plan = await loadPlan(ctx, id);
  let f; try { f = P.cleanPlan(b, { requireAll: false }); } catch (e) { fail(400, e.message); }
  if (b.client_id !== undefined && s(b.client_id) && s(b.client_id) !== plan.client_id) {
    const c = await must(supabase.from('cobros_clients').select('id').eq('tenant_id', ctx.tenantId).eq('id', uuid(b.client_id)).maybeSingle());
    if (!c) fail(400, 'Cliente no encontrado.'); f.client_id = c.id;
  }
  if (b.direct_tenant_id !== undefined) {
    if (b.direct_tenant_id) { const t = await must(supabase.from('direct_tenants').select('id').eq('id', uuid(b.direct_tenant_id)).maybeSingle()); if (!t) fail(400, 'La firma de Direct no existe.'); f.direct_tenant_id = t.id; }
    else f.direct_tenant_id = null;
  }
  if (!Object.keys(f).length) return { plan, message: 'No hay cambios que guardar.' };
  const updated = await must(supabase.from('cobros_plans').update(f).eq('tenant_id', ctx.tenantId).eq('id', plan.id).select('*').single());
  await planEvent(plan, '', 'plan_updated', `Plan editado: ${Object.keys(f).join(', ')}.`);
  return { plan: updated, message: 'Plan actualizado. Los cambios aplican al próximo ciclo; el cobro ya creado no cambia.' };
}

async function setPlanActive(ctx, id, b) {
  await requireAdmin(ctx);
  const plan = await loadPlan(ctx, id);
  const active = b.active === true;
  await must(supabase.from('cobros_plans').update({ active }).eq('id', plan.id));
  await planEvent(plan, '', active ? 'plan_resumed' : 'plan_paused', active ? 'Plan activado.' : 'Plan pausado: no crea cobros ni corta mientras esté pausado.');
  return { message: active ? 'Plan activado.' : 'Plan pausado. No crea cobros ni corta mientras esté pausado.' };
}

// Pasar a modo real exige confirmar escribiendo SUSPENDER y que todo esté configurado; volver a simulación es libre.
async function setPlanMode(ctx, id, b) {
  await requireAdmin(ctx);
  const plan = await loadPlan(ctx, id);
  if (b.mode === 'simulation') { await must(supabase.from('cobros_plans').update({ mode: 'simulation' }).eq('id', plan.id)); await planEvent(plan, '', 'mode_simulation', 'Modo SIMULACIÓN: no se suspende nada.'); return { message: 'Plan en modo simulación.' }; }
  if (b.mode !== 'live') fail(400, 'Modo no válido.');
  if (String(b.confirm || '').trim().toUpperCase() !== 'SUSPENDER') fail(400, 'Para pasar a modo real escribe SUSPENDER en la confirmación.');
  if (!plan.notify_email) fail(400, 'Antes del modo real configura un correo para los avisos de administración (así te enteras de cada corte).');
  if (!plan.direct_tenant_id && !plan.nexo_org) fail(400, 'Antes del modo real elige la firma de Direct y/o la empresa de Nexo que se suspende.');
  if (plan.nexo_org && !enforce.nexoConfigured()) fail(400, 'El plan suspende Nexo, pero falta la variable NEXO_COBROS_SECRET (y la función en Nexo). Configúrala primero o quita la empresa de Nexo del plan.');
  if (plan.nexo_org) { try { await enforce.nexoCall('status', plan.nexo_org); } catch (e) { fail(400, `No se pudo comprobar la conexión con Nexo: ${e.message}`); } }
  await must(supabase.from('cobros_plans').update({ mode: 'live' }).eq('id', plan.id));
  await planEvent(plan, '', 'mode_live', 'Modo REAL: si no se paga a la hora de corte, se suspende.');
  return { message: 'Plan en MODO REAL: si el cobro no se paga a la hora de corte, se suspenderá el acceso.' };
}

async function runPlanNow(ctx, id) {
  await requireAdmin(ctx);
  const plan = await loadPlan(ctx, id);
  const r = await processPlan(plan);
  return { actions: r.actions, message: r.actions.length ? r.actions.join(' · ') : 'Revisado: no hay nada que hacer ahora.' };
}

async function generatePlanNow(ctx, id) {
  await requireAdmin(ctx);
  const plan = await loadPlan(ctx, id);
  const today = L.todayDO(), cycle = P.cycleFor(plan, today);
  if (today > cycle.dueDate) fail(400, `El plazo de este ciclo ya pasó (${L.dateDO(cycle.dueDate)}). El próximo cobro se crea solo el día ${plan.create_day}.`);
  const client = await loadClientSafe(plan.client_id); if (!client) fail(400, 'El cliente del plan ya no existe.');
  const ex = await must(supabase.from('cobros_invoices').select('id').eq('plan_id', plan.id).eq('period', cycle.period).maybeSingle());
  if (ex) fail(400, 'El cobro de este ciclo ya existe.');
  const inv = await generatePlanInvoice(plan, { ...cycle, createDate: today < cycle.createDate ? today : cycle.createDate }, today, client);
  return { invoice_id: inv && inv.id, message: `Cobro de ${P.periodLabel(cycle.period)} creado${inv && inv.payment_link ? ' con su enlace de PayPal y enviado al cliente' : ' pero SIN enlace de PayPal todavía (revisa el historial del plan)'}.` };
}

async function reactivatePlanNow(ctx, id) {
  await requireAdmin(ctx);
  const plan = await loadPlan(ctx, id);
  const r = await reactivatePlan(plan, 'Reactivación manual');
  return { message: r.length ? r.join(' · ') : 'El plan no tenía nada suspendido.' };
}

async function deletePlan(ctx, id) {
  await requireAdmin(ctx);
  const plan = await loadPlan(ctx, id);
  if (plan.suspended_direct || plan.suspended_nexo) fail(400, 'El plan tiene accesos suspendidos: reactívalos antes de borrarlo.');
  await must(supabase.from('cobros_plans').delete().eq('id', plan.id));
  return { message: 'Plan eliminado. Los cobros que ya creó se conservan.' };
}

// Tasa automática para precargar el formulario.
async function fxRate() {
  try { return { ...(await fx.getRate()), ok: true }; } catch (e) { return { rate: null, message: e.message }; }
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
  const auto = b.auto === true;     // asunto y mensaje automáticos (solo correo): se generan por destinatario
  if (!name || !['email', 'whatsapp', 'both'].includes(channel) || (!auto && !body)) fail(400, auto ? 'Ponle un nombre a la campaña.' : 'Completa nombre, canal y mensaje.');
  if (auto && channel !== 'email') fail(400, 'El mensaje automático es solo para correo.');
  if (!auto && channel !== 'whatsapp' && !subject) fail(400, 'El asunto es obligatorio para correo.');
  if (b.confirm !== true) fail(400, 'Confirma que los destinatarios pueden recibir tu mensaje y que incluye la baja.');
  const isList = b.audience === 'list';
  if (isList && channel !== 'email') fail(400, 'Una lista de correos solo admite el canal Correo.');

  let clients, truncated, skipped = { invalid: 0, duplicates: 0, optout: 0 };
  if (isList) {
    // Lista pegada o subida (prospectos): se limpia, se quitan las bajas y a quien ya pidió no recibir correos.
    const norm = L.normalizeRecipients(b.emails);
    skipped.invalid = norm.invalid; skipped.duplicates = norm.duplicates;
    if (!norm.valid.length) fail(400, 'No encontré correos válidos en la lista.');
    const emails = norm.valid.map(r => r.email);
    const [outs, known] = await Promise.all([
      must(supabase.from('cobros_optouts').select('email').eq('tenant_id', ctx.tenantId).in('email', emails)),
      must(supabase.from('cobros_clients').select('email,opt_in_email').eq('tenant_id', ctx.tenantId).in('email', emails)),
    ]);
    const blocked = new Set([...(outs || []).map(o => o.email), ...(known || []).filter(c => c.opt_in_email === false).map(c => String(c.email).toLowerCase())]);
    const allowed = norm.valid.filter(r => !blocked.has(r.email));
    skipped.optout = norm.valid.length - allowed.length;
    truncated = allowed.length > MAX_RECIPIENTS;
    clients = allowed.slice(0, MAX_RECIPIENTS).map(r => ({ id: null, name: r.name, company: '', email: r.email, phone: null, opt_in_email: true, opt_in_whatsapp: false }));
    if (!clients.length) fail(400, 'Todos los correos de la lista están en la lista de bajas o ya pidieron no recibir correos.');
  } else {
    let q = supabase.from('cobros_clients').select('*').eq('tenant_id', ctx.tenantId);
    if (tag) q = q.contains('tags', [tag]);
    clients = await must(q.limit(MAX_RECIPIENTS + 1)) || [];
    truncated = clients.length > MAX_RECIPIENTS;
    clients = clients.slice(0, MAX_RECIPIENTS);
  }

  const camp = await must(supabase.from('cobros_campaigns').insert({
    tenant_id: ctx.tenantId, name, channel, subject: auto ? '(automático)' : (subject || null), body: auto ? 'Presentación automática de servicios: el asunto y el mensaje se generan para cada destinatario.' : body, audience_tag: isList ? '(lista de correos)' : (tag || null), status: 'sending',
  }).select('id').single());

  const channels = channel === 'both' ? ['email', 'whatsapp'] : [channel];
  let sent = 0, failed = 0;
  for (let i = 0; i < clients.length; i += CONCURRENCY) {
    await Promise.all(clients.slice(i, i + CONCURRENCY).map(async c => {
      for (const ch of channels) {
        // dispatch respeta opt_in_*: devuelve null (sin enviar) si no lo aceptó
        // Correo: enlace de baja firmado + cabeceras de baja de un clic. WhatsApp: aviso para responder BAJA.
        const msg = auto ? L.autoPromo(c) : { subject: L.fillVars(subject, c), body: L.fillVars(body, c) };
        let text = msg.body + L.UNSUBSCRIBE_FOOTER, headers;
        if (ch === 'email' && c.email) {
          const token = unsub.sign(ctx.tenantId, c.email);
          text = msg.body + L.unsubscribeFooter(unsub.pageLink(token)); headers = unsub.headers(token);
        }
        const r = await dispatch({ tenantId: ctx.tenantId, channel: ch, kind: 'promo', client: c, subject: msg.subject, body: text, campaignId: camp.id, headers });
        if (r && r.ok) sent++; else if (r) failed++;
      }
    }));
  }
  await supabase.from('cobros_campaigns').update({ status: 'sent', sent_count: sent, failed_count: failed }).eq('id', camp.id);
  const extra = isList ? ` Descartados: ${skipped.invalid} inválidos, ${skipped.duplicates} repetidos, ${skipped.optout} en bajas.` : '';
  return { sent, failed, truncated, max: MAX_RECIPIENTS, skipped,
    message: `Campaña procesada: ${sent} enviados, ${failed} fallidos.${extra}${truncated ? ` Se limitó a ${MAX_RECIPIENTS} destinatarios; envía el resto en otra campaña.` : ''}` };
}

// Bajas: correos que no deben recibir promociones (responden BAJA o lo piden).
// Vista previa del mensaje automático para un destinatario de ejemplo (la misma función que usa el envío).
async function previewCampaign(ctx, b) {
  const m = L.autoPromo({ name: s(b.name), email: s(b.email) });
  return { subject: m.subject, body: m.body + L.unsubscribeFooter('(aquí va el enlace para darse de baja de esa persona)'), variant: m.variant };
}

async function listOptouts(ctx) {
  const rows = await must(supabase.from('cobros_optouts').select('email,created_at').eq('tenant_id', ctx.tenantId).order('created_at', { ascending: false }).limit(500));
  return { optouts: rows || [] };
}

async function addOptouts(ctx, b) {
  const text = Array.isArray(b.emails) ? b.emails.join('\n') : String(b.emails || '');
  const found = (text.match(/[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']{2,}/g) || []).map(e => e.toLowerCase());
  const emails = [...new Set(found)].slice(0, 2000);
  if (!emails.length) fail(400, 'No encontré correos en el texto.');
  await must(supabase.from('cobros_optouts').upsert(emails.map(email => ({ tenant_id: ctx.tenantId, email })), { onConflict: 'tenant_id,email', ignoreDuplicates: true }));
  // Si es un cliente, también se apaga su consentimiento de correo.
  await supabase.from('cobros_clients').update({ opt_in_email: false }).eq('tenant_id', ctx.tenantId).in('email', emails);
  return { added: emails.length, message: `${emails.length} correo(s) agregados a la lista de bajas.` };
}

async function removeOptout(ctx, b) {
  await must(supabase.from('cobros_optouts').delete().eq('tenant_id', ctx.tenantId).eq('email', s(b.email).toLowerCase()));
  return {};
}

// ── Baja pública (sin sesión): la persona llega desde el enlace del correo ─────────────────────────────
// GET  → datos para mostrar la confirmación (correo enmascarado y negocio).
// POST → registra la baja. Es POST a propósito: los filtros de correo abren los enlaces y no deben dar de baja a nadie;
//        también es el formato del «clic» de Gmail/Outlook (List-Unsubscribe-Post).
async function unsubscribeInfo(token) {
  const v = unsub.verify(token);
  if (!v) fail(400, 'El enlace de baja no es válido.');
  return { email: unsub.maskEmail(v.email), business: L.businessName() };
}

async function unsubscribeDo(token) {
  const v = unsub.verify(token);
  if (!v) fail(400, 'El enlace de baja no es válido.');
  await must(supabase.from('cobros_optouts').upsert([{ tenant_id: v.tenantId, email: v.email }], { onConflict: 'tenant_id,email', ignoreDuplicates: true }));
  await supabase.from('cobros_clients').update({ opt_in_email: false }).eq('tenant_id', v.tenantId).eq('email', v.email);
  return { email: unsub.maskEmail(v.email), business: L.businessName(), message: 'Listo: no recibirás más promociones.' };
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
async function runDaily({ slot = 1 } = {}) {
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
  let plansResult = { plans: 0, actions: [] };
  try { plansResult = await runPlans(); } catch (e) { console.error('[cobros-plan]', e); }
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
    if (!client || !L.shouldRemindToday(inv, today, slot)) continue;
    if (inv.plan_id && !inv.payment_link) continue;           // sin enlace el cliente no puede pagar: no se le recuerda nada
    const r = await remind({}, inv, client);
    if (r.skipped) skipped++; else if (r.sent) reminded++; else failed++;
  }
  return { today, slot, markedOverdue: (marked || []).length, paidByPaypal, receipts, reminded, failed, skipped, plans: plansResult };
}

module.exports = { me, dashboard, listClients, createClient, deleteClient, optOut, listInvoices, createInvoice, updateInvoice, remindInvoice, setRemindDays, fxRate, listPlans, createPlan, updatePlan, setPlanActive, setPlanMode, runPlanNow, generatePlanNow, reactivatePlanNow, deletePlan, runPlans, runPlansOnly, processPlan, listQuotes, createQuote, sendQuote, setQuoteStatus, deleteQuote, convertQuote, quotePdf, facturar, facturaPdf, paypalLink, checkPaypal, markPaid, listCampaigns, sendCampaign, previewCampaign, unsubscribeInfo, unsubscribeDo, listOptouts, addOptouts, removeOptout, listLog, runDaily };
