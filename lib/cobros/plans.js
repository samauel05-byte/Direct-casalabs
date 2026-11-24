// Lógica pura de los planes de cobro recurrente (sin base de datos ni red): se prueba aparte.
// Un plan es mensual: el día `create_day` de un mes se crea el cobro (con enlace de PayPal) que vence el día `due_day` del mes
// siguiente; a la hora `cutoff_time` de ese día (hora de República Dominicana, UTC-4 todo el año) se corta si no se pagó.
const L = require('./logic');

const pad = n => String(n).padStart(2, '0');
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// 'AAAA-MM' + n meses
function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}
function addDays(iso, n) {
  const t = new Date(iso + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10);
}
const periodLabel = ym => { const [y, m] = ym.split('-').map(Number); return `${MESES[m - 1]} de ${y}`; };

/**
 * Ciclo vigente hoy. Si hoy es el día de crear o posterior, el ciclo empezó este mes (vence el mes que viene);
 * si no, sigue el ciclo del mes pasado (vence este mes). `period` = mes en que vence = mes de servicio que se paga.
 */
function cycleFor(plan, today) {
  const ym = today.slice(0, 7), day = Number(today.slice(8, 10));
  const startYm = day >= plan.create_day ? ym : addMonths(ym, -1);
  const dueYm = addMonths(startYm, 1);
  return { createDate: `${startYm}-${pad(plan.create_day)}`, dueDate: `${dueYm}-${pad(plan.due_day)}`, period: dueYm };
}

// Se genera el cobro del ciclo si ya llegó su día, no ha vencido y todavía no existe.
function shouldGenerate(plan, today, cycle, exists) {
  return !!plan.active && !exists && today >= cycle.createDate && today <= cycle.dueDate;
}

// Momento exacto del corte (ms): día límite a la hora indicada, hora de RD.
function cutoffAtMs(dueDate, hhmm) {
  return Date.parse(`${String(dueDate).slice(0, 10)}T${hhmm || '11:55'}:00-04:00`);
}

// Días de aviso del cobro: offsets «días antes del límite» (0 = el día límite), solo desde hoy y desde que se creó el cobro.
function remindDatesFor(plan, cycle, today) {
  const offs = Array.isArray(plan.remind_offsets) && plan.remind_offsets.length ? plan.remind_offsets : [5, 3, 1, 0];
  const dates = [...new Set(offs.map(o => addDays(cycle.dueDate, -Number(o))))].filter(d => d >= today && d >= cycle.createDate && d <= cycle.dueDate).sort();
  return dates.length ? dates : [cycle.dueDate];
}

// «5, 3, 1, 0» → [5,3,1,0] (enteros 0 a 30, máx. 8). Vacío → por defecto. Inválido → Error.
function parseOffsets(raw) {
  const text = Array.isArray(raw) ? raw.join(',') : String(raw == null ? '' : raw);
  if (!text.trim()) return [5, 3, 1, 0];
  const nums = text.split(/[,\s;]+/).filter(Boolean).map(Number);
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 30)) throw new Error('Los días de aviso deben ser números enteros de 0 a 30, separados por coma (0 = el día límite).');
  const out = [...new Set(nums)].sort((a, b) => b - a);
  if (out.length > 8) throw new Error('Máximo 8 avisos por ciclo.');
  return out;
}

/**
 * ¿Hay que cortar ahora? Solo con el cobro SIN pagar y a partir de la hora de corte de su día límite.
 * 'paid' | 'wait' (aún no es la hora) | 'cutoff'
 */
function cutoffState(plan, inv, nowMs) {
  if (inv.status === 'paid') return 'paid';
  if (inv.status === 'cancelled') return 'paid';          // un cobro cancelado no se corta
  return nowMs >= cutoffAtMs(inv.due_date, plan.cutoff_time) ? 'cutoff' : 'wait';
}

// Texto del cobro mensual.
const invoiceConcept = (plan, cycle) => `${plan.concept} — ${periodLabel(cycle.period)}`;

// Validación de un plan (alta o edición). Devuelve campos limpios o lanza Error con mensaje en español.
function cleanPlan(b, { requireAll = true } = {}) {
  const out = {};
  const has = k => b[k] !== undefined;
  const int = (k, min, max, label) => { const n = Number(b[k]); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} debe ser un número entero de ${min} a ${max}.`); return n; };
  if (requireAll || has('name')) { const v = String(b.name || '').trim(); if (!v) throw new Error('Ponle un nombre al plan.'); out.name = v.slice(0, 120); }
  if (requireAll || has('concept')) { const v = String(b.concept || '').trim(); if (!v) throw new Error('El concepto es obligatorio.'); out.concept = v.slice(0, 200); }
  if (requireAll || has('amount')) { const a = Number(String(b.amount ?? '').replace(/,/g, '')); if (!(a >= 1)) throw new Error('El monto debe ser de al menos US$1.00 (PayPal).'); out.amount = Math.round(a * 100) / 100; }
  if (requireAll || has('create_day')) out.create_day = int('create_day', 1, 28, 'El día de crear el cobro');
  if (requireAll || has('due_day')) out.due_day = int('due_day', 1, 28, 'El día límite');
  if (requireAll || has('cutoff_time')) { const t = String(b.cutoff_time || '11:55').trim(); if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error('La hora de corte debe tener formato HH:MM (ej. 11:55).'); out.cutoff_time = t; }
  if (requireAll || has('remind_offsets')) out.remind_offsets = parseOffsets(b.remind_offsets);
  if (has('notify_email')) { const e = String(b.notify_email || '').trim().toLowerCase(); if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('El correo para avisos no es válido.'); out.notify_email = e || null; }
  if (has('nexo_org')) { const v = String(b.nexo_org || '').trim().slice(0, 120); out.nexo_org = v || null; }
  return out;
}

// Resumen legible de un plan para la pantalla: ciclo vigente, próximo corte y qué pasaría.
function describe(plan, nowMs, inv) {
  const today = L.todayDO(new Date(nowMs)), cycle = cycleFor(plan, today), cutoff = cutoffAtMs(cycle.dueDate, plan.cutoff_time);
  const paid = inv && inv.status === 'paid';
  return { today, cycle, cutoffAtMs: cutoff, cutoffInDays: L.daysBetween(today, cycle.dueDate), paid: !!paid, invoiceExists: !!inv };
}

module.exports = { addMonths, addDays, periodLabel, cycleFor, shouldGenerate, cutoffAtMs, remindDatesFor, parseOffsets, cutoffState, invoiceConcept, cleanPlan, describe };
