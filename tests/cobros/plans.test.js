// Planes de cobro recurrente: ciclos, corte a la hora, simulación vs. real, salvaguardas y reactivación automática.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
process.env.COBROS_UNSUB_SECRET = 'prueba-secreta-de-baja-1234567890';
const ROOT = path.join(__dirname, '../..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const P = require('../../lib/cobros/plans');

const CL = '33333333-3333-4333-8333-333333333333', PL = '22222222-2222-4222-8222-222222222222', DT = '44444444-4444-4444-8444-444444444444';
const plan0 = { create_day: 25, due_day: 5, cutoff_time: '11:55', remind_offsets: [5, 3, 1, 0], active: true };

test('ciclo mensual: se crea el 25, vence el 5 del mes siguiente y cambia de año sin problema', () => {
  assert.deepEqual(P.cycleFor(plan0, '2026-11-25'), { createDate: '2026-11-25', dueDate: '2026-12-05', period: '2026-12' });
  assert.deepEqual(P.cycleFor(plan0, '2026-12-05'), { createDate: '2026-11-25', dueDate: '2026-12-05', period: '2026-12' });   // el día límite sigue en el mismo ciclo
  assert.deepEqual(P.cycleFor(plan0, '2026-12-06'), { createDate: '2026-11-25', dueDate: '2026-12-05', period: '2026-12' });   // ya vencido: sigue siendo ese ciclo hasta el 25
  assert.deepEqual(P.cycleFor(plan0, '2026-12-25'), { createDate: '2026-12-25', dueDate: '2027-01-05', period: '2027-01' });   // cambio de año
  assert.deepEqual(P.cycleFor(plan0, '2027-01-10'), { createDate: '2026-12-25', dueDate: '2027-01-05', period: '2027-01' });
  assert.equal(P.addMonths('2026-12', 1), '2027-01'); assert.equal(P.addMonths('2026-01', -1), '2025-12');
  assert.equal(P.periodLabel('2026-12'), 'diciembre de 2026');
});

test('se genera solo desde el día de crear y antes de que venza; no si ya existe o el plan está pausado', () => {
  const c = d => P.cycleFor(plan0, d);
  assert.equal(P.shouldGenerate(plan0, '2026-11-25', c('2026-11-25'), false), true);
  assert.equal(P.shouldGenerate(plan0, '2026-12-05', c('2026-12-05'), false), true);          // aún se puede el día límite (recuperación)
  assert.equal(P.shouldGenerate(plan0, '2026-12-06', c('2026-12-06'), false), false);         // ya venció ese ciclo: no se crea un cobro viejo
  assert.equal(P.shouldGenerate(plan0, '2026-11-25', c('2026-11-25'), true), false);
  assert.equal(P.shouldGenerate({ ...plan0, active: false }, '2026-11-25', c('2026-11-25'), false), false);
});

test('el corte es a la hora exacta de RD (UTC-4): 11:55 a. m. = 15:55 UTC; paga a tiempo = no hay corte', () => {
  assert.equal(P.cutoffAtMs('2026-12-05', '11:55'), Date.parse('2026-12-05T15:55:00Z'));
  const inv = st => ({ status: st, due_date: '2026-12-05' });
  assert.equal(P.cutoffState(plan0, inv('pending'), Date.parse('2026-12-05T15:54:59Z')), 'wait');
  assert.equal(P.cutoffState(plan0, inv('pending'), Date.parse('2026-12-05T15:55:00Z')), 'cutoff');
  assert.equal(P.cutoffState(plan0, inv('overdue'), Date.parse('2026-12-20T00:00:00Z')), 'cutoff');
  assert.equal(P.cutoffState(plan0, inv('paid'), Date.parse('2026-12-20T00:00:00Z')), 'paid');
  assert.equal(P.cutoffState(plan0, inv('cancelled'), Date.parse('2026-12-20T00:00:00Z')), 'paid');   // cancelado no se corta
  assert.equal(P.cutoffState({ ...plan0, cutoff_time: '09:30' }, inv('pending'), Date.parse('2026-12-05T13:30:00Z')), 'cutoff');
});

test('avisos del ciclo, validación de días y del plan', () => {
  const cyc = P.cycleFor(plan0, '2026-11-25');
  assert.deepEqual(P.remindDatesFor(plan0, cyc, '2026-11-25'), ['2026-11-30', '2026-12-02', '2026-12-04', '2026-12-05']);
  assert.deepEqual(P.remindDatesFor(plan0, cyc, '2026-12-03'), ['2026-12-04', '2026-12-05']);                   // lo que ya pasó no se programa
  assert.deepEqual(P.remindDatesFor({ ...plan0, remind_offsets: [30] }, cyc, '2026-11-25'), ['2026-12-05']);    // siempre queda al menos el día límite
  assert.deepEqual(P.parseOffsets('1, 5 ,3,0,5'), [5, 3, 1, 0]); assert.deepEqual(P.parseOffsets(''), [5, 3, 1, 0]);
  assert.throws(() => P.parseOffsets('a'), /enteros/); assert.throws(() => P.parseOffsets('31'), /0 a 30/);
  const ok = P.cleanPlan({ name: ' Save ', concept: 'Nexo + Direct', amount: '210', create_day: '25', due_day: '5', cutoff_time: '11:55', remind_offsets: '5,3,1,0', notify_email: 'A@B.CO', nexo_org: ' Save Consultores ' });
  assert.deepEqual([ok.name, ok.amount, ok.create_day, ok.due_day, ok.cutoff_time, ok.notify_email, ok.nexo_org], ['Save', 210, 25, 5, '11:55', 'a@b.co', 'Save Consultores']);
  for (const [bad, re] of [[{ amount: '0.5' }, /US\$1/], [{ create_day: '29' }, /1 a 28/], [{ due_day: 'x' }, /día límite/], [{ cutoff_time: '25:00' }, /HH:MM/], [{ notify_email: 'x' }, /correo/], [{ name: '' }, /nombre/]])
    assert.throws(() => P.cleanPlan({ name: 'S', concept: 'C', amount: 210, create_day: 25, due_day: 5, cutoff_time: '11:55', ...bad }), re);
});

// ───────── Flujo completo con una base en memoria y PayPal / Direct / Nexo simulados ─────────
function fakeDb(seed) {
  const T = { cobros_plans: [], cobros_invoices: [], cobros_clients: [], cobros_plan_events: [], cobros_log: [], direct_tenants: [], ...seed };
  let n = 0;
  const from = name => {
    const st = { f: [], op: 'select', patch: null, rows: null, ord: null, lim: null, one: null };
    const api = {
      select() { return api; }, insert(r) { st.op = 'insert'; st.rows = Array.isArray(r) ? r : [r]; return api; }, update(p) { st.op = 'update'; st.patch = p; return api; }, delete() { st.op = 'delete'; return api; },
      eq(k, v) { st.f.push(r => r[k] === v); return api; }, in(k, vs) { st.f.push(r => vs.includes(r[k])); return api; }, is(k, v) { st.f.push(r => (r[k] ?? null) === v); return api; },
      order(k, o) { st.ord = [k, !(o && o.ascending === false)]; return api; }, limit(x) { st.lim = x; return api; },
      single() { st.one = 'single'; return exec(); }, maybeSingle() { st.one = 'maybe'; return exec(); }, then(res, rej) { return exec().then(res, rej); },
    };
    async function exec() {
      const tbl = T[name]; let rows;
      if (st.op === 'insert') {
        rows = [];
        for (const r of st.rows) {
          const row = { id: r.id || `id${++n}`, created_at: new Date().toISOString(), ...r };
          if (name === 'cobros_invoices' && row.plan_id && tbl.some(x => x.plan_id === row.plan_id && x.period === row.period)) return { data: null, error: { code: '23505', message: 'dup' } };
          tbl.push(row); rows.push(row);
        }
      } else {
        rows = tbl.filter(r => st.f.every(f => f(r)));
        if (st.op === 'update') rows.forEach(r => Object.assign(r, st.patch));
        if (st.op === 'delete') rows.forEach(r => tbl.splice(tbl.indexOf(r), 1));
      }
      if (st.ord) rows = [...rows].sort((a, b) => (a[st.ord[0]] > b[st.ord[0]] ? 1 : -1) * (st.ord[1] ? 1 : -1));
      if (st.lim != null) rows = rows.slice(0, st.lim);
      if (st.one === 'single') return rows.length ? { data: { ...rows[0] }, error: null } : { data: null, error: { message: 'sin filas' } };
      if (st.one === 'maybe') return { data: rows[0] ? { ...rows[0] } : null, error: null };
      return { data: rows.map(r => ({ ...r })), error: null };
    }
    return api;
  };
  return { T, supabase: { from } };
}

function world(planOver = {}, opts = {}) {
  const db = fakeDb({});
  db.T.cobros_clients.push({ id: CL, tenant_id: 't1', name: 'Save Consultores', email: 'pagos@save.do', phone: null, opt_in_email: true, opt_in_whatsapp: false });
  db.T.cobros_plans.push({ id: PL, tenant_id: 't1', client_id: CL, name: 'Save — Nexo + Direct', concept: 'Nexo + Direct — servicio mensual', amount: 210, currency: 'USD', create_day: 25, due_day: 5, cutoff_time: '11:55',
    remind_offsets: [5, 3, 1, 0], mode: 'simulation', active: true, direct_tenant_id: DT, nexo_org: 'Save Consultores', notify_email: 'admin@casalabs.do', suspended_at: null, suspended_direct: false, suspended_nexo: false, ...planOver });
  const rec = { sends: [], direct: [], nexo: [], links: 0, cancels: [] };
  const ctl = { paypalState: 'open', paypalThrows: false, linkThrows: opts.linkThrows || false, nexoThrows: false, admin: true };
  const stub = (m, exports) => { require.cache[require.resolve(m)] = { id: m, filename: m, loaded: true, exports }; };
  stub('../../lib/supabase', db.supabase);
  stub('../../lib/cobros/messaging', { providers: () => ({}), dispatch: async o => { if (o.channel !== 'email' || !o.client.email) return null; rec.sends.push(o); return { ok: true }; } });
  stub('../../lib/paypal', { hasCredentials: () => true, api: async () => ({}) });
  stub('../../lib/licenses', { forget() {}, isPlatformAdmin: async () => ctl.admin });
  stub('../../lib/cobros/enforce', {
    setDirect: async (id, s) => { rec.direct.push([id, s]); }, nexoConfigured: () => true,
    nexoCall: async (a, org, extra) => { rec.nexo.push([a, org, extra]); if (ctl.nexoThrows && a !== 'status') throw new Error('Nexo: sin conexión'); return { ok: true }; },
  });
  stub('../../lib/cobros/paypal', {
    createInvoiceLink: async inv => { if (ctl.linkThrows) throw new Error('PayPal 403: insufficient permissions'); rec.links++; return { id: 'INV2-' + rec.links, url: 'https://www.paypal.com/invoice/p/#INV2-' + rec.links, usd: Number(inv.amount), rate: null }; },
    invoiceState: async () => { if (ctl.paypalThrows) throw new Error('PayPal caído'); return ctl.paypalState; }, cancelInvoice: async id => { rec.cancels.push(id); return true; },
  });
  for (const m of ['../../lib/cobros/api']) delete require.cache[require.resolve(m)];
  const api = require('../../lib/cobros/api');
  const kinds = () => db.T.cobros_plan_events.map(e => e.kind);
  return { db, rec, ctl, api, kinds, plan: () => db.T.cobros_plans[0], inv: () => db.T.cobros_invoices[0] };
}
const T = iso => Date.parse(iso);

test('el cobro se crea la mañana del 25 (no antes de las 8:00 de RD), con enlace de PayPal y aviso al cliente con su enlace', async () => {
  const w = world();
  await w.api.processPlan(w.plan(), T('2026-11-25T11:00:00Z'));                                   // 7:00 a. m. de RD
  assert.equal(w.db.T.cobros_invoices.length, 0);
  const r = await w.api.processPlan(w.plan(), T('2026-11-25T12:05:00Z'));                         // 8:05 a. m. de RD
  const inv = w.inv();
  assert.equal(inv.period, '2026-12'); assert.equal(inv.due_date, '2026-12-05'); assert.equal(inv.amount, 210); assert.equal(inv.currency, 'USD');
  assert.match(inv.concept, /diciembre de 2026/); assert.deepEqual(inv.remind_dates, ['2026-11-30', '2026-12-02', '2026-12-04', '2026-12-05']);
  assert.match(inv.payment_link, /paypal\.com\/invoice/); assert.ok(inv.created_notice_at);
  const toClient = w.rec.sends.find(s => s.client.email === 'pagos@save.do');
  assert.equal(toClient.kind, 'invoice'); assert.match(toClient.subject, /Nuevo cobro/); assert.match(toClient.body, /paypal\.com\/invoice/);
  assert.ok(w.rec.sends.some(s => s.client.email === 'admin@casalabs.do' && s.kind === 'plan'));  // aviso de administración
  assert.ok(['invoice_created', 'link_ready', 'notice_sent'].every(k => w.kinds().includes(k)));
  assert.match(r.actions.join(' '), /creado con su enlace/);
  // una segunda revisión el mismo día no duplica nada
  await w.api.processPlan(w.plan(), T('2026-11-25T17:00:00Z'));
  assert.equal(w.db.T.cobros_invoices.length, 1); assert.equal(w.rec.links, 1); assert.equal(w.rec.sends.filter(s => s.kind === 'invoice').length, 1);
});

test('sin enlace de PayPal no se le escribe al cliente, se reintenta, y al fin se envía; y nunca se corta sin enlace', async () => {
  const w = world({ mode: 'live' }, { linkThrows: true });
  await w.api.processPlan(w.plan(), T('2026-11-25T12:05:00Z'));
  assert.ok(!w.inv().payment_link); assert.equal(w.rec.sends.filter(s => s.client.email === 'pagos@save.do').length, 0);
  assert.ok(w.kinds().includes('link_failed'));
  await w.api.processPlan(w.plan(), T('2026-11-26T12:05:00Z')); assert.equal(w.kinds().filter(k => k === 'link_failed').length, 1);   // el error no se repite cada corrida
  // llega el corte sin enlace: aunque el modo sea REAL no se suspende nada
  const r = await w.api.processPlan(w.plan(), T('2026-12-05T15:56:00Z'));
  assert.deepEqual(w.rec.direct, []); assert.deepEqual(w.rec.nexo.filter(x => x[0] !== 'status'), []);
  assert.ok(w.kinds().includes('blocked_no_link')); assert.match(r.actions.join(' '), /Sin enlace/);
  // PayPal vuelve a funcionar: se genera el enlace y entonces sí se envía el cobro
  w.ctl.linkThrows = false; await w.api.processPlan(w.plan(), T('2026-12-05T17:00:00Z'));
  assert.ok(w.inv().payment_link && w.inv().created_notice_at);
});

test('simulación: a la hora de corte registra lo que habría hecho y avisa al administrador, sin suspender nada ni repetir', async () => {
  const w = world();
  await w.api.processPlan(w.plan(), T('2026-11-25T12:05:00Z'));
  await w.api.processPlan(w.plan(), T('2026-12-05T15:54:00Z'));                                   // 11:54: todavía no
  assert.ok(!w.kinds().includes('simulated_suspend'));
  const r = await w.api.processPlan(w.plan(), T('2026-12-05T15:55:00Z'));                         // 11:55: corte
  assert.ok(w.kinds().includes('simulated_suspend')); assert.match(r.actions.join(' '), /Simulación: se habría suspendido Direct y Nexo \(Save Consultores\)/);
  assert.deepEqual(w.rec.direct, []); assert.deepEqual(w.rec.nexo, []); assert.equal(w.plan().suspended_at, null);
  const sim = w.rec.sends.filter(s => /SIMULACIÓN/.test(s.subject)); assert.equal(sim.length, 1); assert.match(sim[0].body, /No se suspendió nada/);
  await w.api.processPlan(w.plan(), T('2026-12-05T17:00:00Z')); await w.api.processPlan(w.plan(), T('2026-12-06T15:00:00Z'));
  assert.equal(w.kinds().filter(k => k === 'simulated_suspend').length, 1);
  assert.equal(w.rec.sends.filter(s => /SIMULACIÓN/.test(s.subject)).length, 1);
});

test('modo real: a las 11:55 sin pago suspende Direct y Nexo; al pagar los reactiva solos; si pagan antes, no se corta', async () => {
  const w = world({ mode: 'live' });
  await w.api.processPlan(w.plan(), T('2026-11-25T12:05:00Z'));
  await w.api.processPlan(w.plan(), T('2026-12-05T15:54:00Z')); assert.deepEqual(w.rec.direct, []);
  await w.api.processPlan(w.plan(), T('2026-12-05T15:55:00Z'));
  assert.deepEqual(w.rec.direct, [[DT, true]]);
  const nx = w.rec.nexo.find(x => x[0] === 'suspend'); assert.equal(nx[1], 'Save Consultores'); assert.match(nx[2].reason, /diciembre de 2026/);
  assert.equal(w.plan().suspended_direct, true); assert.equal(w.plan().suspended_nexo, true); assert.ok(w.plan().suspended_at);
  assert.ok(w.kinds().includes('suspended'));
  assert.ok(w.rec.sends.some(s => /Acceso suspendido/.test(s.subject)));
  await w.api.processPlan(w.plan(), T('2026-12-05T17:00:00Z')); assert.equal(w.rec.direct.length, 1);   // ya suspendido: no se repite
  // el cliente paga (PayPal lo confirma en la siguiente revisión) → se reactiva todo
  w.ctl.paypalState = 'paid';
  await w.api.processPlan(w.plan(), T('2026-12-05T18:10:00Z'));
  assert.equal(w.inv().status, 'paid');
  assert.deepEqual(w.rec.direct, [[DT, true], [DT, false]]);
  assert.equal(w.rec.nexo.filter(x => x[0] === 'reactivate').length, 1);
  assert.equal(w.plan().suspended_direct, false); assert.equal(w.plan().suspended_nexo, false); assert.equal(w.plan().suspended_at, null);
  assert.ok(w.kinds().includes('paid') && w.kinds().includes('reactivated'));
  assert.ok(w.rec.sends.some(s => s.kind === 'receipt'));                                          // y el cliente recibe su comprobante

  // otro mes: pagan ANTES del corte → no se suspende nada
  const w2 = world({ mode: 'live' });
  await w2.api.processPlan(w2.plan(), T('2026-11-25T12:05:00Z'));
  w2.ctl.paypalState = 'paid';
  await w2.api.processPlan(w2.plan(), T('2026-12-05T15:56:00Z'));
  assert.deepEqual(w2.rec.direct, []); assert.deepEqual(w2.rec.nexo.filter(x => x[0] !== 'mark_paid'), []); assert.equal(w2.inv().status, 'paid');   // pagó a tiempo: nada se suspende (solo se avisa del pago a Nexo)
});

test('salvaguardas del corte real: PayPal caído, pausa, Nexo sin conexión y pago manual', async () => {
  // PayPal no responde en el corte: NO se suspende y se reintenta
  const w = world({ mode: 'live' });
  await w.api.processPlan(w.plan(), T('2026-11-25T12:05:00Z'));
  w.ctl.paypalThrows = true;
  const r = await w.api.processPlan(w.plan(), T('2026-12-05T15:56:00Z'));
  assert.deepEqual(w.rec.direct, []); assert.ok(w.kinds().includes('paypal_unreachable')); assert.match(r.actions.join(' '), /PayPal no respondió/);
  w.ctl.paypalThrows = false;
  await w.api.processPlan(w.plan(), T('2026-12-05T16:10:00Z')); assert.deepEqual(w.rec.direct, [[DT, true]]);       // vuelve PayPal y sigue sin pago: ahora sí

  // Nexo sin conexión: Direct se suspende, Nexo se reintenta en la siguiente corrida
  const w2 = world({ mode: 'live' });
  await w2.api.processPlan(w2.plan(), T('2026-11-25T12:05:00Z')); w2.ctl.nexoThrows = true;
  await w2.api.processPlan(w2.plan(), T('2026-12-05T15:56:00Z'));
  assert.equal(w2.plan().suspended_direct, true); assert.equal(w2.plan().suspended_nexo, false); assert.ok(w2.kinds().includes('suspend_error'));
  w2.ctl.nexoThrows = false; await w2.api.processPlan(w2.plan(), T('2026-12-05T17:00:00Z'));
  assert.equal(w2.plan().suspended_nexo, true); assert.equal(w2.rec.direct.length, 1);                                    // Direct no se repite
});

test('pago manual de un cobro del plan reactiva y las corridas de «watch» solo revisan planes', async () => {
  const w = world({ mode: 'live' });
  await w.api.processPlan(w.plan(), T('2026-11-25T12:05:00Z'));
  await w.api.processPlan(w.plan(), T('2026-12-05T15:56:00Z')); assert.equal(w.plan().suspended_direct, true);
  w.db.T.cobros_invoices[0].id = '11111111-1111-4111-8111-111111111111';
  const r = await w.api.markPaid({ tenantId: 't1' }, '11111111-1111-4111-8111-111111111111');
  assert.match(r.message, /marcado como pagado/);
  assert.equal(w.plan().suspended_direct, false); assert.equal(w.plan().suspended_nexo, false);
  assert.deepEqual(w.rec.direct, [[DT, true], [DT, false]]);
  // runPlans ignora los planes pausados y el resultado no mezcla recordatorios
  w.db.T.cobros_plans[0].active = false; w.db.T.cobros_invoices.length = 0;
  const out = await w.api.runPlans(T('2026-12-25T13:00:00Z')); assert.equal(out.plans, 0); assert.equal(w.db.T.cobros_invoices.length, 0);
});

test('controles del plan: solo root crea/cambia; modo real exige confirmar y estar todo configurado', async () => {
  const w = world();
  const ctx = { tenantId: 't1', userId: 'u1' };
  w.ctl.admin = false;
  await assert.rejects(() => w.api.createPlan(ctx, {}), /Solo el administrador de la plataforma/);
  await assert.rejects(() => w.api.setPlanMode(ctx, PL, { mode: 'live', confirm: 'SUSPENDER' }), /Solo el administrador/);
  await assert.rejects(() => w.api.deletePlan(ctx, PL), /Solo el administrador/);
  w.ctl.admin = true;
  // crear: queda en simulación aunque pidan otra cosa
  w.db.T.direct_tenants.push({ id: DT, name: 'SAVE CONSULTORES SRL' });
  const c = await w.api.createPlan(ctx, { name: 'N', concept: 'C', amount: 210, create_day: 25, due_day: 5, cutoff_time: '11:55', remind_offsets: '5,3,1,0', client_id: CL, direct_tenant_id: DT, nexo_org: 'Save Consultores', mode: 'live' });
  assert.equal(c.plan.mode, 'simulation'); assert.equal(c.plan.currency, 'USD'); assert.ok(w.db.T.cobros_plan_events.some(e => e.kind === 'plan_created'));
  // modo real: confirmación, correo de administración y destinos
  const live = b => w.api.setPlanMode(ctx, PL, b);
  await assert.rejects(() => live({ mode: 'live' }), /SUSPENDER/);
  await assert.rejects(() => live({ mode: 'live', confirm: 'suspender ya' }), /SUSPENDER/);
  w.db.T.cobros_plans[0].notify_email = null; await assert.rejects(() => live({ mode: 'live', confirm: 'SUSPENDER' }), /correo para los avisos de administración/);
  w.db.T.cobros_plans[0].notify_email = 'a@b.co'; w.db.T.cobros_plans[0].direct_tenant_id = null; w.db.T.cobros_plans[0].nexo_org = null;
  await assert.rejects(() => live({ mode: 'live', confirm: 'SUSPENDER' }), /elige la firma de Direct y\/o la empresa de Nexo/);
  w.db.T.cobros_plans[0].direct_tenant_id = DT; w.db.T.cobros_plans[0].nexo_org = 'Save Consultores';
  const ok = await live({ mode: 'live', confirm: ' suspender ' }); assert.match(ok.message, /MODO REAL/); assert.equal(w.plan().mode, 'live');
  assert.ok(w.rec.nexo.some(x => x[0] === 'status'));                                              // comprobó la conexión con Nexo antes de activarse
  await live({ mode: 'simulation' }); assert.equal(w.plan().mode, 'simulation');                  // volver a simulación no pide nada
  // no se borra un plan con accesos suspendidos
  w.db.T.cobros_plans[0].suspended_direct = true; await assert.rejects(() => w.api.deletePlan(ctx, PL), /reactívalos antes/);
  // reactivación manual
  const rr = await w.api.reactivatePlanNow(ctx, PL); assert.match(rr.message, /Direct reactivado/); assert.equal(w.plan().suspended_direct, false);
});

test('cron: «watch» (cada 15 min) y «cutoff» (11:55) solo revisan planes; y la pantalla, la función de Nexo y la documentación existen', async () => {
  const seen = [];
  const stub = (m, exports) => { require.cache[require.resolve(m)] = { id: m, filename: m, loaded: true, exports }; };
  stub('../../lib/auth', { authenticate: async () => null }); stub('../../lib/supabase', { from: () => ({}) });
  stub('../../lib/cobros/api', { runDaily: async o => { seen.push(['daily', o.slot]); return {}; }, runPlansOnly: async () => { seen.push(['plans']); return { plans: {} }; } });
  process.env.CRON_SECRET = 'x'.repeat(24);
  delete require.cache[require.resolve('../../api/cobros')];
  const handler = require('../../api/cobros');
  const run = async slot => { const out = {}; await handler({ method: 'GET', query: { route: 'cron', slot }, headers: { authorization: 'Bearer ' + 'x'.repeat(24) }, body: {} }, { setHeader() {}, status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } }); return out; };
  await run('watch'); await run('cutoff'); await run('2');
  assert.deepEqual(seen, [['plans'], ['plans'], ['daily', 2]]);
  delete require.cache[require.resolve('../../lib/cobros/api')];

  const v = JSON.parse(read('vercel.json'));
  assert.ok(v.crons.some(c => c.path === '/api/cobros/cron?slot=cutoff' && c.schedule === '55 15 * * *'));          // 11:55 a. m. de RD
  assert.ok(v.crons.some(c => c.path === '/api/cobros/cron?slot=watch' && c.schedule === '*/15 * * * *'));
  const ui = read('public/cobros/index.html');
  assert.match(ui, /\['planes','Planes'\]/); assert.match(ui, /function vPlanes/); assert.match(ui, /Pasar a modo REAL/); assert.match(ui, /Escribe SUSPENDER/); assert.match(ui, /Reactivar accesos/);
  const fn = read('supabase/nexo/cobros-license/index.ts');
  assert.match(fn, /x-cobros-secret/); assert.match(fn, /safeEqual/); assert.match(fn, /casa\\s\*labs/i); assert.match(fn, /license_events/);
  assert.match(read('supabase/migrations/202611260001_cobros_planes.sql'), /create table if not exists public\.cobros_plans/);
});

test('cada pago del plan se le avisa a Nexo (para que su regla antigua no suspenda a quien ya pagó) y se reintenta si falla', async () => {
  const w = world();                                                                       // simulación: igual se avisa a Nexo de un pago real
  await w.api.processPlan(w.plan(), T('2026-11-25T12:05:00Z'));
  w.ctl.paypalState = 'paid';
  await w.api.processPlan(w.plan(), T('2026-12-02T13:00:00Z'));                           // pagan antes del límite
  assert.equal(w.inv().status, 'paid');
  const mp = w.rec.nexo.filter(x => x[0] === 'mark_paid');
  assert.equal(mp.length, 1); assert.equal(mp[0][1], 'Save Consultores');
  assert.equal(mp[0][2].paid_period, '2026-11');                                            // ciclo 25-nov → 5-dic = período de Nexo 2026-11 (empieza el día 24)
  assert.ok(w.kinds().includes('nexo_synced'));
  await w.api.processPlan(w.plan(), T('2026-12-02T13:15:00Z')); await w.api.processPlan(w.plan(), T('2026-12-02T13:30:00Z'));
  assert.equal(w.rec.nexo.filter(x => x[0] === 'mark_paid').length, 1);                     // ya avisado: no se repite

  // Nexo caído: queda registrado, se reintenta en la siguiente revisión y entonces se avisa
  const w2 = world(); await w2.api.processPlan(w2.plan(), T('2026-11-25T12:05:00Z'));
  w2.ctl.nexoThrows = true; const orig = w2.rec.nexo.push.bind(w2.rec.nexo);
  w2.ctl.paypalState = 'paid'; await w2.api.processPlan(w2.plan(), T('2026-12-02T13:00:00Z'));
  assert.equal(w2.db.T.cobros_plan_events.filter(e => e.kind === 'nexo_sync_error').length, 1); assert.ok(!w2.kinds().includes('nexo_synced'));
  await w2.api.processPlan(w2.plan(), T('2026-12-02T13:15:00Z')); assert.equal(w2.db.T.cobros_plan_events.filter(e => e.kind === 'nexo_sync_error').length, 1);   // el error no se repite
  w2.ctl.nexoThrows = false; await w2.api.processPlan(w2.plan(), T('2026-12-02T13:30:00Z')); assert.ok(w2.kinds().includes('nexo_synced'));
  // un plan sin empresa de Nexo no llama a Nexo
  const w3 = world({ nexo_org: null }); await w3.api.processPlan(w3.plan(), T('2026-11-25T12:05:00Z')); w3.ctl.paypalState = 'paid'; await w3.api.processPlan(w3.plan(), T('2026-12-02T13:00:00Z'));
  assert.deepEqual(w3.rec.nexo, []);
  // la función de Nexo acepta mark_paid y el modo real de Direct/Nexo sigue exigiendo todo lo anterior
  assert.match(read('supabase/nexo/cobros-license/index.ts'), /mark_paid/);
});

test('Formulario del plan: calendario en una frase con ejemplo y opciones avanzadas', () => {
  const ui = require('fs').readFileSync(require('path').join(__dirname, '../../public/cobros/index.html'), 'utf8');
  assert.match(ui, /de cada mes, y el cliente tiene hasta el día/); assert.match(ui, /id="plan-sum"/); assert.match(ui, /Opciones avanzadas/);
});

test('Correo de administración por defecto en planes nuevos', () => {
  const fs = require('fs'), path = require('path');
  assert.match(fs.readFileSync(path.join(__dirname, '../../lib/cobros/api.js'), 'utf8'), /notify_email: process\.env\.COBROS_ADMIN_EMAIL \|\| 'info@casalabs\.com\.do'/);
  assert.match(fs.readFileSync(path.join(__dirname, '../../public/cobros/index.html'), 'utf8'), /v\('notify_email',df\.notify_email/);
});
