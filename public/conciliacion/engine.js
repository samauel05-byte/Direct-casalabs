/* Motor de conciliación bancaria (sin dependencias; corre en el navegador y en Node).
 * Los montos se manejan en centavos enteros para evitar errores de coma flotante. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Conciliacion = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const pad = n => String(n).padStart(2, '0');

  // «1,234.56», «1.234,56», «(500.00)», «RD$ 1,000», «500.00 CR/DB» → centavos (o null).
  function parseAmount(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : null;
    let s = String(v).trim();
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (/(\bDB\b|\bD\b|DEB)\.?$/i.test(s)) { neg = true; s = s.replace(/(\bDB\b|\bD\b|DEB)\.?$/i, ''); }
    else s = s.replace(/(\bCR\b|\bC\b|CRE)\.?$/i, '');
    s = s.replace(/[A-Za-z$\s]/g, '');
    if (s.startsWith('-')) { neg = true; s = s.slice(1); }
    else if (s.startsWith('+')) s = s.slice(1);
    if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
    const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
    let dec = null;
    if (lastDot >= 0 && lastComma >= 0) dec = lastDot > lastComma ? '.' : ',';
    else if (lastDot >= 0 || lastComma >= 0) {
      const sep = lastDot >= 0 ? '.' : ',', parts = s.split(sep);
      dec = (parts.length === 2 && parts[1].length !== 3) || (parts.length === 2 && parts[1].length === 3 && parts[0] === '0') ? sep : (parts.length > 2 ? null : (parts[1].length === 3 ? null : sep));
    }
    let intPart = s, frac = '';
    if (dec) { const i = s.lastIndexOf(dec); intPart = s.slice(0, i); frac = s.slice(i + 1); }
    intPart = intPart.replace(/[.,]/g, '');
    const n = Number(intPart + (frac ? '.' + frac : ''));
    if (!Number.isFinite(n)) return null;
    const c = Math.round(n * 100);
    return neg ? -c : c;
  }

  // dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd, serial de Excel o Date → «YYYY-MM-DD» (o null).
  function parseDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date && !isNaN(v)) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
    if (typeof v === 'number') {
      if (v > 20000 && v < 80000) { const d = new Date(Math.round((v - 25569) * 86400000)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
      return null;
    }
    const s = String(v).trim();
    let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s);
    if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
    m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})/.exec(s);
    if (m) { let y = +m[3]; if (y < 100) y += 2000; const d = +m[1], mo = +m[2]; if (mo < 1 || mo > 12 || d < 1 || d > 31) return null; return `${y}-${pad(mo)}-${pad(d)}`; }
    return null;
  }
  const dayNum = iso => { const [y, m, d] = iso.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
  const daysBetween = (a, b) => (a && b) ? Math.abs(dayNum(a) - dayNum(b)) : 99999;

  const normRef = s => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');
  const normText = s => String(s == null ? '' : s).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

  // Cargos que el banco aplica solo y que normalmente no están en los libros.
  const FEE_RE = /COMISI|CARGO|IMPUESTO|LEY ?288|0[.,]15|ITBIS|MANTENIMIENTO|CUOTA ?(DE )?(MANEJO|SERVICIO)|SERVICIO ?BANC|INTER[EÉ]S|SOBREGIRO|CHEQUERA|FEE|CHARGE|TARIFA|PENALIDAD|MORA/;
  const isFee = (desc, amount) => amount < 0 && FEE_RE.test(normText(desc));

  // Filas crudas (arreglos o objetos) + mapa de columnas → registros normalizados.
  // map: { fecha, desc, ref, monto } o { fecha, desc, ref, debito, credito }; cada uno es índice de columna.
  // signo: 1 = positivo es entrada de dinero; -1 invierte (p. ej. libro donde crédito = entrada).
  function normalizeRows(rows, map, { signo = 1, prefix = 'R' } = {}) {
    const out = [], errors = [];
    rows.forEach((r, i) => {
      const get = k => (map[k] == null || map[k] === '' ? undefined : r[map[k]]);
      const date = parseDate(get('fecha'));
      let amount = null;
      if (map.monto != null && map.monto !== '') amount = parseAmount(get('monto'));
      else {
        const d = parseAmount(get('debito')), c = parseAmount(get('credito'));
        if (d != null || c != null) amount = Math.abs(c || 0) - Math.abs(d || 0);
      }
      if (amount == null || amount === 0 && get('monto') == null) { if (r.some(x => x != null && x !== '')) errors.push(i); return; }
      out.push({ id: prefix + (i + 1), line: i + 1, date, desc: String(get('desc') == null ? '' : get('desc')).trim(), ref: String(get('ref') == null ? '' : get('ref')).trim(), amount: amount * signo, raw: r });
    });
    return { rows: out, errors };
  }

  // Adivina qué columna es cada campo a partir del encabezado.
  function guessMap(headers) {
    const h = headers.map(normText);
    const find = re => { const i = h.findIndex(x => re.test(x)); return i < 0 ? null : i; };
    const map = { fecha: find(/^(FECHA|DATE|F\.? ?(VALOR|OPER)|FECHA ?(VALOR|OPER|TRANS|MOV)|F ?TRANS)/) ?? find(/FECHA|DATE/),
      desc: find(/DESCRIP|CONCEPTO|DETALLE|NARRATIV|GLOSA|OBSERV|BENEFICIARIO|MOVIMIENTO$/),
      ref: find(/REFEREN|NO\.? ?(DOC|CHEQUE|TRANS)|NUM(ERO)? ?(DOC|CHEQUE|REF|TRANS)|DOCUMENTO|CHEQUE|COMPROB|SECUENCIA|^NO\.?$|^NUM/),
      monto: find(/^(MONTO|IMPORTE|VALOR|AMOUNT|TOTAL)$/) ?? find(/MONTO|IMPORTE|AMOUNT/),
      debito: find(/D[EÉ]BITO|DEBIT|RETIRO|CARGO|SALIDA|EGRESO/), credito: find(/CR[EÉ]DITO|CREDIT|DEP[OÓ]SITO|ABONO|ENTRADA|INGRESO/) };
    if (map.debito != null && map.credito != null) map.monto = null; // prefiere débito/crédito si ambos existen
    return map;
  }

  // Detecta la fila de encabezado: la primera con ≥3 celdas de texto y alguna palabra clave.
  function findHeaderRow(rows) {
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const cells = (rows[i] || []).map(x => normText(x));
      const texts = cells.filter(x => x && !/^[\d.,\-\s/]+$/.test(x));
      if (texts.length >= 3 && cells.some(x => /FECHA|DATE/.test(x)) && cells.some(x => /MONTO|IMPORTE|D[EÉ]BITO|CR[EÉ]DITO|VALOR|AMOUNT|DEBIT/.test(x))) return i;
    }
    return 0;
  }

  function refMatch(a, b) {
    const x = normRef(a.ref), y = normRef(b.ref);
    if (x && y && x.length >= 3 && y.length >= 3) {
      if (x === y) return 2;
      if (x.includes(y) || y.includes(x)) return 1;
    }
    // referencia del uno dentro de la descripción del otro (p. ej. «CK 1234» ↔ «Cheque 1234»)
    const nums = s => (String(s).match(/\d{4,}/g) || []).map(n => n.replace(/^0+/, ''));
    const na = nums(a.ref + ' ' + a.desc), nb = nums(b.ref + ' ' + b.desc);
    return na.some(n => nb.includes(n)) ? 1 : 0;
  }

  function dupGroups(list) {
    const groups = new Map();
    for (const r of list) { const k = [r.date, r.amount, normRef(r.ref), normText(r.desc)].join('|'); (groups.get(k) || groups.set(k, []).get(k)).push(r); }
    return [...groups.values()].filter(g => g.length > 1);
  }

  // bank / book: registros normalizados. Devuelve parejas auto, a revisar y los sin pareja.
  function reconcile(bank, book, { dayTol = 3 } = {}) {
    const dupBank = dupGroups(bank), dupBook = dupGroups(book);
    const dupIds = new Set([...dupBank, ...dupBook].flat().map(r => r.id));
    const byAmount = new Map();
    for (const r of book) (byAmount.get(r.amount) || byAmount.set(r.amount, []).get(r.amount)).push(r);
    const cands = [];
    for (const b of bank) for (const k of (byAmount.get(b.amount) || [])) {
      const dd = daysBetween(b.date, k.date), rm = refMatch(b, k);
      if (dd <= dayTol || rm === 2) cands.push({ b, k, dd, rm, score: rm * 100 - Math.min(dd, 90) * 2 + (normText(b.desc) === normText(k.desc) ? 3 : 0) });
    }
    cands.sort((x, y) => y.score - x.score || x.b.line - y.b.line || x.k.line - y.k.line);
    const usedBank = new Set(), usedBook = new Set(), pairs = [];
    const candCount = new Map(); // cuántas alternativas tiene cada registro (para detectar ambigüedad)
    for (const c of cands) { candCount.set(c.b.id, (candCount.get(c.b.id) || 0) + 1); candCount.set(c.k.id, (candCount.get(c.k.id) || 0) + 1); }
    for (const c of cands) {
      if (usedBank.has(c.b.id) || usedBook.has(c.k.id)) continue;
      usedBank.add(c.b.id); usedBook.add(c.k.id);
      const ambiguous = candCount.get(c.b.id) > 1 || candCount.get(c.k.id) > 1;
      const duplicate = dupIds.has(c.b.id) || dupIds.has(c.k.id);
      const strong = c.rm >= 1 || c.dd === 0;
      let status = 'auto', why = c.rm === 2 ? 'Misma referencia' : c.rm === 1 ? 'Referencia parecida' : 'Mismo monto y fecha';
      if (!strong) { status = 'review'; why = `Mismo monto, fecha distinta (${c.dd} día${c.dd === 1 ? '' : 's'})`; }
      else if (ambiguous && c.rm < 2) { status = 'review'; why = 'Varios movimientos con el mismo monto'; }
      if (duplicate && c.rm < 2) { status = 'review'; why = 'Posible duplicado'; }
      pairs.push({ bank: c.b, book: c.k, daysDiff: c.dd, status, why });
    }
    const onlyBank = bank.filter(r => !usedBank.has(r.id)), onlyBook = book.filter(r => !usedBook.has(r.id));
    const fees = onlyBank.filter(r => isFee(r.desc, r.amount));
    const feeIds = new Set(fees.map(r => r.id));
    return { pairs, onlyBank: onlyBank.filter(r => !feeIds.has(r.id)), onlyBook, fees, duplicates: { bank: dupBank, book: dupBook } };
  }

  const sum = list => list.reduce((a, r) => a + r.amount, 0);
  function summarize(res, saldoBanco, saldoLibro) {
    const conc = res.pairs.filter(p => p.status === 'auto' || p.status === 'confirmed');
    const rev = res.pairs.filter(p => p.status === 'review');
    const s = { conciliados: conc.length, revisar: rev.length, soloBanco: res.onlyBank.length, soloLibro: res.onlyBook.length, cargos: res.fees.length,
      montoConciliado: sum(conc.map(p => p.bank)), montoSoloBanco: sum(res.onlyBank), montoSoloLibro: sum(res.onlyBook), montoCargos: sum(res.fees), montoRevisar: sum(rev.map(p => p.bank)) };
    if (saldoBanco != null && saldoLibro != null) s.diferenciaSaldos = saldoBanco - saldoLibro;
    s.diferenciaPendiente = s.montoSoloBanco + s.montoCargos - s.montoSoloLibro;
    return s;
  }

  const fmtMoney = c => (c / 100).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return { parseAmount, parseDate, normalizeRows, guessMap, findHeaderRow, reconcile, summarize, isFee, normRef, fmtMoney, daysBetween };
});
