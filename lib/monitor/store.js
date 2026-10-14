// Capa de datos y orquestación del Monitor DGII. Ejecuta las comprobaciones
// desde el servidor, guarda resultados, abre/cierra incidentes, mantiene el
// resumen diario y calcula las métricas que lee el panel (sin volver a llamar a
// la DGII por cada visitante).

const supabase = require('../supabase');
const { urlForEndpointKey } = require('./endpoints');
const { runCheck } = require('./check');
const { decideIncident, availability, coverage, expectedRuns } = require('./incidents');

const T = {
  checks: 'dgii_monitor_checks',
  results: 'dgii_monitor_results',
  incidents: 'dgii_monitor_incidents',
  daily: 'dgii_monitor_daily',
  subs: 'dgii_monitor_subscriptions',
  notif: 'dgii_monitor_notifications',
  runner: 'dgii_monitor_runner',
  settings: 'dgii_monitor_settings',
};

// RD no tiene horario de verano (UTC-4 todo el año). Día local a partir de un ts.
const RD_OFFSET_MS = 4 * 3600 * 1000;
function rdDay(ms) { return new Date(ms - RD_OFFSET_MS).toISOString().slice(0, 10); }

async function getSettings() {
  const { data } = await supabase.from(T.settings).select('key, value');
  const s = {};
  for (const r of data || []) s[r.key] = r.value;
  return {
    retention_days: Number(s.retention_days ?? 14),
    manual_min_interval_s: Number(s.manual_min_interval_s ?? 30),
    stale_after_s: Number(s.stale_after_s ?? 180),
  };
}

async function listChecks() {
  const { data, error } = await supabase.from(T.checks).select('*').order('environment');
  if (error) throw error;
  return data || [];
}

// Reclama atómicamente las comprobaciones que toca ejecutar, para que varias
// instancias no las repitan. Devuelve solo las que esta instancia reclamó.
async function claimDueChecks(nowMs = Date.now()) {
  const checks = await listChecks();
  const claimed = [];
  for (const c of checks) {
    if (!c.enabled) continue; // Pausada
    const thresholdIso = new Date(nowMs - Math.round(c.interval_s * 1000 * 0.9)).toISOString();
    const nowIso = new Date(nowMs).toISOString();
    const { data, error } = await supabase
      .from(T.checks)
      .update({ last_run_claim: nowIso })
      .eq('id', c.id)
      .or(`last_run_claim.is.null,last_run_claim.lt.${thresholdIso}`)
      .select('id');
    if (!error && data && data.length) claimed.push(c);
  }
  return claimed;
}

// Resumen diario: lee-modifica-escribe el contador del día (RD) de esa comprobación.
async function bumpDaily(checkId, result, tsMs) {
  const day = rdDay(tsMs);
  const { data: existing } = await supabase.from(T.daily).select('*').eq('check_id', checkId).eq('day', day).maybeSingle();
  const prevRun = existing?.checks_run || 0;
  const prevMsTotal = (existing?.avg_ms || 0) * prevRun;
  const run = prevRun + 1;
  const okCount = (existing?.checks_ok || 0) + (result.ok ? 1 : 0);
  const degCount = (existing?.checks_degraded || 0) + (result.degraded ? 1 : 0);
  const avg = result.response_ms != null ? Math.round((prevMsTotal + result.response_ms) / run) : existing?.avg_ms || null;
  // Peor estado observado del día (para el color de la barra).
  const rank = { ok: 0, degraded: 1, invalid: 2, down: 3 };
  const prevWorst = existing?.worst_status || 'ok';
  const worst = (rank[result.status] ?? 0) > (rank[prevWorst] ?? 0) ? result.status : prevWorst;
  await supabase.from(T.daily).upsert({
    check_id: checkId, day, checks_run: run, checks_ok: okCount, checks_degraded: degCount,
    avg_ms: avg, worst_status: worst, updated_at: new Date().toISOString(),
  }, { onConflict: 'check_id,day' });
}

// Abre o cierra el incidente según los últimos resultados. Devuelve los eventos
// de cambio de estado (para disparar alertas): {opened|resolved, incident, check}.
async function updateIncidentState(check, tsMs) {
  const need = Math.max(check.fail_threshold, check.recover_threshold);
  const { data: recent } = await supabase.from(T.results)
    .select('ok, ts, status, error_type, error_detail')
    .eq('check_id', check.id).order('ts', { ascending: false }).limit(need);
  const { data: open } = await supabase.from(T.incidents)
    .select('*').eq('check_id', check.id).eq('status', 'open').maybeSingle();
  const action = decideIncident(recent || [], !!open, check.fail_threshold, check.recover_threshold);

  if (action === 'open') {
    // El primer fallo de la racha que confirma el incidente.
    const streak = (recent || []).slice(0, check.fail_threshold);
    const firstFail = streak[streak.length - 1];
    const last = recent[0];
    const nowIso = new Date(tsMs).toISOString();
    const { data: inc } = await supabase.from(T.incidents).insert({
      check_id: check.id, status: 'open',
      first_failure_at: firstFail?.ts || nowIso, confirmed_at: nowIso, last_failure_at: last?.ts || nowIso,
      fail_count: check.fail_threshold, error_type: last?.error_type || null, error_detail: last?.error_detail || null,
    }).select('*').single();
    return { event: 'opened', incident: inc, check };
  }
  if (action === 'resolve' && open) {
    const nowIso = new Date(tsMs).toISOString();
    const { data: inc } = await supabase.from(T.incidents).update({
      status: 'resolved', resolved_at: nowIso, updated_at: nowIso,
    }).eq('id', open.id).select('*').single();
    return { event: 'resolved', incident: inc, check };
  }
  // Incidente abierto que sigue fallando: actualiza contadores.
  if (open && recent?.[0] && !recent[0].ok) {
    await supabase.from(T.incidents).update({
      last_failure_at: recent[0].ts, fail_count: (open.fail_count || 0) + 1,
      error_type: recent[0].error_type, error_detail: recent[0].error_detail, updated_at: new Date(tsMs).toISOString(),
    }).eq('id', open.id);
  }
  return null;
}

// Ejecuta una comprobación y persiste todo. Devuelve {result, change}.
async function performCheck(check, { source = 'auto', fetchImpl } = {}) {
  const url = urlForEndpointKey(check.endpoint_key);
  const r = await runCheck({ url, method: check.method, timeoutMs: check.timeout_ms, degradedMs: check.degraded_ms, expect: check.check_type }, fetchImpl);
  const tsMs = Date.now();
  const row = {
    check_id: check.id, ts: new Date(tsMs).toISOString(), ok: r.ok, degraded: r.degraded, status: r.status,
    http_code: r.http_code ?? null, response_ms: r.response_ms ?? null, error_type: r.error_type ?? null,
    error_detail: r.error_detail ?? null, source,
  };
  await supabase.from(T.results).insert(row);
  await bumpDaily(check.id, r, tsMs);
  const change = await updateIncidentState(check, tsMs);
  return { result: row, change };
}

// Punto de entrada del scheduler: corre todas las comprobaciones que tocan.
async function runDueChecks({ fetchImpl } = {}) {
  const nowMs = Date.now();
  await supabase.from(T.runner).update({ last_cron_at: new Date(nowMs).toISOString(), updated_at: new Date(nowMs).toISOString() }).eq('id', 1);
  const due = await claimDueChecks(nowMs);
  const changes = [];
  for (const c of due) {
    try {
      const { change } = await performCheck(c, { source: 'auto', fetchImpl });
      if (change) changes.push(change);
    } catch (e) { console.error('monitor check error', c.service_key, c.environment, e.message); }
  }
  await supabase.from(T.runner).update({ last_run_at: new Date().toISOString() }).eq('id', 1);
  return { ran: due.length, changes };
}

// ── Métricas para el panel ──────────────────────────────────────────────────

async function periodFromResults(checkId, fromMs) {
  const { data } = await supabase.from(T.results)
    .select('ok, degraded, response_ms')
    .eq('check_id', checkId).gte('ts', new Date(fromMs).toISOString());
  const rows = data || [];
  const run = rows.length;
  const ok = rows.filter(r => r.ok).length;
  const deg = rows.filter(r => r.degraded).length;
  return { run, ok, deg };
}

async function periodFromDaily(checkId, days) {
  const from = rdDay(Date.now() - (days - 1) * 86400000);
  const { data } = await supabase.from(T.daily)
    .select('checks_run, checks_ok, checks_degraded').eq('check_id', checkId).gte('day', from);
  let run = 0, ok = 0, deg = 0;
  for (const r of data || []) { run += r.checks_run; ok += r.checks_ok; deg += r.checks_degraded; }
  return { run, ok, deg };
}

function periodMetrics(agg, fromMs, nowMs, startedAtMs, intervalS) {
  const exp = expectedRuns(fromMs, nowMs, startedAtMs, intervalS);
  return {
    availability: availability(agg.run, agg.ok),
    coverage: coverage(agg.run, exp),
    runs: agg.run, ok: agg.ok, degraded: agg.deg, expected: exp,
    hasData: agg.run > 0,
  };
}

// Instantánea completa del estado para el panel.
async function getStatusSnapshot() {
  const nowMs = Date.now();
  const settings = await getSettings();
  const checks = await listChecks();
  const { data: runner } = await supabase.from(T.runner).select('*').eq('id', 1).maybeSingle();
  const monitorStale = runner?.last_cron_at ? (nowMs - new Date(runner.last_cron_at).getTime()) > settings.stale_after_s * 1000 : true;

  const services = [];
  for (const c of checks) {
    const startedAtMs = new Date(c.started_at).getTime();
    const { data: lastArr } = await supabase.from(T.results)
      .select('ts, status, ok, degraded, response_ms, http_code, error_type, error_detail')
      .eq('check_id', c.id).order('ts', { ascending: false }).limit(1);
    const last = lastArr?.[0] || null;

    // Períodos: 24h desde resultados; 7/30/90d desde el resumen diario.
    const [p24, d7, d30, d90] = await Promise.all([
      periodFromResults(c.id, nowMs - 86400000),
      periodFromDaily(c.id, 7), periodFromDaily(c.id, 30), periodFromDaily(c.id, 90),
    ]);

    // Barras diarias de los últimos 90 días.
    const fromDay = rdDay(nowMs - 89 * 86400000);
    const { data: dailyRows } = await supabase.from(T.daily)
      .select('day, checks_run, checks_ok, checks_degraded, worst_status, avg_ms')
      .eq('check_id', c.id).gte('day', fromDay).order('day');
    const dailyMap = {}; for (const r of dailyRows || []) dailyMap[r.day] = r;
    const bars = [];
    for (let i = 89; i >= 0; i--) {
      const dMs = nowMs - i * 86400000; const day = rdDay(dMs);
      const row = dailyMap[day];
      const dayStart = new Date(day + 'T00:00:00.000Z').getTime() + RD_OFFSET_MS;
      const dayEnd = Math.min(nowMs, dayStart + 86400000);
      const exp = expectedRuns(dayStart, dayEnd, startedAtMs, c.interval_s);
      bars.push({
        day,
        run: row?.checks_run || 0, ok: row?.checks_ok || 0, degraded: row?.checks_degraded || 0,
        worst: row?.worst_status || null, expected: exp,
        availability: row ? availability(row.checks_run, row.checks_ok) : null,
        coverage: row ? coverage(row.checks_run, exp) : null,
      });
    }

    // Serie de tiempos de respuesta (últimas 120 comprobaciones).
    const { data: series } = await supabase.from(T.results)
      .select('ts, response_ms, status, ok').eq('check_id', c.id).order('ts', { ascending: false }).limit(120);

    // Incidentes activos y recientes.
    const { data: incidents } = await supabase.from(T.incidents)
      .select('*').eq('check_id', c.id).order('created_at', { ascending: false }).limit(10);

    // Estado presentado: Pausado > Sin datos > Sin datos recientes > último estado.
    let presented;
    if (!c.enabled) presented = 'paused';
    else if (!last) presented = 'nodata';
    else if ((nowMs - new Date(last.ts).getTime()) > settings.stale_after_s * 1000) presented = 'stale';
    else presented = last.status;

    services.push({
      id: c.id, service_key: c.service_key, environment: c.environment, name: c.name, description: c.description,
      enabled: c.enabled, check_type: c.check_type, interval_s: c.interval_s, degraded_ms: c.degraded_ms,
      timeout_ms: c.timeout_ms, fail_threshold: c.fail_threshold, recover_threshold: c.recover_threshold,
      started_at: c.started_at,
      presented,
      last: last ? { ts: last.ts, status: last.status, ok: last.ok, degraded: last.degraded, response_ms: last.response_ms, http_code: last.http_code, error_type: last.error_type, error_detail: last.error_detail } : null,
      next_eta: last ? new Date(new Date(last.ts).getTime() + c.interval_s * 1000).toISOString() : null,
      periods: {
        h24: periodMetrics(p24, nowMs - 86400000, nowMs, startedAtMs, c.interval_s),
        d7: periodMetrics(d7, nowMs - 7 * 86400000, nowMs, startedAtMs, c.interval_s),
        d30: periodMetrics(d30, nowMs - 30 * 86400000, nowMs, startedAtMs, c.interval_s),
        d90: periodMetrics(d90, nowMs - 90 * 86400000, nowMs, startedAtMs, c.interval_s),
      },
      bars,
      series: (series || []).reverse(),
      incidents: incidents || [],
    });
  }

  return {
    now: new Date(nowMs).toISOString(),
    monitor: { last_cron_at: runner?.last_cron_at || null, last_run_at: runner?.last_run_at || null, stale: monitorStale, stale_after_s: settings.stale_after_s },
    services,
  };
}

// Detalle de un día (RD) para una comprobación: sus resultados e incidentes.
async function getDayDetail(checkId, day) {
  const dayStartMs = new Date(day + 'T00:00:00.000Z').getTime() + RD_OFFSET_MS;
  const from = new Date(dayStartMs).toISOString();
  const to = new Date(dayStartMs + 86400000).toISOString();
  const { data: results } = await supabase.from(T.results)
    .select('ts, status, ok, degraded, response_ms, http_code, error_type, error_detail, source')
    .eq('check_id', checkId).gte('ts', from).lt('ts', to).order('ts', { ascending: false }).limit(2000);
  const { data: incidents } = await supabase.from(T.incidents)
    .select('*').eq('check_id', checkId)
    .or(`and(confirmed_at.gte.${from},confirmed_at.lt.${to}),and(status.eq.open,confirmed_at.lt.${to})`)
    .order('created_at', { ascending: false });
  return { day, results: results || [], incidents: incidents || [] };
}

async function prune() {
  const s = await getSettings();
  try { await supabase.rpc('dgii_monitor_prune', { p_days: s.retention_days }); } catch (e) { /* no crítico */ }
}

module.exports = {
  T, rdDay, getSettings, listChecks, claimDueChecks, performCheck, runDueChecks,
  getStatusSnapshot, getDayDetail, updateIncidentState, bumpDaily, prune,
};
