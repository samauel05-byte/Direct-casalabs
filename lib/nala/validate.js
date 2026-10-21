// Deterministic validation of a single invoice. The AI only extracts values;
// every total, derived code and fiscal rule is computed here.
const money = require('./money');
const ids = require('./ids');
const rules = require('./rules');

const AMOUNT_FIELDS = Object.entries(rules.FIELD_DEFS).filter(([, d]) => d.type === 'amount').map(([k]) => k);
const blank = v => v === null || v === undefined || String(v).trim() === '';
const isoDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const periodOf = date => String(date).slice(0, 4) + String(date).slice(5, 7);

function periodBounds(period) {
  const y = Number(period.slice(0, 4)); const m = Number(period.slice(4, 6));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${period.slice(0, 4)}-${period.slice(4, 6)}-01`, end: `${period.slice(0, 4)}-${period.slice(4, 6)}-${String(last).padStart(2, '0')}` };
}

function clientIds(client) {
  return [client?.rnc, client?.cedula].map(ids.digitsOnly).filter(Boolean);
}

// Values the export needs that are *computed* from the stored fields.
function derive(format, fields) {
  const f = fields || {};
  const counterpartId = format === '606' ? f.emisor_id : f.receptor_id;
  const idInfo = ids.analyzeTaxId(counterpartId);
  const tipoId = !blank(f.tipo_id) ? String(f.tipo_id) : (idInfo.tipoId || null);
  const subtotal = format === '606' ? money.sum([f.monto_servicios, f.monto_bienes]) : safe(f.monto_facturado);
  const calculatedTotal = subtotal === null ? null : money.sum([subtotal, f.itbis, f.isc, f.otros_impuestos, f.propina]);
  const extractedTotal = safe(f.total);
  const difference = calculatedTotal !== null && extractedTotal !== null ? money.sub(extractedTotal, calculatedTotal) : null;
  const itbisAdelantar = format === '606' && !blank(f.itbis) ? money.sub(safe(f.itbis), safe(f.itbis_costo) ?? '0.00') : null;
  // La moneda es siempre pesos dominicanos (obligatorio): a la DGII todo se reporta en DOP y los
  // montos del comprobante se toman tal cual, sin importar lo que diga el documento.
  const currency = 'DOP';
  const dop = null;
  return {
    counterpartId: ids.digitsOnly(counterpartId) || (blank(counterpartId) ? null : String(counterpartId).trim()),
    counterpartName: format === '606' ? (f.emisor_nombre || null) : (f.receptor_nombre || null),
    tipoId, subtotal, calculatedTotal, extractedTotal, difference, itbisAdelantar, currency, dop,
    ncfInfo: ids.analyzeNcf(f.ncf),
  };
}

function safe(value) {
  if (blank(value)) return null;
  try { return money.normalize(value); } catch { return null; }
}

// Amount in DOP for exports and statistics. A la DGII todo se reporta en DOP:
// si hay tasa válida se convierte; si no (moneda extranjera sin tasa) se toma el
// monto tal cual, asumiéndolo ya en pesos, en vez de dejarlo en blanco.
function dopAmount(format, fields, key) {
  const d = derive(format, fields);
  if (d.currency === 'DOP') return safe(fields[key]);
  if (d.dop) return d.dop[key] ?? null;
  return safe(fields[key]);
}

function validate({ format, period, fields = {}, client = null, settings = {}, duplicates = [], extraction = {}, correctedFields = [] }) {
  const ruleset = rules.forPeriod(period);
  const issues = [];
  const add = (severity, code, field, message) => issues.push({ severity, code, field: field || null, message });
  const f = fields;
  const d = derive(format, f);
  const tolerance = safe(settings.total_tolerance) ?? '1.00';
  const ncf = d.ncfInfo;
  const consumer = ncf.valid && ids.isConsumer(ncf.type);
  const note = ncf.valid && (ids.isCreditNote(ncf.type) || ids.isDebitNote(ncf.type));
  const modInfo = ids.analyzeNcf(f.ncf_modificado);
  const threshold = ruleset.consumerSummaryThreshold;

  // Amount syntax first: every later check relies on parseable amounts.
  for (const key of AMOUNT_FIELDS) {
    if (blank(f[key])) continue;
    if (!money.isValid(f[key])) { add('critical', 'MONTO_INVALIDO', key, `${rules.FIELD_DEFS[key].label}: valor "${f[key]}" no es un monto válido.`); continue; }
    if (money.cmp(f[key], '0') < 0) add('critical', 'MONTO_NEGATIVO', key, `${rules.FIELD_DEFS[key].label} no puede ser negativo (las notas de crédito se reportan en positivo).`);
  }

  // Counterpart identification.
  const idField = format === '606' ? 'emisor_id' : 'receptor_id';
  const idRaw = f[idField];
  const tipoId = d.tipoId;
  const consumerSummary = format === '607' && d.subtotal !== null && money.cmp(d.subtotal, threshold) < 0 &&
    (consumer || (note && modInfo.valid && ids.isConsumer(modInfo.type)));
  if (blank(idRaw)) {
    if (!consumerSummary) add('critical', 'ID_FALTANTE', idField, format === '606' ? 'Falta el RNC/Cédula del proveedor.' : 'Falta el RNC/Cédula/Pasaporte del cliente.');
  } else if (format === '607' && tipoId === '3') {
    // Pasaporte o ID tributaria extranjera: DGII no valida estructura.
  } else {
    const info = ids.analyzeTaxId(idRaw);
    if (!info.structureValid) add('critical', 'ID_INVALIDO', idField, `Identificación inválida: ${info.message}`);
    else {
      if (!info.checkDigitValid) add('warning', 'ID_DIGITO_VERIFICADOR', idField, 'El dígito verificador no coincide; confirme contra el documento o la Consulta RNC.');
      if (!blank(f.tipo_id) && String(f.tipo_id) !== info.tipoId) add('critical', 'TIPO_ID_INCONSISTENTE', 'tipo_id', `Tipo Id ${f.tipo_id} no corresponde a una identificación de ${info.digits.length} dígitos.`);
    }
  }
  if (!blank(f.tipo_id) && !ruleset.tipoId[String(f.tipo_id)]) add('critical', 'TIPO_ID_INVALIDO', 'tipo_id', 'Tipo Id debe ser 1 (RNC), 2 (Cédula) o 3 (Pasaporte).');
  if (format === '606' && String(f.tipo_id) === '3') add('critical', 'TIPO_ID_INVALIDO', 'tipo_id', 'El 606 sólo admite RNC (1) o Cédula (2).');

  // Receipt number.
  if (blank(f.ncf)) add('critical', 'NCF_FALTANTE', 'ncf', 'Falta el NCF / e-CF.');
  else if (!ncf.valid) add('critical', 'NCF_INVALIDO', 'ncf', ncf.message);
  else if (format === '607' && ncf.electronic) add('warning', 'ECF_EXCLUIDO_607', 'ncf', 'e-CF emitido: la DGII lo recibe por facturación electrónica; no se incluye en el TXT 607.');
  else if (!ruleset.ncfTypes[format].includes(ncf.type)) add('critical', 'NCF_NO_ADMITIDO', 'ncf', `El tipo ${ncf.type} (${ncf.typeName}) no se admite en el formato ${format}.`);
  if (ncf.legacy) add('warning', 'NCF_19_POSICIONES', 'ncf', 'NCF de 19 posiciones: sólo válido para reportar retenciones de comprobantes anteriores a mayo 2018.');
  if (note) {
    if (blank(f.ncf_modificado)) add('critical', 'NCF_MODIFICADO_FALTANTE', 'ncf_modificado', 'Las notas de crédito/débito requieren el NCF modificado.');
    else if (!modInfo.valid) add('critical', 'NCF_MODIFICADO_INVALIDO', 'ncf_modificado', modInfo.message);
  } else if (!blank(f.ncf_modificado)) {
    if (!modInfo.valid) add('critical', 'NCF_MODIFICADO_INVALIDO', 'ncf_modificado', modInfo.message);
    else add('warning', 'NCF_MODIFICADO_SIN_NOTA', 'ncf_modificado', 'Hay NCF modificado pero el comprobante no es nota de crédito/débito.');
  }

  // Company and period.
  const own = clientIds(client);
  const ownId = own[0] || null;
  if (own.length) {
    const ownSide = format === '606' ? 'receptor_id' : 'emisor_id';
    const ownValue = ids.digitsOnly(f[ownSide]);
    if (ownValue && !own.includes(ownValue)) add('critical', 'EMPRESA_INCORRECTA', ownSide, `La factura corresponde a ${ownValue}, no a la empresa del lote (${ownId}). Reubíquela si corresponde.`);
    else if (!ownValue && format === '606' && ncf.valid && ['B01', 'E31'].includes(ncf.type)) add('warning', 'RECEPTOR_NO_IDENTIFICADO', 'receptor_id', 'No se identificó el RNC del comprador en un comprobante de crédito fiscal.');
    const counterpart = ids.digitsOnly(idRaw);
    if (format === '606' && ncf.valid && ['B13', 'E43', 'B17', 'E47'].includes(ncf.type) && counterpart && !own.includes(counterpart)) {
      add('critical', 'ID_DEBE_SER_EMPRESA', idField, `En comprobantes ${ncf.type} se reporta el RNC de la propia empresa (${ownId}).`);
    }
    if (format === '607' && ncf.valid && ncf.type === 'B12' && counterpart && !own.includes(counterpart)) add('critical', 'ID_DEBE_SER_EMPRESA', idField, `En comprobantes B12 se reporta el RNC de la propia empresa (${ownId}).`);
  }
  if (blank(f.fecha_comprobante)) add('critical', 'FECHA_FALTANTE', 'fecha_comprobante', 'Falta la fecha del comprobante.');
  else if (!isoDate(f.fecha_comprobante)) add('critical', 'FECHA_INVALIDA', 'fecha_comprobante', 'Fecha del comprobante inválida (AAAA-MM-DD).');
  else if (period) {
    const { start, end } = periodBounds(period);
    if (f.fecha_comprobante > end) add('critical', 'FECHA_POSTERIOR_PERIODO', 'fecha_comprobante', `La fecha ${f.fecha_comprobante} es posterior al período ${period}.`);
    else if (f.fecha_comprobante < start) {
      if (format === '607') add('critical', 'PERIODO_INCORRECTO', 'fecha_comprobante', `La venta es del período ${periodOf(f.fecha_comprobante)}, no de ${period}. Reubíquela.`);
      else add('warning', 'COMPROBANTE_PERIODO_ANTERIOR', 'fecha_comprobante', `Comprobante del período ${periodOf(f.fecha_comprobante)} reportado en ${period}.`);
    }
  }
  for (const key of ['fecha_pago', 'fecha_retencion', 'tasa_fecha']) {
    if (!blank(f[key]) && !isoDate(f[key])) add('critical', 'FECHA_INVALIDA', key, `${rules.FIELD_DEFS[key].label} inválida (AAAA-MM-DD).`);
  }
  const hasItbisRet = money.isPositive(f.itbis_retenido);
  const hasIsrRet = money.isPositive(f.isr_retenido);
  if (format === '606') {
    if ((hasItbisRet || hasIsrRet) && blank(f.fecha_pago)) add('critical', 'FECHA_PAGO_REQUERIDA', 'fecha_pago', 'Con retenciones de ITBIS o ISR la fecha de pago es obligatoria.');
    if (isoDate(f.fecha_pago) && isoDate(f.fecha_comprobante) && f.fecha_pago < f.fecha_comprobante) add('warning', 'FECHA_PAGO_ANTERIOR', 'fecha_pago', 'La fecha de pago es anterior a la del comprobante.');
    if (isoDate(f.fecha_pago) && period && periodOf(f.fecha_pago) > period) add('critical', 'FECHA_PAGO_POSTERIOR', 'fecha_pago', 'La fecha de pago es posterior al período reportado.');
  } else if ((hasItbisRet || hasIsrRet) && blank(f.fecha_retencion)) {
    add('critical', 'FECHA_RETENCION_REQUERIDA', 'fecha_retencion', 'Con retenciones de terceros la fecha de retención es obligatoria.');
  }

  // Classification codes.
  const codeCheck = (key, list, label, required) => {
    if (blank(f[key])) { if (required) add('critical', 'CODIGO_FALTANTE', key, `Falta ${label}.`); return; }
    if (!list[String(f[key]).padStart(2, '0')] || !/^\d{1,2}$/.test(String(f[key]))) add('critical', 'CODIGO_INVALIDO', key, `${label}: código ${f[key]} no válido.`);
  };
  if (format === '606') {
    codeCheck('tipo_bienes_servicios', ruleset.tipoBienesServicios, 'el tipo de bienes y servicios', true);
    codeCheck('forma_pago', ruleset.formaPago, 'la forma de pago', true);
    codeCheck('isr_tipo_retencion', ruleset.tipoRetencionIsr, 'el tipo de retención ISR', false);
    if (hasIsrRet && blank(f.isr_tipo_retencion)) add('critical', 'TIPO_RETENCION_REQUERIDO', 'isr_tipo_retencion', 'Hay retención de renta sin tipo de retención ISR.');
    if (!blank(f.isr_tipo_retencion) && !hasIsrRet) add('critical', 'MONTO_RETENCION_REQUERIDO', 'isr_retenido', 'Hay tipo de retención ISR sin monto retenido.');
  } else {
    codeCheck('tipo_ingreso', ruleset.tipoIngreso, 'el tipo de ingreso', true);
  }
  // La clasificación (tipo de bienes/servicios en 606, tipo de ingreso en 607) la
  // propone el lector, pero depende de cada factura y a veces se equivoca (p. ej.
  // "01 · Gastos de personal" en una compra de supermercado). Por eso se marca como
  // ADVERTENCIA para que el auditor la confirme o la cambie por comprobante; al
  // guardarla queda confirmada (pasa a corrected_fields) y el aviso desaparece.
  const classLabel = (key, code) => {
    const map = key === 'tipo_ingreso' ? ruleset.tipoIngreso : ruleset.tipoBienesServicios;
    const padded = String(code).padStart(2, '0');
    return map && map[padded] ? `${padded} · ${map[padded]}` : code;
  };
  for (const key of extraction.suggested || []) {
    if (!correctedFields.includes(key) && !blank(f[key])) {
      add('warning', 'CLASIFICACION_SUGERIDA', key, `${rules.FIELD_DEFS[key]?.label || key}: NALA propuso "${classLabel(key, f[key])}" según la factura; confírmalo o cámbialo si no corresponde.`);
    }
  }

  // Amounts and totals.
  const subNeg = d.subtotal !== null && money.isValid(d.subtotal) && !money.isPositive(d.subtotal) && !money.isZero(d.subtotal);
  if (subNeg) {
    add('critical', 'MONTO_NEGATIVO', format === '606' ? 'monto_bienes' : 'monto_facturado',
      'El monto no puede ser negativo. Si el total ya incluye el ITBIS, usa el botón «− Restar ITBIS del monto» para que el ITBIS se reste del subtotal (no del total), en vez de escribir un negativo.');
  } else if (d.subtotal === null || !money.isPositive(d.subtotal)) {
    add('critical', 'MONTO_FACTURADO_REQUERIDO', format === '606' ? 'monto_servicios' : 'monto_facturado',
      format === '606' ? 'Indique el monto facturado en servicios y/o bienes (sin impuestos), mayor que cero.' : 'Indique el monto facturado sin impuestos, mayor que cero.');
  }
  if (blank(f.itbis)) add('warning', 'ITBIS_NO_IDENTIFICADO', 'itbis', 'No se identificó el ITBIS; confirme si el comprobante está exento (use 0.00).');
  if (d.extractedTotal === null) add('warning', 'TOTAL_NO_IDENTIFICADO', 'total', 'No se identificó el total del comprobante; no se puede conciliar.');
  else if (d.difference !== null) {
    const diff = money.abs(d.difference);
    if (money.cmp(diff, tolerance) > 0) add('critical', 'DIFERENCIA_TOTAL', 'total', `El total del documento (${d.extractedTotal}) difiere del calculado (${d.calculatedTotal}) en ${d.difference}.`);
    else if (!money.isZero(diff)) add('info', 'DIFERENCIA_REDONDEO', 'total', `Diferencia de ${d.difference} dentro de la tolerancia (${tolerance}).`);
  }
  if (d.subtotal !== null && money.isPositive(d.subtotal) && money.isPositive(f.itbis)) {
    // El ITBIS puede ser MENOR al 18%/16% cuando hay partidas exentas (súper,
    // farmacia, etc.): no es un error. Sólo avisamos si el ITBIS SUPERA la tasa
    // máxima del monto, que es lo único que no puede pasar (más impuesto que base).
    const maxRate = Math.max(...ruleset.itbisRates.map(Number)) / 100;
    const maxItbis = money.multiply(d.subtotal, String(maxRate));
    if (money.cmp(money.sub(f.itbis, maxItbis), tolerance) > 0)
      add('warning', 'ITBIS_TASA', 'itbis', `El ITBIS (${f.itbis}) supera el ${Math.round(maxRate * 100)}% del monto (${maxItbis}); revise el monto o el ITBIS.`);
  }
  if (!blank(f.itbis) && money.isValid(f.itbis)) {
    if (money.cmp(safe(f.itbis_retenido) ?? '0', f.itbis) > 0) add('critical', 'ITBIS_RETENIDO_EXCEDE', 'itbis_retenido', 'El ITBIS retenido excede el ITBIS facturado.');
    if (format === '606') {
      if (money.cmp(safe(f.itbis_costo) ?? '0', f.itbis) > 0) add('critical', 'ITBIS_COSTO_EXCEDE', 'itbis_costo', 'El ITBIS llevado al costo excede el ITBIS facturado.');
      if (money.cmp(money.sum([f.itbis_costo, f.itbis_proporcionalidad]) ?? '0', f.itbis) > 0) add('warning', 'ITBIS_DISTRIBUCION', 'itbis_proporcionalidad', 'Proporcionalidad + costo superan el ITBIS facturado.');
    }
  }
  if (money.isPositive(f.propina) && d.subtotal !== null) {
    const expected = money.multiply(d.subtotal, String(Number(ruleset.propinaRate) / 100));
    if (money.cmp(money.abs(money.sub(f.propina, expected)), tolerance) > 0) add('warning', 'PROPINA_DIFERENTE', 'propina', `La propina no corresponde al ${ruleset.propinaRate}% legal (${expected}).`);
  }
  if (format === '606' && ncf.valid && ids.isConsumer(ncf.type)) add('warning', 'CONSUMO_SIN_CREDITO', 'ncf', 'Factura de consumo: no otorga crédito fiscal de ITBIS.');
  if (format === '606' && ncf.valid && ['B17', 'E47'].includes(ncf.type)) {
    for (const key of ['itbis_retenido', 'itbis_proporcionalidad', 'itbis_costo', 'isr_percibido', 'isc', 'otros_impuestos', 'propina']) {
      if (money.isPositive(f[key])) add('warning', 'B17_CAMPO_NO_APLICA', key, `${rules.FIELD_DEFS[key].label} no aplica a pagos al exterior (B17).`);
    }
  }
  if (format === '607') {
    const payments = rules.PAYMENT_FIELDS_607.map(k => f[k]);
    const paid = money.sum(payments);
    if (paid === null) add('critical', 'FORMA_PAGO_607_FALTA', 'pago_efectivo', 'Distribuya el total en las formas de pago (efectivo, tarjeta, crédito…).');
    else if (d.calculatedTotal !== null && money.cmp(paid, d.calculatedTotal) !== 0) add('critical', 'FORMA_PAGO_607_DIFERENCIA', 'pago_efectivo', `Las formas de pago suman ${paid} y el total con impuestos es ${d.calculatedTotal}.`);
    if (consumerSummary && !(format === '607' && ncf.electronic)) add('info', 'RESUMEN_CONSUMO', 'ncf', `Factura de consumo menor a RD$${Number(threshold).toLocaleString('en-US')}: se informa en el Resumen de Facturas de Consumo, no en el TXT.`);
  }

  // Duplicates and extraction confidence.
  // A repeated invoice: the copy processed later is blocked with a clear
  // "already processed" message; the original only gets a notice.
  const earlier = duplicates.filter(x => x.previous !== false)
    .sort((a, b) => (a.status === 'approved' ? 0 : 1) - (b.status === 'approved' ? 0 : 1) || String(a.created_at).localeCompare(String(b.created_at)));
  if (earlier.length) {
    const first = earlier[0];
    issues.push({ severity: 'critical', code: 'DUPLICADO', field: 'ncf', ref: first.id,
      message: `Comprobante repetido. El NCF ${f.ncf}${d.counterpartId ? ` (${d.counterpartId})` : ''} ya está ${first.state || (first.status === 'approved' ? 'aprobado' : 'en revisión')} en ${first.where || 'otro lote'}${first.export ? ` y ya se exportó en ${first.export}` : ''}. Esta es una copia: no se puede aprobar otra vez. Pulse «Descartar esta copia» para quitarla.` });
  } else if (duplicates.length) {
    issues.push({ severity: 'info', code: 'COPIA_POSTERIOR', field: 'ncf', ref: duplicates[0].id,
      message: `Esta factura se volvió a cargar después en ${duplicates[0].where || 'otro lote'}; esa copia está bloqueada y debe descartarse.` });
  }
  for (const key of extraction.lowConfidence || []) {
    if (correctedFields.includes(key) || !rules.FIELD_DEFS[key]) continue;
    // Si la moneda leída es DOP (la del país y en la que se reporta todo), no
    // avisamos de "baja confianza en Moneda": en RD el "$" es DOP y es lo esperado.
    if (key === 'moneda' && d.currency === 'DOP') continue;
    add('warning', 'BAJA_CONFIANZA', key, `Lectura de baja confianza en ${rules.FIELD_DEFS[key].label}; verifique contra el documento.`);
  }
  if (extraction.truncated && !correctedFields.includes('total')) add('warning', 'FACTURA_CORTADA', null, 'La factura podría continuar en otra página; verifique que los montos estén completos.');

  const critical = issues.filter(i => i.severity === 'critical').length;
  const warning = issues.filter(i => i.severity === 'warning').length;
  return { issues, critical_count: critical, warning_count: warning, rules_version: ruleset.version, computed: d, consumerSummary };
}

module.exports = { validate, derive, dopAmount, periodBounds, isoDate, AMOUNT_FIELDS, safe, blank };
