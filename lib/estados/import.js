// Estados Financieros — lectura de archivos (Excel .xlsx / CSV), asociación de columnas y validación.
// Funciones puras (sin base de datos) para poder probarlas. No se acepta nada en silencio: cada problema
// se informa con número de fila, campo y explicación.
const crypto = require('crypto');
const ventas = require('../nala/ventas607');
const rules = require('./rules');

const MAX_ROWS = 20000;
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

// ── Lectura ────────────────────────────────────────────────────────────────
function splitCsv(text) {
  const first = text.split('\n', 1)[0] || '';
  const delim = [';', '\t', ','].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true; else if (c === delim) { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const cellText = v => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') return String(v.result ?? v.text ?? (v.richText ? v.richText.map(t => t.text).join('') : '') ?? '');
  return String(v).trim();
};

// Devuelve { sheet, rows: string[][] } con la primera hoja que tenga datos (o la pedida).
async function readTable(buffer, fileName, { sheet } = {}) {
  const name = String(fileName || '').toLowerCase();
  let rows; let used = null;
  if (/\.(csv|txt)$/.test(name)) {
    rows = splitCsv(buffer.toString('utf8').replace(/^﻿/, ''));
  } else if (/\.xlsx$/.test(name)) {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const withData = wb.worksheets.filter(w => w.actualRowCount > 0);
    const ws = (sheet && withData.find(w => w.name === sheet)) || withData[0];
    if (!ws) return { sheet: null, sheets: [], rows: [] };
    used = ws.name; rows = [];
    ws.eachRow({ includeEmpty: false }, row => { const cells = []; for (let c = 1; c <= Math.min(row.cellCount, 40); c++) cells.push(cellText(row.getCell(c).value)); rows.push(cells); });
    return { sheet: used, sheets: withData.map(w => w.name), rows: rows.filter(r => r.some(c => c !== '')) };
  } else {
    const e = new Error('Formato no admitido. Suba un Excel .xlsx o un CSV (si tiene un .xls, guárdelo como .xlsx).'); e.code = 'format'; throw e;
  }
  return { sheet: null, sheets: [], rows: rows.map(r => r.map(c => String(c).trim())).filter(r => r.some(c => c !== '')) };
}

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const headersSig = headers => crypto.createHash('sha1').update(headers.map(norm).join('|')).digest('hex');

// ── Asociación de columnas ────────────────────────────────────────────────
// Primera fila con ≥2 encabezados reconocibles (o la primera no vacía).
function findHeaderRow(rows, modality) {
  const fields = rules.FIELDS[modality];
  let best = { idx: 0, score: -1 };
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const score = rows[i].filter(h => matchField(fields, h)).length;
    if (score > best.score) best = { idx: i, score };
  }
  return best.idx;
}
function matchField(fields, header) {
  const h = norm(header);
  if (!h) return null;
  return fields.find(f => norm(f.label) === h || f.aliases.some(a => norm(a) === h)) || null;
}
// mapping: { campo → índice de columna } (o null = sin columna).
function suggestMapping(headers, modality) {
  const fields = rules.FIELDS[modality]; const mapping = {}; const used = new Set();
  for (const f of fields) mapping[f.key] = null;
  headers.forEach((h, i) => { const f = matchField(fields, h); if (f && mapping[f.key] === null && !used.has(i)) { mapping[f.key] = i; used.add(i); } });
  return mapping;
}
function cleanMapping(mapping, headers, modality) {
  const out = {}; const seen = new Set();
  for (const f of rules.FIELDS[modality]) {
    const v = mapping?.[f.key];
    const idx = v === null || v === undefined || v === '' ? null : Number(v);
    out[f.key] = Number.isInteger(idx) && idx >= 0 && idx < headers.length && !seen.has(idx) ? idx : null;
    if (out[f.key] !== null) seen.add(out[f.key]);
  }
  return out;
}

// ── Valores ───────────────────────────────────────────────────────────────
// Devuelve { value } o { error }. Punto decimal; se rechaza la coma decimal (ambigua).
function parseAmount(raw, { allowNegative = false } = {}) {
  const s0 = String(raw ?? '').trim();
  if (s0 === '' || s0 === '-') return { value: null };
  let s = s0.replace(/RD\$|US\$|\$|\s/gi, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s) || /^\d+,\d{1,2}$/.test(s)) return { error: `«${s0}» usa coma decimal; use punto decimal (1234.56).` };
  s = s.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return { error: `«${s0}» no es un importe válido.` };
  const n = Number(s) * (neg ? -1 : 1);
  if (!Number.isFinite(n) || Math.abs(n) >= 1e16) return { error: `«${s0}» es demasiado grande.` };
  if (n < 0 && !allowNegative) return { error: `«${s0}» es negativo; los débitos y créditos no admiten negativos.` };
  return { value: r2(n) };
}
const parseDate = raw => ventas.date(String(raw ?? '').trim());
function parsePeriodYM(raw) {
  const s = String(raw ?? '').trim();
  const m = /^(\d{4})[-/]?(\d{2})$/.exec(s);
  return m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${m[1]}${m[2]}` : null;
}
const yes = v => /^(si|sí|s|yes|y|true|1|x)$/i.test(String(v ?? '').trim());

// ── Validación de filas ───────────────────────────────────────────────────
// report: { modality, client_rnc, currency, period_start, period_end, scenario }
// ctx: { existingKeys:Set, allowDuplicates, balance:{rule,tolerance} }
function validate(rows, headerIdx, mapping, report, ctx = {}) {
  const modality = report.modality;
  const fields = rules.FIELDS[modality];
  const errors = []; const out = [];
  const add = (row, field, message) => { if (errors.length < 500) errors.push({ row, field, message }); errors.total = (errors.total || 0) + 1; };
  const body = rows.slice(headerIdx + 1);
  if (!body.length) return { rows: [], errors: [{ row: headerIdx + 1, field: null, message: 'El archivo no tiene filas de datos debajo del encabezado.' }], total: 1 };
  if (body.length > MAX_ROWS) return { rows: [], errors: [{ row: null, field: null, message: `El archivo tiene ${body.length} filas; el máximo por carga es ${MAX_ROWS}.` }], total: 1 };
  for (const f of fields) if (f.required && mapping[f.key] === null) add(headerIdx + 1, f.label, `Falta asociar la columna obligatoria «${f.label}».`);
  if (modality !== 'proyectado' && mapping.debit === null && mapping.credit === null) add(headerIdx + 1, 'Débito / Crédito', 'Asocie al menos la columna de Débito o la de Crédito.');
  if (errors.length) return { rows: [], errors, total: errors.total };
  const get = (cells, key) => (mapping[key] === null ? '' : String(cells[mapping[key]] ?? '').trim());
  const seen = new Map();
  body.forEach((cells, i) => {
    const row = headerIdx + 2 + i; // número de fila tal como se ve en Excel
    if (!cells.some(c => String(c).trim() !== '')) return;
    const rec = { row_no: row };
    const before = errors.total || 0;
    if (modality === 'proyectado') {
      const kindRaw = norm(get(cells, 'kind'));
      const kind = /^supuesto/.test(kindRaw) ? 'supuesto' : /^valor/.test(kindRaw) ? 'valor_estimado' : null;
      if (!kind) add(row, 'Tipo', `«${get(cells, 'kind')}» no es válido: use «supuesto» o «valor estimado».`);
      rec.kind = kind;
      rec.name = get(cells, 'name').slice(0, 200);
      if (!rec.name) add(row, 'Concepto', 'El concepto es obligatorio.');
      rec.description = get(cells, 'description').slice(0, 1000) || null;
      rec.period = get(cells, 'period').slice(0, 40) || null;
      rec.account_code = get(cells, 'account_code').slice(0, 60) || null;
      const amt = parseAmount(get(cells, 'amount'), { allowNegative: true });
      if (amt.error) add(row, 'Valor', amt.error);
      rec.amount = amt.value ?? null;
      rec.unit = get(cells, 'unit').slice(0, 40) || null;
      rec.source = get(cells, 'source').slice(0, 300) || null;
      rec.pending = yes(get(cells, 'pending'));
      const sc = get(cells, 'scenario');
      if (sc && report.scenario && norm(sc) !== norm(report.scenario)) add(row, 'Escenario', `La fila es del escenario «${sc}», pero este informe es «${report.scenario}».`);
      if (kind === 'valor_estimado' && rec.amount === null && !rec.pending) add(row, 'Valor', 'Un valor estimado necesita su cifra (o márquelo como pendiente).');
      if (kind === 'valor_estimado' && !rec.description && !rec.pending) add(row, 'Descripción', 'Un valor estimado necesita su descripción (o márquelo como pendiente).');
    } else {
      const d = parseDate(get(cells, 'entry_date'));
      if (!d) add(row, 'Fecha', `Fecha inválida («${get(cells, 'entry_date')}»).`);
      else if ((report.period_start && d < report.period_start) || (report.period_end && d > report.period_end)) add(row, 'Fecha', `${d} queda fuera del período del informe (${report.period_start || '…'} a ${report.period_end || '…'}).`);
      rec.entry_date = d;
      rec.account_code = get(cells, 'account_code').slice(0, 60);
      if (!rec.account_code) add(row, 'Código de cuenta', 'El código de cuenta es obligatorio.');
      rec.account_name = get(cells, 'account_name').slice(0, 200) || null;
      rec.concept = get(cells, 'concept').slice(0, 500) || null;
      rec.reference = get(cells, 'reference').slice(0, 80) || null;
      const deb = parseAmount(get(cells, 'debit')); const cre = parseAmount(get(cells, 'credit'));
      if (deb.error) add(row, 'Débito', deb.error);
      if (cre.error) add(row, 'Crédito', cre.error);
      rec.debit = deb.value ?? 0; rec.credit = cre.value ?? 0;
      if (!deb.error && !cre.error && !rec.debit && !rec.credit && mapping.opening_balance === null && mapping.closing_balance === null) add(row, 'Débito / Crédito', 'La fila no tiene ni débito ni crédito.');
      if (rec.debit && rec.credit) add(row, 'Débito / Crédito', 'La fila tiene débito y crédito a la vez; sepárela en dos líneas.');
      for (const [k, label] of [['opening_balance', 'Saldo inicial'], ['closing_balance', 'Saldo final']]) {
        const b = parseAmount(get(cells, k), { allowNegative: true });
        if (b.error) add(row, label, b.error);
        rec[k] = b.value ?? null;
      }
      rec.classification = get(cells, 'classification').slice(0, 120) || null;
      const cur = get(cells, 'currency').toUpperCase();
      if (cur && cur !== report.currency) add(row, 'Moneda', `La fila está en ${cur}, pero el informe es en ${report.currency}.`);
      const per = get(cells, 'period');
      if (per) { const p = parsePeriodYM(per); if (!p) add(row, 'Período', `«${per}» no es un período válido (AAAAMM o AAAA-MM).`); else if (d && p !== d.slice(0, 4) + d.slice(5, 7)) add(row, 'Período', `El período ${per} no corresponde a la fecha ${d}.`); }
      const rnc = get(cells, 'company_rnc').replace(/\D/g, '');
      if (rnc && report.client_rnc && rnc !== String(report.client_rnc).replace(/\D/g, '')) add(row, 'Empresa', `La fila es de otra empresa (${rnc}); este informe es de la empresa ${report.client_rnc}.`);
      const key = [rec.entry_date, rec.account_code, rec.reference || '', rec.concept || '', rec.debit, rec.credit].join('|');
      if (!ctx.allowDuplicates) {
        if (seen.has(key)) add(row, 'Fila', `Posible duplicado de la fila ${seen.get(key)} (misma fecha, cuenta, referencia, concepto e importes).`);
        else if (ctx.existingKeys && ctx.existingKeys.has(key)) add(row, 'Fila', 'Posible duplicado: ya existe un registro igual en este informe.');
      }
      if (!seen.has(key)) seen.set(key, row);
    }
    if ((errors.total || 0) === before) out.push(rec);
  });
  const total = errors.total || 0;
  return { rows: out, errors, total };
}

// ── Cuadre de débitos y créditos ──────────────────────────────────────────
// rule: por_asiento | global | ninguna. Devuelve { ok, issues[] } para registros {reference, debit, credit}.
function balanceCheck(entries, { rule = 'por_asiento', tolerance = 0.01 } = {}) {
  const issues = [];
  if (rule === 'ninguna') return { ok: true, issues, rule, applied: false };
  const sum = (arr, k) => r2(arr.reduce((s, e) => s + Number(e[k] || 0), 0));
  if (rule === 'global') {
    const d = sum(entries, 'debit'); const c = sum(entries, 'credit');
    if (Math.abs(d - c) > tolerance) issues.push({ scope: 'global', debit: d, credit: c, diff: r2(d - c) });
    return { ok: !issues.length, issues, rule, applied: true };
  }
  const groups = new Map(); let withoutRef = 0;
  for (const e of entries) { if (!e.reference) { withoutRef++; continue; } (groups.get(e.reference) || groups.set(e.reference, []).get(e.reference)).push(e); }
  for (const [ref, list] of groups) {
    const d = sum(list, 'debit'); const c = sum(list, 'credit');
    if (Math.abs(d - c) > tolerance) issues.push({ scope: 'asiento', reference: ref, debit: d, credit: c, diff: r2(d - c) });
  }
  return { ok: !issues.length, issues, rule, applied: true, without_reference: withoutRef, groups: groups.size };
}

module.exports = { MAX_ROWS, readTable, splitCsv, sha256, headersSig, findHeaderRow, suggestMapping, cleanMapping, matchField, parseAmount, parseDate, validate, balanceCheck, norm };
