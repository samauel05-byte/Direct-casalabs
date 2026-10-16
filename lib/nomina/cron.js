// Generación automática de nómina por calendario (quincenal).
//
// Reglas (hora de RD, UTC-4):
//  - Quincena 1 (paga ~15): novedades hasta el día 12; se genera el 13.
//  - Quincena 2 (paga ~30): novedades hasta el día 26; se genera el 28.
// Al pasar el corte, la nómina en curso se BLOQUEA (novedades_locked) y se abre
// la siguiente en borrador; lo que se capture después cae en la próxima.
// Al llegar el día de generación, el período bloqueado se CIERRA (status=closed).
//
// Qué se copia a la nueva quincena: sólo las columnas marcadas como fijas
// (nomina_columns.carry = true); las demás (novedades) arrancan vacías.
//
// El cron corre a diario; es idempotente (índice único por ciclo + chequeos),
// así que repetir o saltar un día no duplica ni rompe nada.
const { supabase } = require('../supabase');
const settingsStore = require('./settings');

const DR_OFFSET_MS = 4 * 3600 * 1000; // RD = UTC-4, sin horario de verano

function drParts(now) {
  const t = new Date((now != null ? now : Date.now()) - DR_OFFSET_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
function lastDay(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function pad(n) { return String(n).padStart(2, '0'); }
function cycleKey(y, m, half) { return `${y}-${pad(m)}-${half}`; }
function genDay(half) { return half === 'A' ? 13 : 28; }

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

async function createCyclePeriod(tenant, cid, c) {
  const key = cycleKey(c.y, c.m, c.half);
  const { data: period, error } = await supabase.from('nomina_periods').insert({
    tenant_id: tenant, client_id: cid, label: labelOf(c), year: c.y, month: c.m,
    cycle: key, pay_date: payDate(c), status: 'draft', novedades_locked: false,
  }).select('*').single();
  if (error) {
    // Choque con el índice único (otra corrida simultánea): reusar el existente.
    const { data: ex } = await supabase.from('nomina_periods').select('*')
      .eq('tenant_id', tenant).eq('client_id', cid).eq('cycle', key).maybeSingle();
    if (ex) return { period: ex, created: false };
    throw error;
  }
  // Arrastre de columnas fijas desde el período anterior (el más reciente).
  const { data: carryCols } = await supabase.from('nomina_columns')
    .select('key').eq('tenant_id', tenant).eq('client_id', cid).eq('carry', true);
  const carryKeys = (carryCols || []).map(c2 => c2.key);
  const { data: src } = await supabase.from('nomina_periods').select('id')
    .eq('tenant_id', tenant).eq('client_id', cid).neq('id', period.id)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  const { data: emps } = await supabase.from('nomina_employees').select('id')
    .eq('tenant_id', tenant).eq('client_id', cid).eq('active', true);
  const srcVals = {};
  if (src && carryKeys.length) {
    const { data: se } = await supabase.from('nomina_entries').select('employee_id, values')
      .eq('tenant_id', tenant).eq('period_id', src.id);
    for (const e of se || []) srcVals[e.employee_id] = e.values || {};
  }
  const rows = (emps || []).map(e => {
    const sv = srcVals[e.id] || {}; const values = {};
    for (const k of carryKeys) if (sv[k] != null) values[k] = sv[k];
    return { tenant_id: tenant, period_id: period.id, employee_id: e.id, values };
  });
  if (rows.length) await supabase.from('nomina_entries').insert(rows);
  return { period, created: true };
}

async function processCompany(co, today) {
  const tenant = co.tenant_id, cid = co.id;
  const acc = acceptingCycle(today.y, today.m, today.d);
  const accKey = cycleKey(acc.y, acc.m, acc.half);
  const actions = [];

  // 1) Asegurar que exista el borrador que acepta novedades.
  const { data: accPeriod } = await supabase.from('nomina_periods').select('id')
    .eq('tenant_id', tenant).eq('client_id', cid).eq('cycle', accKey).maybeSingle();
  if (!accPeriod) { const r = await createCyclePeriod(tenant, cid, acc); if (r.created) actions.push('abrir ' + accKey); }

  // 2) Resolver el ciclo anterior: cerrarlo si ya toca generar, o bloquearlo.
  const prev = prevCycle(acc);
  const prevKey = cycleKey(prev.y, prev.m, prev.half);
  const { data: prevPeriod } = await supabase.from('nomina_periods').select('id, status, novedades_locked')
    .eq('tenant_id', tenant).eq('client_id', cid).eq('cycle', prevKey).maybeSingle();
  if (prevPeriod) {
    if (genPassed(prev, today)) {
      if (prevPeriod.status !== 'closed') {
        await supabase.from('nomina_periods').update({ status: 'closed', novedades_locked: true, updated_at: new Date().toISOString() }).eq('id', prevPeriod.id);
        actions.push('generar ' + prevKey);
      }
    } else if (!prevPeriod.novedades_locked) {
      await supabase.from('nomina_periods').update({ novedades_locked: true, updated_at: new Date().toISOString() }).eq('id', prevPeriod.id);
      actions.push('bloquear ' + prevKey);
    }
  }
  return { client_id: cid, actions };
}

async function runAuto({ now } = {}) {
  const today = drParts(now);
  const { data: companies, error } = await supabase.from('nomina_companies')
    .select('id, tenant_id').eq('auto_nomina', true).eq('active', true);
  if (error) throw error;
  const details = [];
  for (const co of companies || []) {
    try {
      const st = await settingsStore.load(co.tenant_id, co.id);
      if (st && st.period_type === 'mensual') continue; // sólo quincenales
      const r = await processCompany(co, today);
      if (r.actions.length) details.push(r);
    } catch (e) {
      details.push({ client_id: co.id, error: String(e && e.message || e) });
    }
  }
  return { ran_at: new Date().toISOString(), dr_date: `${today.y}-${pad(today.m)}-${pad(today.d)}`, companies: (companies || []).length, changed: details.length, details };
}

module.exports = { runAuto, acceptingCycle, prevCycle, genPassed, cycleKey, labelOf, payDate, drParts };
