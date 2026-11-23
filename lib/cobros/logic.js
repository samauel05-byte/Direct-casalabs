// Lógica pura del módulo Cobros (sin base de datos ni red): se prueba aparte.
const TZ = 'America/Santo_Domingo';

const todayDO = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const parseTags = raw => [...new Set(String(raw || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean))];

const money = (amount, currency) =>
  new Intl.NumberFormat('es-DO', { style: 'currency', currency: currency === 'USD' ? 'USD' : 'DOP' }).format(Number(amount) || 0);
const dateDO = iso => iso ? new Intl.DateTimeFormat('es-DO', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(String(iso).slice(0, 10) + 'T12:00:00Z')) : '—';

const businessName = () => process.env.BUSINESS_NAME || 'Casa Labs';

function fillVars(text, client) {
  return String(text || '')
    .replace(/\{\{\s*nombre\s*\}\}/gi, client.name || '')
    .replace(/\{\{\s*empresa\s*\}\}/gi, client.company || '')
    .replace(/\{\{\s*negocio\s*\}\}/gi, businessName());
}

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

// 3 días antes, 1 día antes, el día del vencimiento y cada 3 días en mora; máximo un aviso por día.
function shouldRemindToday(inv, today) {
  if (inv.last_reminder_at && todayDO(new Date(inv.last_reminder_at)) === today) return false;
  const d = daysBetween(today, inv.due_date);
  return d === 3 || d === 1 || d === 0 || (d < 0 && Math.abs(d) % 3 === 0);
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

module.exports = { todayDO, daysBetween, parseTags, money, dateDO, fillVars, UNSUBSCRIBE_FOOTER, reminderMessage, shouldRemindToday, totals, businessName };
