/* Formulario IR-2 (declaración jurada anual de sociedades): mismas casillas y fórmulas que el Excel
   oficial de la DGII. Todas las casillas son editables; las calculadas se recalculan solas hasta que
   se escribe encima (queda «manual» y se puede volver a automático).
   El Excel se arma sobre la plantilla /ir2/IR-2.template.xlsx editando solo los valores de las celdas
   (se conserva el diseño, las celdas combinadas y las fórmulas). Todo en el navegador. */
(function (root) {
  'use strict';

  // t: 'in' = se escribe/trae de otro lado · 'calc' = fórmula del formulario · 'pct' = porcentaje
  const CAS = [
    { k: 'A',  cell: 'AB18', t: 'in',   label: 'INGRESOS (viene del Estado de Resultados)' },
    { k: 'B',  cell: 'AB19', t: 'in',   label: 'INGRESOS BRUTOS SUJETOS AL PAGO DE ANTICIPOS (Anexo E)' },
    { k: '1',  cell: 'AB20', t: 'in',   label: 'BENEFICIO O PÉRDIDA NETA ANTES DEL IMPUESTO (Anexo B)' },
    { k: '2',  cell: 'U21',  t: 'in',   label: 'AJUSTES POSITIVOS (Anexo G)  ( + )' },
    { k: '3',  cell: 'U22',  t: 'in',   label: 'EXENCIÓN LEY DE INCENTIVOS  ( − )' },
    { k: '4',  cell: 'U23',  t: 'in',   label: 'DIVIDENDOS GANADOS EN OTRAS COMPAÑÍAS  ( − )' },
    { k: '5',  cell: 'U24',  t: 'in',   label: 'AJUSTES NEGATIVOS (Anexo G)  ( − )' },
    { k: '6',  cell: 'AB25', t: 'calc', label: 'TOTAL AJUSTES FISCALES (casillas 2 − 3 − 4 − 5)' },
    { k: '7',  cell: 'AB26', t: 'calc', label: 'RENTA NETA IMPONIBLE ANTES DE LA PÉRDIDA Y DE LA LEY 392-07 (1 ± 6)' },
    { k: '8',  cell: 'AB27', t: 'in',   label: 'PÉRDIDAS AÑOS ANTERIORES QUE SE COMPENSAN (Anexo E)  ( − )' },
    { k: '9',  cell: 'AB28', t: 'calc', label: 'RENTA NETA IMPONIBLE DESPUÉS DE LA PÉRDIDA Y ANTES DE LA LEY 392-07 (7 − 8)' },
    { k: '10', cell: 'AB29', t: 'in',   label: 'DEDUCCIÓN POR INVERSIÓN (Ley 392-07)  ( − )' },
    { k: '11', cell: 'AB30', t: 'calc', label: 'RENTA NETA IMPONIBLE DESPUÉS DE LA PÉRDIDA Y DE LA LEY 392-07 (9 − 10)' },
    { k: '12', cell: 'AB31', t: 'calc', label: 'IMPUESTO LIQUIDADO (27 % de la casilla 11)' },
    { k: '13', cell: 'T32',  t: 'in',   label: 'ANTICIPOS PAGADOS  ( − )' },
    { k: '14', cell: 'T33',  t: 'in',   label: 'RETENCIONES ENTIDADES DEL ESTADO (Formato 623)  ( − )' },
    { k: '15', cell: 'T34',  t: 'in',   label: 'CRÉDITO POR INVERSIÓN (Art. 34 Ley 108-10)  ( − )' },
    { k: '16', cell: 'T35',  t: 'in',   label: 'CRÉDITO POR ENERGÍA RENOVABLE  ( − )' },
    { k: '17', cell: 'T36',  t: 'in',   label: 'CRÉDITO RETENCIONES POR INTERESES BANCARIOS  ( − )' },
    { k: '18', cell: 'T37',  t: 'in',   label: 'CRÉDITO POR RETENCIONES DE GANANCIA DE CAPITAL  ( − )' },
    { k: '19', cell: 'T38',  t: 'in',   label: 'CRÉDITO POR IMPUESTOS PAGADOS EN EL EXTERIOR  ( − )' },
    { k: '20', cell: 'T39',  t: 'in',   label: 'CRÉDITO FISCAL (Art. 39 Ley 108-10) (Ley 253-12)  ( − )' },
    { k: '21', cell: 'T40',  t: 'in',   label: 'COMPENSACIONES AUTORIZADAS Y OTROS PAGOS  ( − )' },
    { k: '22', cell: 'T41',  t: 'in',   label: 'SALDO A FAVOR DEL EJERCICIO ANTERIOR NO COMPENSADO  ( − )' },
    { k: '23', cell: 'AB42', t: 'calc', label: 'DIFERENCIA A PAGAR (12 − 13 … − 22, si es positivo)' },
    { k: '24', cell: 'AB43', t: 'calc', label: 'SALDO A FAVOR (12 − 13 … − 22, si es negativo)' },
    { k: '%25', cell: 'P44', t: 'pct',  label: '% de mora por declaración tardía (10 % el 1.er mes + 4 % por cada mes adicional)' },
    { k: '25', cell: 'T44',  t: 'calc', label: 'MORA POR DECLARACIÓN TARDÍA (casilla 23 × %)  ( + )' },
    { k: '26', cell: 'T45',  t: 'in',   label: 'MORA EN PAGOS DE ANTICIPOS  ( + )' },
    { k: '27', cell: 'AB46', t: 'calc', label: 'TOTAL RECARGOS (25 + 26)' },
    { k: '28', cell: 'AB47', t: 'in',   label: 'SANCIONES  ( + )' },
    { k: '%29', cell: 'W48', t: 'pct',  label: '% de interés indemnizatorio por declaración tardía' },
    { k: '29', cell: 'AB48', t: 'calc', label: 'INTERÉS INDEMNIZATORIO POR DECLARACIÓN TARDÍA (casilla 23 × %)  ( + )' },
    { k: '30', cell: 'AB49', t: 'in',   label: 'INTERÉS INDEMNIZATORIO SOBRE ANTICIPOS  ( + )' },
    { k: '31', cell: 'AB50', t: 'calc', label: 'TOTAL A PAGAR (23 − 24 + 27 + 28 + 29 + 30)' },
    { k: '32', cell: 'AB51', t: 'in',   label: 'SALDO A COMPENSAR EN ACTIVO / ANTICIPO  ( − )' },
    { k: '33', cell: 'AB52', t: 'calc', label: 'NUEVO SALDO A FAVOR (24 − 27 − 29 − 30, si es mayor de 200)' },
  ];
  // Datos generales: celda de la plantilla donde va cada uno
  const GENERAL = [
    { id: 'anio', cell: 'Z4', label: 'Año fiscal', num: true },
    { id: 'rnc', cell: 'E10', label: 'RNC' },
    { id: 'razon', cell: 'M10', label: 'Razón social' },
    { id: 'comercial', cell: 'H12', label: 'Nombre comercial' },
    { id: 'telefono', cell: 'I14', label: 'Teléfono de contacto' },
    { id: 'correo', cell: 'Q14', label: 'Correo electrónico' },
    { id: 'inicio', cell: 'I16', label: 'Inicio de la actividad (DD/MM/AAAA)' },
    { id: 'ej_del', cell: 'S16', label: 'Ejercicio comercial del (DD/MM/AAAA)' },
    { id: 'ej_al', cell: 'W16', label: 'Ejercicio comercial al (DD/MM/AAAA)' },
  ];

  // Calcula todas las casillas. inputs: {celda: número}; manual: Set de celdas calculadas escritas a mano.
  function compute(inputs, manual) {
    manual = manual || new Set();
    const num = c => { const x = parseFloat(inputs[c]); return isFinite(x) ? x : 0; };
    const r = {};
    for (const c of CAS) r[c.cell] = num(c.cell);
    const cal = (cell, fn) => { r[cell] = manual.has(cell) ? num(cell) : fn(); };
    cal('AB25', () => r.U21 - r.U22 - r.U23 - r.U24);
    cal('AB26', () => r.AB20 + r.AB25);
    cal('AB28', () => r.AB26 - r.AB27);
    cal('AB30', () => r.AB28 - r.AB29);
    cal('AB31', () => (r.AB30 > 0 ? r.AB30 * 0.27 : 0));
    const cred = ['T32', 'T33', 'T34', 'T35', 'T36', 'T37', 'T38', 'T39', 'T40', 'T41'].reduce((t, c) => t + r[c], 0);
    cal('AB42', () => (r.AB31 - cred > 0 ? r.AB31 - cred : 0));
    cal('AB43', () => (r.AB31 - cred < 0 ? cred - r.AB31 : 0));
    cal('T44', () => r.AB42 * (r.P44 / 100));
    cal('AB46', () => r.T44 + r.T45);
    cal('AB48', () => r.AB42 * (r.W48 / 100));
    cal('AB50', () => { const x = r.AB42 - r.AB43 + r.AB46 + r.AB47 + r.AB48 + r.AB49; return x > 0 ? x : 0; });
    cal('AB52', () => { const x = r.AB43 - r.AB46 - r.AB48 - r.AB49; return x > 200 ? x - r.AB51 : 0; });
    return r;
  }

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Reemplaza el contenido de una celda conservando su estilo (s="…"); keepFormula deja la fórmula con el valor nuevo en caché.
  function patchCell(xml, ref, value, keepFormula) {
    const re = new RegExp('<c r="' + ref + '"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)');
    const m = re.exec(xml);
    if (!m) throw new Error('La plantilla no tiene la celda ' + ref);
    const sm = /\ss="(\d+)"/.exec(m[1]); const s = sm ? ' s="' + sm[1] + '"' : '';
    const fm = keepFormula && m[2] ? /<f>[\s\S]*?<\/f>/.exec(m[2]) : null;
    let out;
    if (value === '' || value == null) out = '<c r="' + ref + '"' + s + '/>';
    else if (typeof value === 'number') out = '<c r="' + ref + '"' + s + '>' + (fm ? fm[0] : '') + '<v>' + value + '</v></c>';
    else out = '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' + esc(value) + '</t></is></c>';
    return xml.slice(0, m.index) + out + xml.slice(m.index + m[0].length);
  }

  // JSZip: constructor · templateBuf: ArrayBuffer/Uint8Array de la plantilla · data: {general:{id:valor}, inputs:{celda:n}, manual:Set}
  async function buildXlsx(JSZip, templateBuf, data) {
    const zip = await JSZip.loadAsync(templateBuf);
    const path = 'xl/worksheets/sheet1.xml';
    let xml = await zip.file(path).async('string');
    const manual = data.manual || new Set();
    const r = compute(data.inputs || {}, manual);
    for (const g of GENERAL) {
      let v = (data.general || {})[g.id];
      if (g.num) v = parseInt(v, 10) || '';
      xml = patchCell(xml, g.cell, v === undefined ? '' : v, false);
    }
    for (const c of CAS) {
      const hasFormula = c.t === 'calc' && !manual.has(c.cell);
      xml = patchCell(xml, c.cell, c.t === 'pct' && !r[c.cell] ? '' : r[c.cell], hasFormula);
    }
    zip.file(path, xml);
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  }

  const api = { CAS, GENERAL, compute, buildXlsx, patchCell };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.IR2Form = api;
})(typeof window !== 'undefined' ? window : globalThis);
