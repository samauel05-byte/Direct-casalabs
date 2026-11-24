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

// Los correos suben de tono según cuántos recordatorios ya se enviaron de ese cobro (stage = reminder_count):
//   0 → «Se acerca tu fecha de pago»   1 → «Recordatorio»   2 o más → «Aviso importante»
// y siempre mandan «Hoy vence» el día del vencimiento y «Pago vencido» si ya pasó. stage -1 = aviso de cobro nuevo.
function reminderMessage(inv, client, daysToDue, stage) {
  if (stage === undefined) stage = Number(inv.reminder_count) || 0;
  const due = dateDO(inv.due_date), amount = money(inv.amount, inv.currency), c = inv.concept;
  const when = daysToDue > 1 ? `vence en ${daysToDue} días (${due})`
    : daysToDue === 1 ? `vence mañana (${due})`
    : daysToDue === 0 ? `vence hoy (${due})`
    : `venció el ${due} y tiene ${Math.abs(daysToDue)} día(s) de atraso`;
  let subject, intro;
  if (daysToDue < 0) { subject = `Pago vencido: ${c}`; intro = `te recordamos que el cobro «${c}» por ${amount} ${when}`; }
  else if (daysToDue === 0) { subject = `Hoy vence tu pago: ${c}`; intro = `hoy vence el cobro «${c}» por ${amount}`; }
  else if (stage < 0) { subject = `Nuevo cobro: ${c}`; intro = `te informamos que tienes el cobro «${c}» por ${amount}, que ${when}`; }
  else if (stage === 0) { subject = `Se acerca tu fecha de pago: ${c}`; intro = `queremos avisarte con tiempo: se acerca la fecha de pago de «${c}» por ${amount}, que ${when}`; }
  else if (stage === 1) { subject = `Recordatorio: tu pago vence pronto — ${c}`; intro = `te escribimos de nuevo para recordarte que el cobro «${c}» por ${amount} ${when}`; }
  else { subject = `Aviso importante: pago pendiente — ${c}`; intro = `este es un aviso importante: el cobro «${c}» por ${amount} ${when} y todavía no registramos tu pago`; }
  const link = inv.payment_link ? `\n\nPuedes pagar aquí: ${inv.payment_link}` : '';
  const body = `Hola ${client.name}, ${intro}.${link}\n\nSi ya realizaste el pago, puedes ignorar este mensaje.\n\nGracias,\n${businessName()}`;
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

// Fechas elegidas en el calendario: ['2026-12-05', …] → únicas, ordenadas y desde hoy en adelante (máx. 60).
// Vacío → null (se usan los días por defecto). Si se eligió algo pero no queda ningún día válido → lanza Error.
function parseDates(raw, today) {
  const list = Array.isArray(raw) ? raw : (raw == null || raw === '' ? [] : String(raw).split(/[,\s;]+/));
  if (!list.length) return null;
  const ok = [...new Set(list.map(x => String(x).trim()).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(x + 'T00:00:00Z')) && x >= today))].sort();
  if (!ok.length) throw new Error('Elige al menos un día desde hoy en adelante.');
  if (ok.length > 60) throw new Error('Máximo 60 días de aviso por cobro.');
  return ok;
}
const parsePerDay = v => Math.min(3, Math.max(1, Math.round(Number(v)) || 1));

// Avisos ya enviados hoy (por día de RD): usa last_reminder_day/reminders_today; sin ellos, last_reminder_at.
function sentToday(inv, today) {
  if (inv.last_reminder_day) return String(inv.last_reminder_day).slice(0, 10) === today ? Number(inv.reminders_today) || 0 : 0;
  return inv.last_reminder_at && todayDO(new Date(inv.last_reminder_at)) === today ? 1 : 0;
}

// ¿Hoy es día de aviso?  Con calendario: solo los días elegidos (y, si se dejó marcado, cada 3 días tras vencer).
// Sin calendario: los días «antes» del cobro (por defecto 3 y 1), el día del vencimiento y cada 3 días en mora.
function isScheduledToday(inv, today) {
  const d = daysBetween(today, inv.due_date);
  if (Array.isArray(inv.remind_dates) && inv.remind_dates.length) {
    if (inv.remind_dates.some(x => String(x).slice(0, 10) === today)) return true;
    return inv.remind_overdue !== false && d < 0 && Math.abs(d) % 3 === 0;
  }
  if (d === 0) return true;
  if (d < 0) return Math.abs(d) % 3 === 0;
  const days = Array.isArray(inv.remind_days) && inv.remind_days.length ? inv.remind_days : DEFAULT_REMIND_DAYS;
  return days.includes(d);
}

// slot = corrida del día (1: 8:00, 2: 13:00, 3: 18:00 hora de RD). Un cobro con N correos por día usa las N primeras corridas.
function shouldRemindToday(inv, today, slot = 1) {
  const per = parsePerDay(inv.remind_per_day);
  if (slot > per) return false;
  if (sentToday(inv, today) >= slot) return false;
  return isScheduledToday(inv, today);
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

module.exports = { todayDO, daysBetween, parseTags, money, dateDO, fillVars, UNSUBSCRIBE_FOOTER, unsubscribeFooter, reminderMessage, receiptMessage, receiptNumber, shouldRemindToday, parseDays, parseDates, parsePerDay, sentToday, isScheduledToday, normalizeRecipients, cleanItems, lineTotal, itemsTotal, docNumber, round2, spreadDays, parseSchedule, DEFAULT_REMIND_DAYS, totals, businessName };
