// Lógica pura del módulo Cobros (sin base de datos ni red): se prueba aparte.
const TZ = 'America/Santo_Domingo';

const todayDO = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const parseTags = raw => [...new Set(String(raw || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean))];

const money = (amount, currency) =>
  new Intl.NumberFormat('es-DO', { style: 'currency', currency: currency === 'USD' ? 'USD' : 'DOP' }).format(Number(amount) || 0);
const dateDO = iso => iso ? new Intl.DateTimeFormat('es-DO', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(String(iso).slice(0, 10) + 'T12:00:00Z')) : '—';

const businessName = () => process.env.BUSINESS_NAME || 'CaSa Labs';

function fillVars(text, client) {
  return String(text || '')
    .replace(/\{\{\s*nombre\s*\}\}/gi, client.name || '')
    .replace(/\{\{\s*empresa\s*\}\}/gi, client.company || '')
    .replace(/\{\{\s*negocio\s*\}\}/gi, businessName())
    .replace(/[ \t]+([,.!:;])/g, '$1').replace(/[ \t]{2,}/g, ' ');
}

const unsubscribeFooter = link => `\n\n—\nSi no deseas recibir más correos de ${businessName()}, puedes darte de baja aquí: ${link}`;
const UNSUBSCRIBE_FOOTER = '\n\nSi no deseas recibir más promociones, responde BAJA y te quitaremos de la lista.';

function reminderMessage(inv, client, daysToDue) {
  const when = daysToDue > 1 ? `vence en ${daysToDue} días (${dateDO(inv.due_date)})`
    : daysToDue === 1 ? `vence mañana (${dateDO(inv.due_date)})`
    : daysToDue === 0 ? `vence hoy (${dateDO(inv.due_date)})`
    : `venció el ${dateDO(inv.due_date)} y tiene ${Math.abs(daysToDue)} día(s) de atraso`;
  const subject = daysToDue < 0 ? `Pago vencido: ${inv.concept}` : `Recordatorio de pago: ${inv.concept}`;
  const link = inv.payment_link ? `\n\nPuedes pagar aquí: ${inv.payment_link}` : '';
  const body = `Hola ${client.name}, te recordamos que el cobro «${inv.concept}» por ${money(inv.amount, inv.currency)} ${when}.${link}\n\nGracias,\n${businessName()}`;
  return { subject, body };
}

// Comprobante de pago que se envía al cobrar (no es un comprobante fiscal con NCF).
function receiptNumber(inv) { return 'REC-' + String(inv.id || '').replace(/-/g, '').slice(0, 8).toUpperCase(); }
function receiptMessage(inv, client) {
  const paid = inv.paid_at ? new Intl.DateTimeFormat('es-DO', { dateStyle: 'long', timeZone: TZ }).format(new Date(inv.paid_at)) : dateDO(todayDO());
  const usd = inv.paypal_usd_amount ? `\nCobrado por PayPal: ${money(inv.paypal_usd_amount, 'USD')}${inv.paypal_rate ? ` (tasa ${Number(inv.paypal_rate).toFixed(2)} RD$ por US$)` : ''}` : '';
  const subject = `Comprobante de pago ${receiptNumber(inv)}: ${inv.concept}`;
  const body = `Hola ${client.name}, hemos recibido tu pago. ¡Gracias!\n\nComprobante: ${receiptNumber(inv)}\nConcepto: ${inv.concept}\nMonto: ${money(inv.amount, inv.currency)}\nFecha de pago: ${paid}${usd}` +
    `\n\nEste comprobante confirma tu pago y no sustituye un comprobante fiscal (NCF).\n\n${businessName()}`;
  return { subject, body };
}

// Líneas de cotización/factura (sin ITBIS: este sistema no lo maneja). Devuelve líneas limpias o lanza Error.
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
function cleanItems(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const items = list.map(i => ({ desc: String(i && i.desc || '').trim().slice(0, 200), detail: String(i && i.detail || '').trim().slice(0, 300), qty: Number(i && i.qty), price: Number(i && i.price) }))
    .filter(i => i.desc || i.qty || i.price);
  if (!items.length) throw new Error('Agrega al menos una línea con descripción, cantidad y precio.');
  if (items.length > 40) throw new Error('Máximo 40 líneas.');
  for (const i of items) {
    if (!i.desc) throw new Error('Cada línea necesita una descripción.');
    if (!(i.qty > 0) || i.qty > 100000) throw new Error('La cantidad de cada línea debe ser mayor que 0.');
    if (!(i.price >= 0) || i.price > 1e9) throw new Error('El precio de cada línea no puede ser negativo.');
    i.qty = Math.round(i.qty * 10000) / 10000; i.price = round2(i.price);
  }
  return items;
}
const lineTotal = i => round2(i.qty * i.price);
const itemsTotal = items => round2(items.reduce((a, i) => a + lineTotal(i), 0));
const docNumber = (prefix, seq) => `${prefix}-${String(seq).padStart(4, '0')}`;

// Lista de correos pegada o subida: [{email, name}] → únicos, válidos y en minúsculas. Cuenta lo descartado.
const EMAIL_RE = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]{2,}$/;
function normalizeRecipients(list) {
  const seen = new Set(); const valid = []; let invalid = 0, duplicates = 0;
  for (const r of Array.isArray(list) ? list : []) {
    const email = String(r && r.email || '').trim().toLowerCase().replace(/^mailto:/, '');
    if (!email) continue;
    if (!EMAIL_RE.test(email) || email.length > 160) { invalid++; continue; }
    if (seen.has(email)) { duplicates++; continue; }
    seen.add(email); valid.push({ email, name: String(r.name || '').trim().slice(0, 120) });
  }
  return { valid, invalid, duplicates };
}

const DEFAULT_REMIND_DAYS = [3, 1];

// «7, 3, 1» → [7,3,1] (únicos, de mayor a menor). Vacío → null (usa los días por defecto). Inválido → lanza Error.
function parseDays(raw) {
  const text = Array.isArray(raw) ? raw.join(',') : String(raw == null ? '' : raw);
  if (!text.trim()) return null;
  const parts = text.split(/[,\s;]+/).filter(Boolean);
  const nums = parts.map(Number);
  if (nums.some(n => !Number.isInteger(n) || n < 1 || n > 60)) throw new Error('Los días de aviso deben ser números enteros entre 1 y 60, separados por coma (ej. 7, 3, 1).');
  const days = [...new Set(nums)].sort((a, b) => b - a);
  if (days.length > 6) throw new Error('Máximo 6 días de aviso por cobro.');
  return days;
}

// «3 avisos desde 9 días antes» → [9,5,1]: reparte N avisos entre «desde» y 1 día antes.
function spreadDays(count, from) {
  const f = Math.min(60, Math.max(1, Math.round(Number(from)) || 3));
  const n = Math.min(6, f, Math.max(1, Math.round(Number(count)) || 2));
  if (n === 1) return [f];
  return Array.from({ length: n }, (_, i) => Math.round(f - i * (f - 1) / (n - 1)));
}

// Acepta una lista («9, 5, 1») o «N desde D» («3 desde 9»). Vacío → null.
function parseSchedule(raw) {
  const t = String(raw == null ? '' : raw).trim();
  const m = /^(\d+)\s*(?:veces|avisos|x)?\s*desde\s*(\d+)(?:\s*d[ií]as?)?$/i.exec(t);
  if (m) {
    const n = Number(m[1]), d = Number(m[2]);
    if (n < 1 || n > 6 || d < 1 || d > 60) throw new Error('Usa de 1 a 6 avisos y de 1 a 60 días (ej. «3 desde 9»).');
    return spreadDays(n, d);
  }
  return parseDays(t);
}

// Antes del vencimiento: los días elegidos en el cobro (por defecto 3 y 1). El día del vencimiento siempre avisa,
// y en mora cada 3 días. Máximo un aviso por día.
function shouldRemindToday(inv, today) {
  if (inv.last_reminder_at && todayDO(new Date(inv.last_reminder_at)) === today) return false;
  const d = daysBetween(today, inv.due_date);
  if (d === 0) return true;
  if (d < 0) return Math.abs(d) % 3 === 0;
  const days = Array.isArray(inv.remind_days) && inv.remind_days.length ? inv.remind_days : DEFAULT_REMIND_DAYS;
  return days.includes(d);
}

// Totales por moneda: nunca se suman RD$ con US$.
function totals(invoices, today) {
  const t = { DOP: { receivable: 0, overdue: 0, paid: 0 }, USD: { receivable: 0, overdue: 0, paid: 0 } };
  const monthStart = today.slice(0, 8) + '01';
  for (const i of invoices) {
    const c = t[i.currency] || t.DOP; const a = Number(i.amount) || 0;
    if (i.status === 'pending' || i.status === 'overdue') {
      c.receivable += a;
      if (i.status === 'overdue' || i.due_date < today) c.overdue += a;
    } else if (i.status === 'paid' && i.paid_at && todayDO(new Date(i.paid_at)) >= monthStart) c.paid += a;
  }
  for (const k of Object.keys(t)) for (const f of Object.keys(t[k])) t[k][f] = Math.round(t[k][f] * 100) / 100;
  return t;
}

module.exports = { todayDO, daysBetween, parseTags, money, dateDO, fillVars, UNSUBSCRIBE_FOOTER, unsubscribeFooter, reminderMessage, receiptMessage, receiptNumber, shouldRemindToday, parseDays, normalizeRecipients, cleanItems, lineTotal, itemsTotal, docNumber, round2, spreadDays, parseSchedule, DEFAULT_REMIND_DAYS, totals, businessName };
