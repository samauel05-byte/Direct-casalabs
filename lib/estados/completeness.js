// Estados Financieros — qué le falta a un informe. Un informe con pendientes BLOQUEANTES no se puede
// aprobar ni cerrar. Función pura: no inventa cifras, solo cuenta y compara lo que se cargó.
const { balanceCheck } = require('./import');
const rules = require('./rules');

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

// data: { entries: [{entry_date, account_code, classification, reference, debit, credit}],
//         assumptions: [...], adjustments: [...], imports: [...] }
function assess(report, data, config) {
  const cfg = config || rules.mergeConfig({});
  const items = [];
  const add = (severity, code, message, extra = {}) => items.push({ severity, code, message, ...extra });
  const entries = data.entries || []; const assumptions = data.assumptions || []; const adjustments = data.adjustments || [];
  const m = report.modality;

  if (!report.client_id) add('blocking', 'EMPRESA', 'El informe no tiene empresa asignada.');
  if (!report.currency) add('blocking', 'MONEDA', 'Falta la moneda del informe.');
  if (!report.period_start || !report.period_end) add('blocking', 'PERIODO', m === 'proyectado' ? 'Falta el período futuro que cubre (inicio y fin).' : 'Faltan las fechas de inicio y de corte del informe.');
  if (m === 'proyectado') {
    if (!report.scenario) add('blocking', 'ESCENARIO', 'Falta el nombre del escenario.');
    if (report.period_end && report.prepared_on && report.period_end <= report.prepared_on) add('warning', 'NO_FUTURO', 'El período indicado no es futuro respecto a la fecha de preparación.');
    if (!assumptions.length) add('blocking', 'SIN_SUPUESTOS', 'No hay supuestos ni valores estimados cargados.');
    const pend = assumptions.filter(a => a.pending);
    if (pend.length) add('blocking', 'SUPUESTOS_PENDIENTES', `${pend.length} supuesto(s) o valor(es) estimado(s) marcados como pendientes de confirmar.`, { count: pend.length });
    const noValue = assumptions.filter(a => a.kind === 'valor_estimado' && !a.pending && (a.amount === null || a.amount === undefined));
    if (noValue.length) add('blocking', 'VALOR_SIN_CIFRA', `${noValue.length} valor(es) estimado(s) sin cifra.`, { count: noValue.length });
    const noDesc = assumptions.filter(a => a.kind === 'valor_estimado' && !a.pending && !String(a.description || '').trim());
    if (noDesc.length) add('blocking', 'VALOR_SIN_DESCRIPCION', `${noDesc.length} valor(es) estimado(s) sin descripción.`, { count: noDesc.length });
    add('info', 'FORMULAS_PENDIENTES', 'Las fórmulas, supuestos y datos base de proyección todavía no están definidos por Contabilidad: este módulo NO calcula proyecciones; muestra solo las cifras que usted cargó.');
  } else {
    if (!entries.length) add('blocking', 'SIN_INFORMACION', 'No hay información contable cargada.');
    if (entries.length) {
      const dates = entries.map(e => e.entry_date).filter(Boolean).sort();
      const through = dates[dates.length - 1];
      if (report.period_end && through && through < report.period_end) add('blocking', 'INFO_INCOMPLETA', `La información llega hasta ${through}, antes de la fecha de corte ${report.period_end}.`, { through });
      const withCls = entries.filter(e => e.classification).length;
      if (withCls > 0 && withCls < entries.length) add('blocking', 'SIN_CLASIFICAR', `${entries.length - withCls} registro(s) sin clasificación contable.`, { count: entries.length - withCls });
      if (withCls === 0) add('warning', 'CLASIFICACION_NO_SUMINISTRADA', 'Ningún registro trae clasificación contable (pendiente de Contabilidad).');
      const allRows = [...entries, ...adjustments.map(a => ({ reference: a.reference, debit: a.debit, credit: a.credit }))];
      const bal = balanceCheck(allRows, { rule: cfg.balance_rule, tolerance: cfg.balance_tolerance });
      if (!bal.applied) add('warning', 'CUADRE_NO_DEFINIDO', 'La regla de cuadre de débitos y créditos no está definida; no se validó el cuadre.');
      else {
        if (!bal.ok) add('blocking', 'DESCUADRE', bal.rule === 'global'
          ? `Descuadre global: débitos ${bal.issues[0].debit} y créditos ${bal.issues[0].credit} (diferencia ${bal.issues[0].diff}).`
          : `${bal.issues.length} asiento(s) descuadrados (por ejemplo ${bal.issues.slice(0, 3).map(i => `${i.reference}: ${i.diff}`).join(', ')}).`, { issues: bal.issues.slice(0, 50) });
        if (bal.rule === 'por_asiento' && bal.without_reference) add('warning', 'SIN_REFERENCIA', `${bal.without_reference} registro(s) sin referencia/asiento: no se puede validar su cuadre.`);
        if (!cfg.balance_rule_confirmed) add('info', 'REGLA_PROVISIONAL', 'La regla de cuadre aplicada es provisional hasta que Contabilidad la confirme.');
      }
    }
    if (m === 'anual') {
      if (!report.fiscal_year) add('blocking', 'ANO_FISCAL', 'Falta el año fiscal.');
      if (!adjustments.some(a => a.kind === 'cierre')) add('warning', 'SIN_AJUSTES_CIERRE', 'No hay ajustes de cierre registrados (confirmar con Contabilidad si aplican).');
    }
  }
  // Documentos que forman parte de la modalidad (los define Contabilidad).
  const docs = Array.isArray(report.documents) ? report.documents : [];
  const required = docs.filter(d => d.required !== false);
  const missingDocs = required.filter(d => d.status !== 'incluido');
  if (missingDocs.length) add('blocking', 'DOCUMENTOS_PENDIENTES', `Documentos pendientes: ${missingDocs.map(d => d.label).join(', ')}.`, { count: missingDocs.length });
  if (!cfg.documents[m]?.length && !docs.length) add('info', 'DOCUMENTOS_SIN_DEFINIR', 'Los documentos de esta modalidad (balance, resultados, flujos…) aún no los define Contabilidad.');
  const blocking = items.filter(i => i.severity === 'blocking');
  return { items, blocking: blocking.length, warnings: items.filter(i => i.severity === 'warning').length, complete: blocking.length === 0 };
}

// Resumen por cuenta: movimientos reales sumados (sin interpretarlos). Los ajustes van aparte.
function accountSummary(entries, adjustments = []) {
  const map = new Map();
  const bucket = (code, name) => map.get(code) || map.set(code, { account_code: code, account_name: name || null, debit: 0, credit: 0, adj_debit: 0, adj_credit: 0, entries: 0, classification: null }).get(code);
  for (const e of entries) { const b = bucket(e.account_code, e.account_name); b.debit += Number(e.debit || 0); b.credit += Number(e.credit || 0); b.entries++; if (!b.account_name && e.account_name) b.account_name = e.account_name; if (e.classification) b.classification = e.classification; }
  for (const a of adjustments) { const b = bucket(a.account_code, a.account_name); b.adj_debit += Number(a.debit || 0); b.adj_credit += Number(a.credit || 0); }
  return [...map.values()].map(b => ({ ...b, debit: r2(b.debit), credit: r2(b.credit), adj_debit: r2(b.adj_debit), adj_credit: r2(b.adj_credit),
    net: r2(b.debit - b.credit), net_with_adjustments: r2(b.debit + b.adj_debit - b.credit - b.adj_credit) })).sort((a, b) => a.account_code.localeCompare(b.account_code, 'es', { numeric: true }));
}

module.exports = { assess, accountSummary };
