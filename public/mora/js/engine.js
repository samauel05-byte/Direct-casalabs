/* Intereses moratorios — motor de cálculo. Isomórfico (navegador y pruebas).
   Interés COMPUESTO mes a mes y ACUMULATIVO: cada mes se calcula sobre el saldo del mes anterior
   (capital + intereses ya acumulados). Modo «simple» disponible para comparar. Cada interés mensual se
   redondea a centavos (igual que ROUND(...,2) en la plantilla de Excel). NO inventa tasas: la tasa mensual la da
   quien calcula (por defecto 1.10 %, la del interés indemnizatorio del Código Tributario; verifique la vigente). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.Mora = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const DAY = 86400000;
  function parseDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? d : null;
  }
  const fmt = d => d.toISOString().slice(0, 10);
  // Suma k meses a una fecha sin arrastrar el día (31 ene + 1 mes = 28/29 feb; + 2 meses = 31 mar).
  function addMonths(d, k) {
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + k, day = d.getUTCDate();
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(day, last)));
  }
  const days = (a, b) => Math.round((b - a) / DAY);

  // opts: { capital, tasa (% mensual), desde 'AAAA-MM-DD', hasta 'AAAA-MM-DD', modo 'compuesto'|'simple',
  //         fraccion 'completo' (mes o fracción = mes completo) | 'prorrata' (días/días del mes), recargos (bool) }
  function calcular(opts) {
    const capital = Number(opts.capital), tasa = Number(opts.tasa);
    const desde = parseDate(opts.desde), hasta = parseDate(opts.hasta);
    const modo = opts.modo === 'simple' ? 'simple' : 'compuesto';
    const fraccion = opts.fraccion === 'prorrata' ? 'prorrata' : 'completo';
    const errores = [];
    if (!Number.isFinite(capital) || capital <= 0) errores.push('Escribe el monto adeudado (mayor que cero).');
    if (!Number.isFinite(tasa) || tasa < 0) errores.push('Escribe la tasa mensual (0 o más).');
    if (!desde) errores.push('La fecha de inicio no es válida.');
    if (!hasta) errores.push('La fecha de cálculo no es válida.');
    if (desde && hasta && hasta <= desde) errores.push('La fecha de cálculo debe ser posterior a la de inicio.');
    if (errores.length) return { errores };
    const rate = tasa / 100;
    const rows = [];
    let saldo = r2(capital), acumulado = 0;
    for (let k = 1; ; k++) {
      const ini = addMonths(desde, k - 1), fin = addMonths(desde, k);
      if (ini >= hasta) break;
      const completo = fin <= hasta;
      const diasPeriodo = days(ini, fin), diasUsados = completo ? diasPeriodo : days(ini, hasta);
      const factor = completo || fraccion === 'completo' ? 1 : diasUsados / diasPeriodo;
      const base = modo === 'compuesto' ? saldo : r2(capital);
      const interes = r2(base * rate * factor);
      acumulado = r2(acumulado + interes);
      const saldoFinal = modo === 'compuesto' ? r2(saldo + interes) : r2(capital + acumulado);
      rows.push({ n: k, desde: fmt(ini), hasta: fmt(completo ? fin : hasta), completo, dias: diasUsados, factor: r2(factor * 10000) / 10000,
        saldoInicial: modo === 'compuesto' ? saldo : r2(capital + acumulado - interes), interes, saldoFinal, acumulado });
      saldo = saldoFinal;
    }
    const meses = rows.length;
    // Recargo por mora y interés indemnizatorio son cargos DISTINTOS: el recargo es un % del impuesto que crece por mes;
    // el interés indemnizatorio es una tasa mensual. Cada fila lleva los dos por separado.
    const tope0 = Number(opts.topeRecargo) > 0 ? Number(opts.topeRecargo) : Infinity;
    rows.forEach((x, i) => { x.recargoPct = opts.recargos ? Math.min(tope0, 10 + 4 * i) : 0; x.recargoAcum = r2(capital * x.recargoPct / 100); });
    // Recargo por mora (Art. 252 Código Tributario, régimen 10 % + 4 %): 10 % el primer mes o fracción + 4 % por cada mes o fracción adicional, sobre el capital.
    // Tope opcional (opts.topeRecargo, en %): sin tope si no se indica (la norma anterior a la Ley 30-26 no lo fijaba; verifique).
    const tope = Number(opts.topeRecargo) > 0 ? Number(opts.topeRecargo) : Infinity;
    const recargoPct = opts.recargos && meses ? Math.min(tope, 10 + 4 * (meses - 1)) : 0;
    const recargo = r2(capital * recargoPct / 100);
    const intereses = acumulado;
    return { errores: [], rows, meses, capital: r2(capital), intereses, recargoPct, recargo, total: r2(capital + intereses + recargo), modo, fraccion, tasa };
  }
  return { calcular, addMonths, parseDate, r2 };
});
