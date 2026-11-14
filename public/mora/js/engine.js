/* Intereses moratorios — motor de cálculo. Isomórfico (navegador y pruebas).
   Interés COMPUESTO mes a mes y ACUMULATIVO: cada mes se calcula sobre el saldo del mes anterior
   (capital + intereses ya acumulados). Modo «simple» disponible para comparar. Cada interés mensual se
   redondea a centavos (igual que ROUND(...,2) en la plantilla de Excel). NO inventa tasas: la tasa mensual la da
   quien calcula (por defecto 1 %; algunas fuentes de la DGII citan 1.10 %: verifique la vigente). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.Mora = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const DAY = 86400000;
  // Régimen de recargos por mora tal como lo aplica la calculadora de la DGII (verificado con consultas reales, ver README):
  // hasta el 29-jun-2026 (mes que empieza antes del 30-jun-2026): 10 % el primer mes + 4 % por cada mes adicional, sin tope;
  // desde entonces (Ley 30-26): 3 % por mes con tope de 100 %. Las fechas y porcentajes son editables.
  const REGIMENES_DGII = [{ desde: '1992-01-01', primerMes: 10, adicional: 4, tope: null }, { desde: '2026-06-30', primerMes: 3, adicional: 3, tope: 100 }];
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
    let saldo = r2(capital), acumulado = 0, sumFactor = 0;
    for (let k = 1; ; k++) {
      const ini = addMonths(desde, k - 1), fin = addMonths(desde, k);
      if (ini >= hasta) break;
      const completo = fin <= hasta;
      const diasPeriodo = days(ini, fin), diasUsados = completo ? diasPeriodo : days(ini, hasta);
      const factor = completo || fraccion === 'completo' ? 1 : diasUsados / diasPeriodo;
      // Simple (como la DGII): el interés acumulado se redondea UNA vez (capital × tasa × meses) y cada mes es la diferencia,
      // así la suma de los meses coincide con el total de la DGII (p. ej. 4,375 × 1.10 % × 16 = 770.00, no 770.08).
      // Compuesto: cada mes se redondea sobre el saldo anterior.
      let interes;
      if (modo === 'simple') { sumFactor += factor; const cum = r2(capital * rate * sumFactor); interes = r2(cum - acumulado); acumulado = cum; }
      else { interes = r2(saldo * rate * factor); acumulado = r2(acumulado + interes); }
      const saldoFinal = modo === 'compuesto' ? r2(saldo + interes) : r2(capital + acumulado);
      rows.push({ n: k, desde: fmt(ini), hasta: fmt(completo ? fin : hasta), completo, dias: diasUsados, factor: r2(factor * 10000) / 10000,
        saldoInicial: modo === 'compuesto' ? saldo : r2(capital + acumulado - interes), interes, saldoFinal, acumulado });
      saldo = saldoFinal;
    }
    const meses = rows.length;
    // Recargo por mora e interés indemnizatorio son cargos DISTINTOS. El recargo se arma mes a mes con el régimen vigente en
    // cada mes (opts.regimenes; por defecto el de la calculadora de la DGII): 1.er mes = primerMes %; cada mes siguiente suma
    // «adicional» % sin pasar del tope, y nunca baja de lo ya acumulado (con tope 100 %, un recargo ya mayor se conserva).
    const reg = (Array.isArray(opts.regimenes) && opts.regimenes.length ? opts.regimenes : REGIMENES_DGII).slice().sort((x, y) => String(x.desde).localeCompare(String(y.desde)));
    let prev = 0;
    rows.forEach((x, i) => {
      if (!opts.recargos) { x.recargoPct = 0; x.recargoAcum = 0; return; }
      const r = reg.filter(g => String(g.desde) <= x.desde).pop() || reg[0];
      const tope = Number(r.tope) > 0 ? Number(r.tope) : Infinity;
      prev = i === 0 ? Math.min(tope, Number(r.primerMes)) : Math.max(prev, Math.min(tope, prev + Number(r.adicional)));
      x.recargoPct = r2(prev); x.recargoAcum = r2(capital * prev / 100);
    });
    const recargoPct = opts.recargos && meses ? rows[meses - 1].recargoPct : 0;
    const recargo = r2(capital * recargoPct / 100);
    const intereses = acumulado;
    // Próximo vencimiento (como la DGII): primer aniversario mensual del vencimiento que es igual o posterior a la fecha de pago.
    const proximo = fmt(addMonths(desde, meses));
    return { errores: [], rows, meses, capital: r2(capital), intereses, recargoPct, recargo, total: r2(capital + intereses + recargo), modo, fraccion, tasa, vencimiento: fmt(desde), proximo };
  }
  // Agrupa las filas mensuales por año calendario (año en que empieza cada mes). Devuelve, por año: meses, interés del año,
  // saldo y interés acumulado al cierre del año y recargo acumulado al cierre.
  function porAnio(rows) {
    const out = [];
    for (const x of rows) {
      const y = Number(x.desde.slice(0, 4)); let g = out[out.length - 1];
      if (!g || g.anio !== y) { g = { anio: y, meses: 0, interes: 0, saldoInicial: x.saldoInicial, desde: x.desde }; out.push(g); }
      g.meses += 1; g.interes = r2(g.interes + x.interes); g.hasta = x.hasta; g.saldoFinal = x.saldoFinal; g.acumulado = x.acumulado; g.recargoPct = x.recargoPct || 0; g.recargoAcum = x.recargoAcum || 0;
    }
    return out;
  }
  // Tasa anual nominal → mensual equivalente (anual / 12).
  const tasaMensual = (valor, periodo) => (periodo === 'anual' ? Number(valor) / 12 : Number(valor));
  // Fecha de vencimiento según la calculadora de la DGII: ITBIS = día 20 del mes siguiente; IR-1 = 31 de marzo del año siguiente;
  // IR-2 = 120 días después del cierre del ejercicio (mes de cierre). El día puede correrse por feriados o fines de semana: verifique.
  // Si la fecha cae en sábado o domingo, pasa al lunes (la DGII dio 21/07/2025 para el ITBIS de 06/2025). Feriados: no incluidos (la DGII
  // dio 21/04/2026 para el ITBIS de 03/2026, un lunes; posible feriado o ajuste propio): verifique.
  const habil = d => { const w = d.getUTCDay(); return w === 6 ? new Date(d.getTime() + 2 * DAY) : (w === 0 ? new Date(d.getTime() + DAY) : d); };
  function vencimiento(impuesto, mes, anio) {
    const m = Number(mes), y = Number(anio);
    if (!Number.isFinite(y) || y < 1990 || y > 2100) return null;
    if (impuesto === 'ITB') { if (!(m >= 1 && m <= 12)) return null; return fmt(habil(new Date(Date.UTC(y, m, 20)))); }
    if (impuesto === 'IR1') return fmt(habil(new Date(Date.UTC(y + 1, 2, 31))));
    if (impuesto === 'IR2') { if (!(m >= 1 && m <= 12)) return null; return fmt(habil(new Date(Date.UTC(y, m, 0) + 120 * DAY))); }
    return null;
  }
  return { calcular, porAnio, tasaMensual, vencimiento, REGIMENES_DGII, addMonths, parseDate, r2 };
});
