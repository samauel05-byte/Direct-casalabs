// Calendario de la nómina quincenal (hora de RD, UTC-4). Funciones puras, sin base de datos:
// las usan el cron (generación automática) y el panel (fechas de corte/generación/pago).
//  - Quincena 1 (paga ~15): novedades hasta el día 12; se genera el 13.
//  - Quincena 2 (paga ~30): novedades hasta el día 26; se genera el 28.
const DR_OFFSET_MS = 4 * 3600 * 1000; // RD = UTC-4, sin horario de verano

function drParts(now) {
  const t = new Date((now != null ? now : Date.now()) - DR_OFFSET_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
function lastDay(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function pad(n) { return String(n).padStart(2, '0'); }
function cycleKey(y, m, half) { return `${y}-${pad(m)}-${half}`; }
function genDay(half) { return half === 'A' ? 13 : 28; }
function cutDay(half) { return half === 'A' ? 12 : 26; }

// Ciclo que ACEPTA novedades hoy (según el día del mes en RD).
function acceptingCycle(y, m, d) {
  if (d <= 12) return { y, m, half: 'A' };
  if (d <= 26) return { y, m, half: 'B' };
  return m === 12 ? { y: y + 1, m: 1, half: 'A' } : { y, m: m + 1, half: 'A' };
}
// Ciclo inmediatamente anterior al dado.
function prevCycle(c) {
  if (c.half === 'B') return { y: c.y, m: c.m, half: 'A' };
  return c.m === 1 ? { y: c.y - 1, m: 12, half: 'B' } : { y: c.y, m: c.m - 1, half: 'B' };
}
function labelOf(c) {
  return c.half === 'A'
    ? `Nómina 01–15/${pad(c.m)}/${c.y}`
    : `Nómina 16–${lastDay(c.y, c.m)}/${pad(c.m)}/${c.y}`;
}
function payDate(c) {
  return c.half === 'A' ? `${c.y}-${pad(c.m)}-15` : `${c.y}-${pad(c.m)}-${pad(lastDay(c.y, c.m))}`;
}
// ¿El día de generación del ciclo `c` ya pasó (o es hoy), en RD?
function genPassed(c, today) {
  const a = c.y * 10000 + c.m * 100 + genDay(c.half);
  const b = today.y * 10000 + today.m * 100 + today.d;
  return b >= a;
}

module.exports = { DR_OFFSET_MS, drParts, lastDay, pad, cycleKey, genDay, cutDay, acceptingCycle, prevCycle, labelOf, payDate, genPassed };
