// Estados Financieros — plantillas de carga y exportación a Excel (reutiliza exceljs, como NALA y Nómina).
const ExcelJS = require('exceljs');
const rules = require('./rules');
const ST = require('../../public/estados/js/statements-engine.js');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'informe';
const HEAD = { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4C1D95' } } };

async function toFile(wb, name) {
  const buffer = await wb.xlsx.writeBuffer();
  return { name, mime: XLSX_MIME, base64: Buffer.from(buffer).toString('base64') };
}

// Plantilla vacía: solo encabezados (sin cifras de ejemplo) + hoja de instrucciones con lo que falta confirmar.
async function templateFile(mod, cfg) {
  const m = rules.MODALITIES[mod];
  const fields = rules.FIELDS[mod];
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Direct · Estados Financieros';
  const ws = wb.addWorksheet('Datos');
  ws.addRow(fields.map(f => f.label)).eachCell(c => Object.assign(c, HEAD));
  ws.columns = fields.map(f => ({ width: Math.max(14, f.label.length + 4) }));
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  const ins = wb.addWorksheet('Instrucciones');
  ins.addRow([`Plantilla de ${m.label} — PROPUESTA, pendiente de confirmar por Contabilidad`]).font = { bold: true, size: 13 };
  ins.addRow(['Esta plantilla no contiene cifras. Los ejemplos, si se agregan, deben estar marcados como FICTICIOS.']);
  ins.addRow([]);
  ins.addRow(['Columna', 'Obligatoria', 'Tipo', 'Qué lleva', 'Estado de la columna']).eachCell(c => Object.assign(c, HEAD));
  for (const f of fields) ins.addRow([f.label, f.required ? 'Sí' : 'No', f.type, f.hint, 'Por confirmar con Contabilidad']);
  ins.addRow([]);
  ins.addRow(['Información que Contabilidad todavía debe entregar:']).font = { bold: true };
  for (const t of rules.PENDING_FROM_ACCOUNTING[mod]) ins.addRow([`• ${t}`]);
  ins.addRow([]);
  ins.addRow(['Formato de números: punto decimal (1234.56), sin símbolos. Fechas: AAAA-MM-DD o DD/MM/AAAA.']);
  if (mod !== 'proyectado') ins.addRow(['Cada línea lleva débito o crédito, no ambos. Use la columna de referencia/asiento para que Direct valide el cuadre.']);
  ins.columns = [{ width: 34 }, { width: 12 }, { width: 12 }, { width: 70 }, { width: 34 }];
  return toFile(wb, `Plantilla_${slug(m.label)}.xlsx`);
}

// Informe exportado. Si no está aprobado/cerrado o tiene pendientes, el documento lo dice con claridad.
async function reportFile(detail, entries, cfg, statements) {
  const r = detail.report; const m = rules.MODALITIES[r.modality];
  const approved = ['aprobado', 'cerrado', 'pendiente_legalizacion'].includes(r.status);
  const complete = detail.completeness.complete;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Direct · Estados Financieros';
  const ws = wb.addWorksheet('Informe');
  const banner = !approved || !complete
    ? `DOCUMENTO PRELIMINAR — ${!approved ? `NO APROBADO (estado: ${detail.status_label})` : 'INCOMPLETO'}${!complete ? ' · CON PENDIENTES' : ''}`
    : `Documento ${detail.status_label.toLowerCase()}`;
  const b = ws.addRow([banner]); b.font = { bold: true, size: 13, color: { argb: approved && complete ? 'FF065F46' : 'FFB91C1C' } };
  ws.addRow([]);
  const people = detail.people || {};
  const origin = detail.origin.length ? detail.origin.map(o => (o.type === 'archivo' ? `Archivo ${o.file_name} (${o.rows} filas, SHA-256 ${String(o.sha256 || '').slice(0, 12)}…)` : o.description)).join(' · ') : (r.modality === 'proyectado' ? 'Supuestos y valores estimados ingresados por el usuario' : 'Sin información cargada');
  const rows = [
    ['Modalidad', m.singular], ['Empresa', `${r.client_name}${r.client_rnc ? ` · ${r.client_rnc}` : ''}`], ['Informe', r.title],
    ...(r.scenario ? [['Escenario', r.scenario]] : []),
    ...(r.fiscal_year ? [['Año fiscal', r.fiscal_year]] : []), ...(r.fiscal_period ? [['Período fiscal', r.fiscal_period]] : []),
    [r.modality === 'proyectado' ? 'Período proyectado' : 'Período cubierto / fecha de corte', `${r.period_start || '—'} a ${r.period_end || '—'}`],
    ...(detail.data_through ? [['La información llega hasta', detail.data_through]] : []),
    ['Moneda', r.currency], ['Estado de revisión', detail.status_label], ['Versión', r.version], ['Fecha de preparación', r.prepared_on],
    ['Fecha de generación', new Date(detail.generated_at).toLocaleString('es-DO')],
    ['Preparado por', people[r.prepared_by] || '—'], ['Revisado por', people[r.reviewed_by] || '—'], ['Aprobado por', people[r.approved_by] || '—'], ['Cerrado por', people[r.closed_by] || '—'],
    ['Origen de la información', origin],
  ];
  for (const [k, v] of rows) { const row = ws.addRow([k, v]); row.getCell(1).font = { bold: true }; }
  ws.addRow([]);
  ws.addRow(['Información pendiente']).font = { bold: true };
  const pend = detail.completeness.items;
  if (!pend.length) ws.addRow(['', 'Ninguna']);
  for (const i of pend) ws.addRow([{ blocking: 'Bloqueante', warning: 'Advertencia', info: 'Nota' }[i.severity], i.message]);
  if (r.notes) { ws.addRow([]); ws.addRow(['Notas', r.notes]); }
  ws.columns = [{ width: 34 }, { width: 110 }];

  if (r.modality === 'proyectado') {
    const sa = wb.addWorksheet('Supuestos y valores');
    sa.addRow(['Tipo', 'Concepto', 'Descripción', 'Período', 'Cuenta', 'Valor', 'Unidad', 'Fuente', 'Pendiente', 'Naturaleza']).eachCell(c => Object.assign(c, HEAD));
    for (const a of detail.assumptions) sa.addRow([a.kind === 'supuesto' ? 'Supuesto' : 'Valor estimado', a.name, a.description, a.period, a.account_code, a.amount, a.unit, a.source, a.pending ? 'Sí' : 'No', 'PROYECTADO (estimación)']);
    sa.columns = [{ width: 16 }, { width: 34 }, { width: 50 }, { width: 14 }, { width: 14 }, { width: 16 }, { width: 10 }, { width: 28 }, { width: 11 }, { width: 24 }];
  } else {
    const ac = wb.addWorksheet('Resumen por cuenta');
    ac.addRow(['Cuenta', 'Nombre', 'Clasificación', 'Débitos', 'Créditos', 'Neto', 'Ajustes débito', 'Ajustes crédito', 'Neto con ajustes']).eachCell(c => Object.assign(c, HEAD));
    for (const a of detail.accounts) ac.addRow([a.account_code, a.account_name, a.classification, a.debit, a.credit, a.net, a.adj_debit, a.adj_credit, a.net_with_adjustments]);
    ac.columns = [{ width: 14 }, { width: 38 }, { width: 22 }, ...Array(6).fill({ width: 16 })];
    for (const col of [4, 5, 6, 7, 8, 9]) ac.getColumn(col).numFmt = '#,##0.00';
    const re = wb.addWorksheet('Registros');
    re.addRow(['Fecha', 'Cuenta', 'Nombre', 'Concepto', 'Referencia', 'Débito', 'Crédito', 'Saldo inicial', 'Saldo final', 'Clasificación', 'Fila del archivo']).eachCell(c => Object.assign(c, HEAD));
    for (const e of entries) re.addRow([e.entry_date, e.account_code, e.account_name, e.concept, e.reference, Number(e.debit), Number(e.credit), e.opening_balance == null ? null : Number(e.opening_balance), e.closing_balance == null ? null : Number(e.closing_balance), e.classification, e.row_no]);
    re.columns = [{ width: 12 }, { width: 14 }, { width: 30 }, { width: 40 }, { width: 14 }, ...Array(4).fill({ width: 16 }), { width: 20 }, { width: 10 }];
    const aj = wb.addWorksheet('Ajustes');
    aj.addRow(['Tipo', 'Fecha', 'Referencia', 'Concepto', 'Cuenta', 'Débito', 'Crédito']).eachCell(c => Object.assign(c, HEAD));
    for (const a of detail.adjustments) aj.addRow([a.kind === 'cierre' ? 'Cierre' : 'Ajuste', a.adj_date, a.reference, a.concept, a.account_code, Number(a.debit), Number(a.credit)]);
    aj.columns = [{ width: 10 }, { width: 12 }, { width: 14 }, { width: 50 }, { width: 14 }, { width: 16 }, { width: 16 }];
  }
  if (statements) {
    // Un estado por hoja: columna anual + una columna por mes (los totales son los calculados por Direct).
    for (const key of ST.ORDER) {
      const tpl = ST.template(key, statements.customs); const sh = wb.addWorksheet(tpl.short.slice(0, 28));
      sh.addRow([tpl.title]).font = { bold: true, size: 12 };
      sh.addRow([`${r.client_name}${r.client_rnc ? ` · ${r.client_rnc}` : ''}`]); sh.addRow([`Desde el ${r.period_start} al ${r.period_end} · Valores en ${r.currency}${!approved || !complete ? ' · DOCUMENTO PRELIMINAR' : ''}`]); sh.addRow([]);
      sh.addRow(['', 'ANUAL', ...statements.months.map(m => m.label)]).eachCell(c => Object.assign(c, HEAD));
      for (const l of tpl.lines) {
        if (l.t === 'head' || l.t === 'subhead') { const row = sh.addRow([l.label]); row.font = { bold: true, underline: l.t === 'head' }; continue; }
        if (l.monthlyOnly) { const row = sh.addRow([l.label, null, ...statements.months.map(m => statements.computed[key][l.k]?.[m.idx] ?? null)]); row.getCell(1).font = { italic: true }; continue; }
        const row = sh.addRow([l.label, statements.computed[key][l.k]?.[0] ?? null, ...statements.months.map(m => statements.computed[key][l.k]?.[m.idx] ?? null)]);
        if (l.strong) row.font = { bold: true };
      }
      sh.columns = [{ width: 46 }, ...Array(statements.months.length + 1).fill({ width: 16 })];
      for (let c = 2; c <= statements.months.length + 2; c++) sh.getColumn(c).numFmt = '#,##0.00;(#,##0.00);"-"';
      sh.views = [{ state: 'frozen', xSplit: 1, ySplit: 5 }];
    }
  }
  const hi = wb.addWorksheet('Historial');
  hi.addRow(['Versión', 'Cambio', 'Nota', 'Por', 'Fecha']).eachCell(c => Object.assign(c, HEAD));
  for (const v of detail.versions) hi.addRow([v.version, v.change_type, v.note, v.changed_by_name, new Date(v.changed_at).toLocaleString('es-DO')]);
  hi.columns = [{ width: 9 }, { width: 34 }, { width: 60 }, { width: 18 }, { width: 22 }];
  const tag = approved && complete ? '' : '_PRELIMINAR';
  return toFile(wb, `${slug(m.singular)}_${slug(r.client_name)}_${slug(r.title)}_v${r.version}${tag}.xlsx`);
}

module.exports = { templateFile, reportFile };
