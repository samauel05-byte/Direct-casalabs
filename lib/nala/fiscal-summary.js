// Resumen del 606/607 que NALA audita, para Estimación Fiscal.
//
// Dada una empresa (por RNC/cédula) y un año devuelve, SOLO de lo aprobado en NALA:
//  - meses: por período y formato, comprobantes aprobados / pendientes, totales en
//    pesos (base, ITBIS, retenciones), si la auditoría está completa y el último
//    archivo generado/enviado (estado, fecha, referencia de la DGII);
//  - gastos: las compras (606) aprobadas del año agrupadas por tipo de bienes y
//    servicios (lo que alimenta «Gastos NCF» y el Anexo J);
//  - resumen: totales por formato y cuántos meses tienen la auditoría completa.
// Lee, no escribe nada. Aislado por tenant. Los montos van en pesos con 2 decimales.
const supabase = require('../supabase');
const rules = require('./rules');
const ids = require('./ids');
const { dopAmount } = require('./validate');

const toCents = v => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
const fixed = c => (c / 100).toFixed(2);
const OPEN = ['pending_review', 'reviewed'];

function tipoCode(value) {
  const m = String(value ?? '').trim().match(/^\d{1,2}/);
  return m ? m[0].padStart(2, '0') : null;
}

async function summarize({ tenantId, rnc, anio }) {
  const digits = ids.digitsOnly(rnc);
  const year = Number(anio);
  if (!digits) throw Object.assign(new Error('RNC requerido'), { status: 400 });
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw Object.assign(new Error('Año inválido'), { status: 400 });

  // Empresa de NALA con ese RNC/cédula (se prefiere la activa).
  const { data: clients, error: ce } = await supabase.from('direct_clients').select('id, legal_name, rnc, cedula, status').eq('tenant_id', tenantId);
  if (ce) throw ce;
  const matches = (clients || []).filter(c => ids.digitsOnly(c.rnc) === digits || ids.digitsOnly(c.cedula) === digits);
  const client = matches.find(c => c.status !== 'inactive') || matches[0] || null;
  if (!client) return { client: null, anio: year, meses: [], gastos: [], resumen: {} };

  const from = `${year}01`; const to = `${year}12`;
  const base = (table, cols) => supabase.from(table).select(cols).eq('tenant_id', tenantId).eq('client_id', client.id).gte('period', from).lte('period', to);
  const [approved, open, exps] = await Promise.all([
    base('nala_invoices', 'period, format, subtotal_dop, itbis_dop, fields').eq('status', 'approved').limit(70000),
    base('nala_invoices', 'period, format').in('status', OPEN).limit(70000),
    base('nala_exports', 'id, period, format, status, line_count, submitted_at, submission_reference, created_at').eq('scope', 'period').neq('status', 'superseded').order('created_at', { ascending: false }).limit(2000),
  ]);
  for (const r of [approved, open, exps]) if (r.error) throw r.error;

  const months = new Map();
  const slot = (format, period) => {
    const key = `${format}|${period}`;
    if (!months.has(key)) months.set(key, { period, format, aprobados: 0, pendientes: 0, monto: 0, itbis: 0, itbis_retenido: 0, isr_retenido: 0, export: null });
    return months.get(key);
  };
  const tipos = new Map();
  for (const inv of approved.data || []) {
    const m = slot(inv.format, inv.period);
    const f = inv.fields || {};
    m.aprobados += 1; m.monto += toCents(inv.subtotal_dop); m.itbis += toCents(inv.itbis_dop);
    m.itbis_retenido += toCents(dopAmount(inv.format, f, 'itbis_retenido'));
    m.isr_retenido += toCents(dopAmount(inv.format, f, 'isr_retenido'));
    if (inv.format === '606') {
      const code = tipoCode(f.tipo_bienes_servicios) || 'ND';
      const t = tipos.get(code) || { code, monto: 0, cantidad_ncf: 0 };
      t.monto += toCents(inv.subtotal_dop); t.cantidad_ncf += 1; tipos.set(code, t);
    }
  }
  for (const inv of open.data || []) slot(inv.format, inv.period).pendientes += 1;
  for (const e of exps.data || []) {
    const m = months.get(`${e.format}|${e.period}`);
    if (m && !m.export) m.export = { id: e.id, estado: e.status, registros: e.line_count, fecha_envio: e.submitted_at, referencia: e.submission_reference, generado: e.created_at };
  }

  const meses = [...months.values()].sort((a, b) => a.period.localeCompare(b.period) || a.format.localeCompare(b.format)).map(m => ({
    period: m.period, format: m.format, aprobados: m.aprobados, pendientes: m.pendientes,
    total_monto: fixed(m.monto), itbis: fixed(m.itbis), itbis_retenido: fixed(m.itbis_retenido), isr_retenido: fixed(m.isr_retenido),
    auditoria: m.pendientes > 0 ? 'en_proceso' : (m.aprobados > 0 ? 'completa' : 'sin_aprobados'), export: m.export,
  }));

  const catalog = rules.CURRENT.tipoBienesServicios || {};
  const gastos = [...tipos.values()].sort((a, b) => a.code.localeCompare(b.code))
    .map(t => ({ codigo: t.code, tipo_gasto: t.code === 'ND' ? 'Sin clasificar' : `${t.code} - ${catalog[t.code] || 'Sin clasificar'}`, monto: fixed(t.monto), cantidad_ncf: t.cantidad_ncf }));

  const resumen = {};
  for (const format of ['606', '607']) {
    const rows = meses.filter(m => m.format === format);
    resumen[format] = {
      aprobados: rows.reduce((s, m) => s + m.aprobados, 0), pendientes: rows.reduce((s, m) => s + m.pendientes, 0),
      total_monto: fixed(rows.reduce((s, m) => s + toCents(m.total_monto), 0)), itbis: fixed(rows.reduce((s, m) => s + toCents(m.itbis), 0)),
      meses_completos: rows.filter(m => m.auditoria === 'completa').length, meses_en_proceso: rows.filter(m => m.auditoria === 'en_proceso').length,
    };
  }
  return { client: { id: client.id, nombre: client.legal_name, rnc: client.rnc || client.cedula || '' }, anio: year, meses, gastos, resumen };
}

module.exports = { summarize };
