/* Estados Financieros — motor de los estados (Situación Financiera, Resultados y Flujo de Efectivo).
   Isomórfico: lo usa el servidor (lib/estados) y el navegador (cálculo en vivo al editar). Solo hace las
   sumas y restas que muestra el modelo de Contabilidad (los totales); NUNCA inventa los valores de las líneas:
   esos los entrega Contabilidad (a mano o desde su Excel). Estructura tomada de «ESTADOS FINANCIEROS
   PROYECTADOS» de ACINGENIERIA SRL (Save Consultores). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.EFStatements = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const MONTH_NAMES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const MONTH_ABBR = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  // Tipos de línea: head/subhead (títulos), input (la entrega Contabilidad), sum (suma de `sum`), calc (`add`/`sub`),
  // link (viene de otro estado), roll (el inicio de un mes es el final del anterior), running (acumulado de otra línea).
  // `annual`: cómo se obtiene la columna anual de una línea de entrada: last | first | sum | manual.
  const ESF = {
    key: 'esf', title: 'ESTADO DE SITUACIÓN FINANCIERA', short: 'Situación financiera', aliases: ['situacion financiera', 'balance general', 'estado de situacion', 'esf', 'balance'], annual: 'last',
    lines: [
      { k: 'h_act', t: 'head', label: 'ACTIVOS' },
      { k: 'efectivo', t: 'input', label: 'Efectivo en caja y banco', aliases: ['efectivo en caja', 'efectivo en caja y banco', 'efectivo', 'caja y banco'] },
      { k: 'cxc', t: 'input', label: 'Cuentas por cobrar', aliases: ['cuentas por cobrar'] },
      { k: 'obras', t: 'input', label: 'Obras en Proceso', aliases: ['obras en proceso'] },
      { k: 't_act_cte', t: 'sum', label: 'TOTAL ACTIVOS CORRIENTES', aliases: ['total de activo corriente', 'total activo corriente', 'total activos corrientes'], sum: ['efectivo', 'cxc', 'obras'], strong: true },
      { k: 't_act', t: 'sum', label: 'TOTAL DE ACTIVOS', aliases: ['activos totales', 'total de activos', 'total activos'], sum: ['t_act_cte'], strong: true, grand: true },
      { k: 'h_pp', t: 'head', label: 'PASIVOS Y PATRIMONIO' },
      { k: 'h_pc', t: 'subhead', label: 'Pasivos corrientes:' },
      { k: 'acreedores', t: 'input', label: 'Acreedores Diversos', aliases: ['acreedores diversos'] },
      { k: 'cxp_accionistas', t: 'input', label: 'CXP Accionistas', aliases: ['cxp accionistas', 'cuentas por pagar accionistas'] },
      { k: 'avance_clientes', t: 'input', label: 'Avance de Clientes', aliases: ['avance de clientes'] },
      { k: 't_pas_cte', t: 'sum', label: 'TOTAL DE PASIVOS CORRIENTES', aliases: ['pasivos totales', 'total pasivos corrientes', 'total de pasivos corrientes'], sum: ['acreedores', 'cxp_accionistas', 'avance_clientes'], strong: true },
      { k: 't_pas', t: 'sum', label: 'TOTAL DE PASIVOS', aliases: ['total pasivos', 'total de pasivos'], sum: ['t_pas_cte'], strong: true, grand: true },
      { k: 'h_pat', t: 'head', label: 'PATRIMONIO' },
      { k: 'capital', t: 'input', label: 'Capital Social', aliases: ['capital social', 'capital'] },
      { k: 'acumulados', t: 'input', label: 'Resultados acumulados', aliases: ['resultados acumulados'], annual: 'first' },
      { k: 'res_periodo', t: 'link', label: 'Resultados Del Período', aliases: ['resultados del periodo', 'resultado del periodo'], link: ['er', 'resultado'], linkOptional: true },
      { k: 't_pat', t: 'sum', label: 'TOTAL PATRIMONIO', aliases: ['total patrimonio', 'total de patrimonio'], sum: ['capital', 'acumulados', 'res_periodo'], strong: true },
      { k: 't_pp', t: 'sum', label: 'TOTAL DE PASIVOS Y PATRIMONIO', aliases: ['total pasivos y patrimonio', 'total de pasivos y patrimonio'], sum: ['t_pas', 't_pat'], strong: true, grand: true },
    ],
  };
  const ER = {
    key: 'er', title: 'ESTADO DE RESULTADOS', short: 'Resultados', aliases: ['resultados', 'estado de resultado', 'estado de resultados', 'er'], annual: 'sum',
    lines: [
      { k: 'h_ing', t: 'head', label: 'INGRESOS' },
      { k: 'ing_ventas', t: 'input', label: 'Ingresos Por Actividades Comerciales', aliases: ['ingresos por actividades comerciales', 'ingresos por ventas', 'ventas'] },
      { k: 't_ingresos', t: 'sum', label: 'Ingresos Por Actividades Comerciales Netos', aliases: ['ingresos por actividades comerciales netos', 'total ingresos', 'total de ingresos'], sum: ['ing_ventas'], strong: true },
      { k: 'h_costo', t: 'head', label: 'COSTO DE VENTA' },
      { k: 'mano_obra', t: 'input', label: 'Mano de Obra', aliases: ['mano de obra'] },
      { k: 'costos_directos', t: 'input', label: 'Costos Directos', aliases: ['costos directos'] },
      { k: 'costos_indirectos', t: 'input', label: 'Costos Indirectos', aliases: ['costos indirectos'] },
      { k: 'supervision', t: 'input', label: 'Supervisión Técnica', aliases: ['supervision tecnica'] },
      { k: 't_costo', t: 'sum', label: 'Costo de Venta por Actividad Comercial', aliases: ['costo de venta por actividad comercial', 'total costo de venta', 'costo de venta'], sum: ['mano_obra', 'costos_directos', 'costos_indirectos', 'supervision'], strong: true },
      { k: 'margen', t: 'calc', label: 'MARGEN DE VENTAS', aliases: ['margen de ventas', 'utilidad bruta'], sub: ['t_ingresos', 't_costo'], strong: true, grand: true },
      { k: 'h_egr', t: 'head', label: 'EGRESOS', aliases: ['gastos generales y administrativos'] },
      { k: 'sueldos', t: 'input', label: 'Gasto de Sueldos y Salarios', aliases: ['gasto de sueldos y salarios', 'sueldos y salarios'] },
      { k: 'vacaciones', t: 'input', label: 'Gasto de Vacaciones', aliases: ['gasto de vacaciones', 'vacaciones'] },
      { k: 'regalia', t: 'input', label: 'Gasto de Regalia Pascual', aliases: ['gasto de regalia pascual', 'regalia pascual'] },
      { k: 'tss', t: 'input', label: 'Gasto de Tesoreria de Seguridad Social', aliases: ['gasto de tesoreria de seguridad social', 'tesoreria de seguridad social'] },
      { k: 'infotep', t: 'input', label: 'Gasto de Infotep', aliases: ['gasto de infotep', 'infotep'] },
      { k: 'representacion', t: 'input', label: 'Gastos de Representacion', aliases: ['gastos de representacion'] },
      { k: 'serv_trabajos', t: 'input', label: 'Gastos por Servicios Trabajos y Suministros', aliases: ['gastos por servicios trabajos y suministros'] },
      { k: 'financieros', t: 'input', label: 'Gastos Financieros', aliases: ['gastos financieros'] },
      { k: 'serv_prof', t: 'input', label: 'Gastos Por Servicios Profesionales', aliases: ['gastos por servicios profesionales'] },
      { k: 'combustible', t: 'input', label: 'Gasto de Combustible', aliases: ['gasto de combustible', 'combustible'] },
      { k: 't_egresos', t: 'sum', label: 'Total de Egresos', aliases: ['total de egresos', 'total de gastos generales y adm', 'total de gastos generales y administrativos'], sum: ['sueldos', 'vacaciones', 'regalia', 'tss', 'infotep', 'representacion', 'serv_trabajos', 'financieros', 'serv_prof', 'combustible'], strong: true },
      { k: 'resultado', t: 'calc', label: 'RESULTADOS DEL PERIODO', aliases: ['resultados del periodo', 'resultado operativo', 'resultado del periodo'], sub: ['margen', 't_egresos'], strong: true, grand: true },
      { k: 'resultado_acum', t: 'running', label: 'Resultado Operativo Acumulado', aliases: ['resultado operativo acumulado'], running: 'resultado', monthlyOnly: true },
    ],
  };
  const EFE = {
    key: 'efe', title: 'FLUJO DE EFECTIVO', short: 'Flujo de efectivo', aliases: ['flujo de efectivo', 'flujo', 'efe'], annual: 'manual',
    lines: [
      { k: 'resultado', t: 'link', label: 'Resultado del Año', labelMonthly: 'Resultado del Período', aliases: ['resultado del ano', 'resultado del periodo'], link: ['er', 'resultado'], strong: true },
      { k: 'h_noafecta', t: 'head', label: 'Actividades que no Afectan el Efectivo' },
      { k: 'depreciacion', t: 'input', label: 'Depreciación', aliases: ['depreciacion'] },
      { k: 'res_anteriores', t: 'input', label: 'Resultado de periodos anteriores', aliases: ['resultado de periodos anteriores'] },
      { k: 't_noafecta', t: 'sum', label: 'Total Actividades que no Afectan el Efectivo', aliases: ['total actividades que no afectan el efectivo'], sum: ['depreciacion', 'res_anteriores'], strong: true },
      { k: 'h_oper', t: 'head', label: 'Cambios en Partidas Operacionales' },
      { k: 'h_cxc', t: 'subhead', label: 'Cambios en las Cuentas Por Cobrar' },
      { k: 'cc_cxc', t: 'input', label: 'Cambios en las Cuentas Por Cobrar', aliases: ['cambios en las cuentas por cobrar'], noHeadAlias: true },
      { k: 'cc_inventario', t: 'input', label: 'Cambios en Inventario', aliases: ['cambios en inventario'] },
      { k: 'cc_cxc_accionistas', t: 'input', label: 'Cambios en Cuentas por Cobrar a Accionistas', aliases: ['cambios en cuentas por cobrar a accionistas'] },
      { k: 'cc_clientes', t: 'input', label: 'Cambios en las Cuentas de Clientes', aliases: ['cambios en las cuentas de clientes'] },
      { k: 'h_cxp', t: 'subhead', label: 'Cambios en las Cuentas Por Pagar' },
      { k: 'cp_acreedores', t: 'input', label: 'Cambios en los Acreedores Diversos', aliases: ['cambios en los acreedores diversos'] },
      { k: 'cp_accionistas', t: 'input', label: 'Cambios en Cuentas por Pagar a Accionistas', aliases: ['cambios en cuentas por pagar a accionistas'] },
      { k: 'cp_impuestos', t: 'input', label: 'Impuestos Por Pagar', aliases: ['impuestos por pagar'] },
      { k: 't_cambios', t: 'sum', label: 'Total Cambios en Partidas Operacionales', aliases: ['total cambios en partidas operacionales'], sum: ['cc_cxc', 'cc_inventario', 'cc_cxc_accionistas', 'cc_clientes', 'cp_acreedores', 'cp_accionistas', 'cp_impuestos'], strong: true },
      { k: 'flujo_ops', t: 'calc', label: 'Flujo neto de efectivo en operaciones:', aliases: ['flujo neto de efectivo en operaciones'], add: ['resultado', 't_noafecta', 't_cambios'], strong: true, grand: true },
      { k: 'h_inv', t: 'head', label: 'Efectivo Para Actividades de Inversión:' },
      { k: 'inv_fijos', t: 'input', label: 'Variación en Activos Fijos', aliases: ['variacion en activos fijos'] },
      { k: 'inv_anticipos', t: 'input', label: 'Variación en Anticipos al Impuesto', aliases: ['variacion en anticipos al impuesto', 'variacion en anticipos al impuesto'] },
      { k: 'inv_fianzas', t: 'input', label: 'Variación en Las Fianzas y Depósitos', aliases: ['variacion en las fianzas y depositos'] },
      { k: 'inv_empresas', t: 'input', label: 'Inversiones en Empresas', aliases: ['inversiones en empresas'] },
      { k: 't_inversion', t: 'sum', label: 'Total Efectivo Para Actividades de Inversión:', aliases: ['total efectivo para actividades de inversion'], sum: ['inv_fijos', 'inv_anticipos', 'inv_fianzas', 'inv_empresas'], strong: true },
      { k: 'h_fin', t: 'head', label: 'Efectivo Recibido Por Financiamiento:' },
      { k: 'fin_aportes', t: 'input', label: 'Variación en Aportes de Accionistas', aliases: ['variacion en aportes de accionistas'] },
      { k: 'fin_cxp_cp', t: 'input', label: 'Variación en las Cuentas Por Pagar C/P', aliases: ['variacion en las cuentas por pagar c p', 'variacion en las cuentas por pagar cp'] },
      { k: 'fin_cxp_lp', t: 'input', label: 'Variación en las Cuentas Por Pagar L/P', aliases: ['variacion en las cuentas por pagar l p', 'variacion en las cuentas por pagar lp'] },
      { k: 't_financiamiento', t: 'sum', label: 'Total Efectivo Recibido Por Financiamiento:', aliases: ['total efectivo recibido por financiamiento'], sum: ['fin_aportes', 'fin_cxp_cp', 'fin_cxp_lp'], strong: true },
      { k: 'aumento', t: 'calc', label: 'Aumento o Disminución del Efectivo', aliases: ['aumento o disminucion del efectivo'], add: ['flujo_ops', 't_inversion', 't_financiamiento'], strong: true, grand: true },
      { k: 'ef_inicio', t: 'roll', label: 'Efectivo y Equivalentes al Inicio del Año', labelMonthly: 'Efectivo y Equivalentes al Inicio del Período', aliases: ['efectivo y equivalentes al inicio del ano', 'efectivo y equivalentes al inicio del periodo'], rollFrom: 'ef_final', strong: true },
      { k: 'ef_final', t: 'calc', label: 'Efectivo Disponible al Final del Período', aliases: ['efectivo disponible al final del periodo'], add: ['ef_inicio', 'aumento'], strong: true, grand: true },
    ],
  };
  const STATEMENTS = { esf: ESF, er: ER, efe: EFE };
  const ORDER = ['esf', 'er', 'efe'];

  // Meses de las columnas: desde el inicio del período, hasta 12.
  function monthsFor(start, end) {
    const s = /^(\d{4})-(\d{2})-\d{2}$/.exec(start || ''); const e = /^(\d{4})-(\d{2})-\d{2}$/.exec(end || '');
    if (!s || !e) return [];
    let y = Number(s[1]); let m = Number(s[2]); const out = [];
    while ((y < Number(e[1]) || (y === Number(e[1]) && m <= Number(e[2]))) && out.length < 24) {
      out.push({ idx: out.length + 1, year: y, month: m, label: MONTH_NAMES[m - 1].toUpperCase(), key: `${y}-${String(m).padStart(2, '0')}` });
      m++; if (m > 12) { m = 1; y++; }
    }
    return out;
  }

  // Plantilla con las líneas propias (custom) de un informe insertadas dentro de la sección que sumarán.
  // custom: [{statement, key, label, parent}] — `parent` es el total (sum) al que se agregan.
  function template(statement, customs = []) {
    const base = STATEMENTS[statement];
    const lines = base.lines.map(l => ({ ...l, sum: l.sum ? [...l.sum] : undefined }));
    for (const c of customs.filter(x => x.statement === statement)) {
      const parent = lines.find(l => l.k === c.parent && l.t === 'sum');
      if (!parent || lines.some(l => l.k === c.key)) continue;
      const lastChild = Math.max(...parent.sum.map(k => lines.findIndex(l => l.k === k)));
      lines.splice(lastChild + 1, 0, { k: c.key, t: 'input', label: c.label, aliases: [norm(c.label)], custom: true, parent: c.parent });
      parent.sum.push(c.key);
    }
    return { ...base, lines };
  }

  function annualOf(line, tplAnnual, vals, n) {
    const how = line.annual || tplAnnual;
    const get = m => (vals[m] == null ? 0 : Number(vals[m]));
    if (how === 'manual') return vals[0] == null ? null : Number(vals[0]);
    const any = Array.from({ length: n }, (_, i) => vals[i + 1]).some(v => v != null);
    if (!any) return null;
    if (how === 'sum') return r2(Array.from({ length: n }, (_, i) => get(i + 1)).reduce((a, b) => a + b, 0));
    if (how === 'first') return vals[1] == null ? 0 : Number(vals[1]);
    return vals[n] == null ? 0 : Number(vals[n]); // last
  }

  // values: { statement: { key: { 0: anual(manual), 1: ene, … } } } → { statement: { key: { 0: …, 1: … } } } (solo montos; null = sin dato)
  function compute(values, n, customs = []) {
    const out = { er: {}, esf: {}, efe: {} };
    const order = ['er', 'esf', 'efe'];
    for (const st of order) {
      const tpl = template(st, customs); const res = out[st]; const vals = (values && values[st]) || {};
      // Primero los meses y al final la columna anual (varias líneas anuales salen de los meses).
      for (const m of [...Array.from({ length: n }, (_, i) => i + 1), 0]) {
        for (const l of tpl.lines) {
          if (l.t === 'head' || l.t === 'subhead') continue;
          res[l.k] = res[l.k] || {};
          let v = null;
          const pick = k => (res[k] && res[k][m] != null ? res[k][m] : null);
          if (l.t === 'input') {
            if (m === 0) v = annualOf(l, tpl.annual, (vals[l.k] || {}), n);
            else v = (vals[l.k] && vals[l.k][m] != null) ? Number(vals[l.k][m]) : null;
          } else if (l.t === 'link') {
            const [ost, ok] = l.link; v = out[ost] && out[ost][ok] ? out[ost][ok][m] ?? null : null;
            if (v == null && l.linkOptional && vals[l.k] && vals[l.k][m] != null) v = Number(vals[l.k][m]);
          } else if (l.t === 'sum') {
            const parts = l.sum.map(pick); v = parts.every(p => p == null) ? null : r2(parts.reduce((a, p) => a + (p || 0), 0));
          } else if (l.t === 'calc') {
            if (l.sub) { const [a, b] = l.sub.map(pick); v = a == null && b == null ? null : r2((a || 0) - (b || 0)); }
            if (l.add) { const parts = l.add.map(pick); v = parts.every(p => p == null) ? null : r2(parts.reduce((a, p) => a + (p || 0), 0)); }
          } else if (l.t === 'running') {
            if (m === 0) v = res[l.running] ? res[l.running][0] ?? null : null;
            else { let acc = 0; let any = false; for (let i = 1; i <= m; i++) { const x = res[l.running] && res[l.running][i]; if (x != null) { acc += x; any = true; } } v = any ? r2(acc) : null; }
          } else if (l.t === 'roll') {
            if (m === 0) v = res[l.k][1] ?? null;
            else if (m === 1) v = (vals[l.k] && vals[l.k][1] != null) ? Number(vals[l.k][1]) : null;
            else v = res[l.rollFrom] && res[l.rollFrom][m - 1] != null ? res[l.rollFrom][m - 1] : ((vals[l.k] && vals[l.k][m] != null) ? Number(vals[l.k][m]) : null);
          }
          res[l.k][m] = v == null ? null : r2(v);
        }
      }
    }
    return out;
  }

  const TOL = 0.05;
  // Validaciones entre estados (las relaciones del modelo de Contabilidad). severity: blocking | warning | info
  function checks(computed, values, n, months) {
    const items = []; const lab = m => (m === 0 ? 'el total anual' : months[m - 1]?.label || `mes ${m}`);
    const esf = computed.esf; const er = computed.er; const efe = computed.efe;
    const hasAny = st => Object.values(values?.[st] || {}).some(o => Object.values(o || {}).some(v => v != null));
    if (hasAny('esf')) {
      const bad = [];
      for (let m = 0; m <= n; m++) { const a = esf.t_act[m]; const p = esf.t_pp[m]; if (a == null && p == null) continue; if (Math.abs((a || 0) - (p || 0)) > TOL) bad.push(`${lab(m)} (activos ${a ?? 0} ≠ pasivos+patrimonio ${p ?? 0})`); }
      if (bad.length) items.push({ severity: 'blocking', code: 'BALANCE_DESCUADRADO', message: `El Estado de Situación Financiera no cuadra: ${bad.slice(0, 4).join('; ')}${bad.length > 4 ? ` y ${bad.length - 4} más` : ''}.` });
      const bad2 = [];
      for (let m = 1; m <= n; m++) { const v = values.esf && values.esf.res_periodo && values.esf.res_periodo[m]; const e = er.resultado[m]; if (v != null && e != null && Math.abs(v - e) > TOL) bad2.push(lab(m)); }
      if (bad2.length) items.push({ severity: 'warning', code: 'RESULTADO_NO_COINCIDE', message: `«Resultados del período» del balance no coincide con el Estado de Resultados en: ${bad2.slice(0, 6).join(', ')}.` });
    }
    if (hasAny('efe') && hasAny('esf')) {
      const bad = [];
      for (let m = 1; m <= n; m++) { const f = efe.ef_final[m]; const c = esf.efectivo[m]; if (f != null && c != null && Math.abs(f - c) > TOL) bad.push(lab(m)); }
      if (bad.length) items.push({ severity: 'warning', code: 'EFECTIVO_NO_COINCIDE', message: `El efectivo final del Flujo de Efectivo no coincide con «Efectivo en caja y banco» del balance en: ${bad.slice(0, 6).join(', ')}.` });
    }
    for (const st of ORDER) {
      if (!hasAny(st)) continue;
      const empty = []; for (let m = 1; m <= n; m++) { const any = STATEMENTS[st].lines.some(l => l.t === 'input' && values[st] && values[st][l.k] && values[st][l.k][m] != null); if (!any) empty.push(lab(m)); }
      if (empty.length) items.push({ severity: 'warning', code: `MESES_SIN_DATOS_${st.toUpperCase()}`, message: `${STATEMENTS[st].short}: sin cifras en ${empty.slice(0, 6).join(', ')}${empty.length > 6 ? '…' : ''}.` });
    }
    return items;
  }

  // Reconocimiento de etiquetas de una fila de Excel contra las líneas de un estado.
  function matchLabel(statement, label, customs = []) {
    const want = norm(label); if (!want) return null;
    const tpl = template(statement, customs);
    return tpl.lines.find(l => l.t !== 'head' && l.t !== 'subhead' && (norm(l.label) === want || (l.labelMonthly && norm(l.labelMonthly) === want) || (l.aliases || []).some(a => norm(a) === want))) || null;
  }
  function detectStatement(sheetName) {
    const s = norm(sheetName);
    for (const k of ORDER) if (STATEMENTS[k].aliases.some(a => s.includes(norm(a)) && norm(a).length > 3)) return k;
    if (/resultado/.test(s)) return 'er'; if (/situacion|balance/.test(s)) return 'esf'; if (/flujo/.test(s)) return 'efe';
    return null;
  }
  function monthFromHeader(text) {
    const s = norm(text); if (!s) return null;
    let i = MONTH_NAMES.indexOf(s); if (i < 0) i = MONTH_ABBR.indexOf(s.slice(0, 3)) >= 0 && s.length <= 4 ? MONTH_ABBR.indexOf(s.slice(0, 3)) : -1;
    return i >= 0 ? i + 1 : null;
  }

  return { STATEMENTS, ORDER, MONTH_NAMES, monthsFor, template, compute, checks, matchLabel, detectStatement, monthFromHeader, norm, r2, TOL };
});
