// Invoice extraction with OpenAI (vision + PDF input). The model only reads
// what is printed; it returns null for anything not visible and never
// computes totals. All arithmetic and fiscal checks happen in validate.js.
// The API key is read from the server environment (OPENAI_API_KEY), exactly
// as the existing NALA routes do, and never leaves the server.

const OPENAI_URL = (process.env.NALA_OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/chat/completions';
const MODEL = () => process.env.NALA_OPENAI_MODEL || 'gpt-4o';

const nullable = type => ({ type: [type, 'null'] });
const PARTY = { type: 'object', additionalProperties: false, required: ['nombre', 'rnc_cedula'], properties: { nombre: nullable('string'), rnc_cedula: nullable('string') } };
const AMOUNT_KEYS = ['monto_bienes', 'monto_servicios', 'subtotal', 'descuento', 'itbis', 'itbis_retenido', 'isr_retenido', 'isc', 'otros_impuestos', 'propina_legal', 'total'];
const INVOICE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['pagina_desde', 'pagina_hasta', 'continua_en_otra_pagina', 'emisor', 'receptor', 'ncf', 'ncf_modificado', 'fecha_emision', 'fecha_pago',
    'moneda_codigo', 'moneda_simbolo', ...AMOUNT_KEYS, 'forma_pago_texto', 'forma_pago_codigo', 'tipo_bienes_servicios_sugerido', 'tipo_ingreso_sugerido',
    'descripcion', 'campos_baja_confianza'],
  properties: {
    pagina_desde: { type: 'integer' }, pagina_hasta: { type: 'integer' }, continua_en_otra_pagina: { type: 'boolean' },
    emisor: PARTY, receptor: PARTY,
    ncf: nullable('string'), ncf_modificado: nullable('string'),
    fecha_emision: nullable('string'), fecha_pago: nullable('string'),
    moneda_codigo: nullable('string'), moneda_simbolo: nullable('string'),
    ...Object.fromEntries(AMOUNT_KEYS.map(k => [k, nullable('string')])),
    forma_pago_texto: nullable('string'), forma_pago_codigo: nullable('string'),
    tipo_bienes_servicios_sugerido: nullable('string'), tipo_ingreso_sugerido: nullable('string'),
    descripcion: nullable('string'),
    campos_baja_confianza: { type: 'array', items: { type: 'string' } },
  },
};
const RESPONSE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['facturas', 'paginas_sin_factura'],
  properties: { facturas: { type: 'array', items: INVOICE_SCHEMA }, paginas_sin_factura: { type: 'array', items: { type: 'integer' } } },
};

const PROMPT = `Eres un lector de comprobantes fiscales de República Dominicana. Transcribe datos; no calcules ni supongas.
Reglas:
- El material puede tener varias páginas y varias facturas por página, o una factura que ocupa varias páginas. Devuelve UNA entrada por cada comprobante (NCF/e-CF) distinto, con las páginas (numeradas desde 1 dentro de este material) donde aparece.
- Si un dato no está impreso o no es legible, devuelve null. Nunca pongas 0 para un monto que no aparece. Nunca inventes un NCF, RNC o fecha.
- Montos: transcribe el valor impreso normalizado con punto decimal y sin separador de miles (ej. "1,234.50" → "1234.50"). No sumes ni calcules montos que no estén impresos. ÚNICA excepción (compras 606): si la base sin impuestos no está impresa por separado pero sí el Total y el ITBIS, la base de bienes/servicios = Total − ITBIS − otros impuestos impresos (ISC, otros, propina). Nunca uses el Total con impuestos como base.
- subtotal: el monto antes de impuestos tal como aparece impreso.
- monto_bienes vs monto_servicios: clasifica la base (SIEMPRE sin impuestos: no incluyas ITBIS, ISC ni otros impuestos) según lo que se compra. BIENES = productos/mercancía (ferretería, repuestos, combustible/gasolina, supermercado, materiales, equipos). SERVICIOS = restaurante/bar/hotel, honorarios, consultoría, alquiler, mano de obra, reparación, telecomunicaciones, energía eléctrica, agua, transporte, seguros. POLÍTICA DE LA FIRMA: coloca SIEMPRE la base en monto_bienes (aunque sea un servicio); deja monto_servicios en null. En recibos de supermercado/retail donde sólo se imprime el Total (con ITBIS incluido) y el ITBIS por separado, la base = Total − ITBIS − otros impuestos impresos; NO pongas el Total con impuestos como base. Si el recibo muestra «Subtotal Gravado» y «Subtotal Exento» por separado, la base es la SUMA de ambos (los bienes/servicios exentos también forman parte del monto facturado; sólo se excluyen el ITBIS y demás impuestos). Equivale a Total − ITBIS − otros impuestos. Regla firme: si aparece "propina legal" (normalmente 10%), es un consumo de restaurante/bar y la base va SIEMPRE en monto_servicios, NUNCA en monto_bienes.
- IMPORTANTE: no dejes en null un monto que SÍ aparece impreso. Búscalo activamente y transcríbelo:
  · total: el total final del comprobante. Etiquetas típicas: "Total", "TOTAL", "Total a Pagar", "Total General", "Total RD$", "Valor Total", "Monto Total", "Neto a Pagar". Suele ser el número más grande, abajo a la derecha. Transcribe el impreso; no lo calcules.
  · subtotal: el monto antes de impuestos ("Subtotal", "Sub-Total", "Valor", "Importe", "Gravado", "Base Imponible").
  · itbis: el ITBIS/IVA impreso. Etiquetas: "ITBIS", "I.T.B.I.S.", "ITBIS 18%", "ITBIS 16%", "Impuesto", "IVA", "Tax". Captura el valor impreso aunque el ITBIS venga incluido en el precio ("ITBIS incluido"). En recibos de supermercado/ferretería/retail el ITBIS casi siempre está impreso, a veces en varias líneas por tasa (ITBIS 18%, ITBIS 16%…) que debes SUMAR. Búscalo siempre; no lo calcules ni lo pongas en 0; déjalo null SÓLO si de verdad no aparece en el documento.
- itbis_retenido e isr_retenido: sólo si el documento los muestra.
- propina_legal: la propina legal (10%) si aparece. isc: impuesto selectivo. otros_impuestos: otras tasas impresas (ej. CDT).
- moneda_simbolo: el símbolo o texto exacto impreso junto a los montos ("RD$", "US$", "$", "USD", "€"…). moneda_codigo: el código ISO SOLO si el documento lo indica explícitamente (RD$ o "pesos dominicanos" → DOP; US$, USD o "dólares" → USD). Si sólo aparece "$", moneda_codigo = null.
- fecha_emision: la fecha impresa del comprobante, normalizada a AAAA-MM-DD. Acepta cualquier formato impreso y conviértelo (DD/MM/AAAA, DD-MM-AAAA, "15 de enero de 2026", AAAAMMDD). En República Dominicana el orden es día/mes/año: "05/03/2026" = 2026-03-05, NO 2026-05-03. No inviertas día y mes. No inventes el día si no aparece. fecha_pago sólo si está impresa.
- ncf / e-CF: transcribe el comprobante fiscal EXACTAMENTE como está impreso, carácter por carácter, en mayúsculas y SIN espacios ni guiones. Formatos válidos: NCF = una letra (B, A, P…) + 2 dígitos + 8 dígitos = 11 caracteres; e-CF = la letra E + 2 dígitos + 10 dígitos = 13 caracteres. Búscalo junto a etiquetas como "NCF", "e-CF", "NCF/e-CF", "Comprobante", "No. Comprobante", "Comprobante Fiscal". NO lo confundas con el número de factura interno, de orden, de pedido ni de cotización. Antes de responder, cuenta los dígitos y verifica que el total de caracteres sea 11 o 13; si no cuadra o algún carácter es dudoso, pon "ncf" en campos_baja_confianza. ncf_modificado: sólo en notas de crédito/débito, con el mismo cuidado.
- emisor: quien EMITE el comprobante; su RNC suele estar arriba, junto al logo/membrete o la razón social del vendedor. receptor: el cliente/comprador; su RNC suele aparecer bajo "Cliente", "Señores", "Facturar a", "RNC Cliente" o "RNC/Cédula". NO intercambies los dos RNC. rnc_cedula: SÓLO los dígitos, completos y sin puntos ni guiones; RNC de empresa = 9 dígitos, cédula = 11 dígitos. Transcríbelo dígito por dígito; si falta un dígito o alguno es dudoso, pon "emisor" o "receptor" en campos_baja_confianza en vez de adivinar.
- forma_pago_codigo sólo si la forma de pago es identificable: 01 efectivo, 02 cheque/transferencia/depósito, 03 tarjeta, 04 crédito, 05 permuta, 06 nota de crédito, 07 mixto.
- tipo_bienes_servicios_sugerido (compras 606, 01-11) y tipo_ingreso_sugerido (ventas 607, 01-06): tu mejor clasificación; será confirmada por un humano.
- campos_baja_confianza: nombres de campos cuya lectura sea dudosa.
- paginas_sin_factura: páginas que no contienen ningún comprobante.`;

function mapCurrency(code, symbol) {
  const c = String(code || '').trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(c)) return c;
  const s = String(symbol || '').trim().toUpperCase().replace(/\s+/g, '');
  if (['RD$', 'RD', 'DOP', 'RDS'].includes(s)) return 'DOP';
  if (['US$', 'USD', 'U$S', 'U$'].includes(s)) return 'USD';
  if (['€', 'EUR'].includes(s)) return 'EUR';
  return null; // "$" alone is ambiguous by design
}

const cleanAmount = v => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim().replace(/[^\d.,-]/g, '');
  if (!t) return null;
  const normalized = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t) ? t.replace(/,/g, '') : t;
  return /^-?\d+(\.\d+)?$/.test(normalized) ? normalized : String(v);
};
const cleanDate = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()) ? String(v).trim() : (v ? String(v).trim() : null));
const cleanId = v => (v ? String(v).replace(/\D/g, '') || null : null);
const code2 = v => (/^\d{1,2}$/.test(String(v || '').trim()) ? String(v).trim().padStart(2, '0') : null);

// Maps one extracted invoice to NALA's canonical fields for a 606 or 607 batch.
function toFields(format, inv, clientSettings = {}) {
  const suggested = [];
  const lowConfidenceRaw = Array.isArray(inv.campos_baja_confianza) ? inv.campos_baja_confianza : [];
  const f = {
    emisor_nombre: inv.emisor?.nombre || null, emisor_id: cleanId(inv.emisor?.rnc_cedula),
    receptor_nombre: inv.receptor?.nombre || null, receptor_id: cleanId(inv.receptor?.rnc_cedula),
    ncf: inv.ncf ? String(inv.ncf).trim().toUpperCase().replace(/\s+/g, '') : null,
    ncf_modificado: inv.ncf_modificado ? String(inv.ncf_modificado).trim().toUpperCase().replace(/\s+/g, '') : null,
    fecha_comprobante: cleanDate(inv.fecha_emision),
    moneda: 'DOP', // siempre pesos (obligatorio)
    moneda_simbolo: inv.moneda_simbolo || null,
    itbis: cleanAmount(inv.itbis), itbis_retenido: cleanAmount(inv.itbis_retenido), isr_retenido: cleanAmount(inv.isr_retenido),
    isc: cleanAmount(inv.isc), otros_impuestos: cleanAmount(inv.otros_impuestos), propina: cleanAmount(inv.propina_legal),
    total: cleanAmount(inv.total),
  };
  const subtotal = cleanAmount(inv.subtotal);
  if (format === '606') {
    f.monto_bienes = cleanAmount(inv.monto_bienes);
    f.monto_servicios = cleanAmount(inv.monto_servicios);
    // Política: la base de las compras (606) se arrastra SIEMPRE por BIENES. Si el modelo la puso en
    // servicios (o repartió entre ambas), todo se junta en bienes; el auditor puede cambiarla a mano.
    if (f.monto_servicios !== null) {
      const sum = (f.monto_bienes !== null ? Number(f.monto_bienes) : 0) + Number(f.monto_servicios);
      f.monto_bienes = Number.isFinite(sum) ? sum.toFixed(2) : f.monto_bienes;
      f.monto_servicios = null;
    }
    if (f.monto_bienes === null && subtotal !== null) f.monto_bienes = subtotal;
    f.fecha_pago = cleanDate(inv.fecha_pago);
    f.forma_pago = code2(inv.forma_pago_codigo) || code2(clientSettings.default_forma_pago);
    if (clientSettings.default_tipo_bienes_servicios) f.tipo_bienes_servicios = code2(clientSettings.default_tipo_bienes_servicios);
    else if (code2(inv.tipo_bienes_servicios_sugerido)) { f.tipo_bienes_servicios = code2(inv.tipo_bienes_servicios_sugerido); suggested.push('tipo_bienes_servicios'); }
    else f.tipo_bienes_servicios = null;
  } else {
    f.monto_facturado = subtotal;
    if (clientSettings.default_tipo_ingreso) f.tipo_ingreso = code2(clientSettings.default_tipo_ingreso);
    else if (code2(inv.tipo_ingreso_sugerido)) { f.tipo_ingreso = code2(inv.tipo_ingreso_sugerido); suggested.push('tipo_ingreso'); }
    else f.tipo_ingreso = null;
    // With a single identified payment method the whole printed total belongs
    // to it; mixed or unknown methods are left for the auditor.
    const bucket = { '01': 'pago_efectivo', '02': 'pago_cheque', '03': 'pago_tarjeta', '04': 'pago_credito', '05': 'pago_permuta' }[code2(inv.forma_pago_codigo)];
    if (bucket && f.total !== null) { f[bucket] = f.total; suggested.push(bucket); }
  }
  const map = { emisor: ['emisor_nombre', 'emisor_id'], receptor: ['receptor_nombre', 'receptor_id'], fecha_emision: ['fecha_comprobante'], subtotal: [format === '606' ? 'monto_bienes' : 'monto_facturado'],
    propina_legal: ['propina'], moneda_codigo: ['moneda'], moneda_simbolo: ['moneda'] };
  const lowConfidence = [...new Set(lowConfidenceRaw.flatMap(k => map[k] || [k]))];
  return { fields: f, suggested, lowConfidence, truncated: !!inv.continua_en_otra_pagina };
}

class ExtractionError extends Error {
  constructor(message, { retryable = true, status = null } = {}) { super(message); this.retryable = retryable; this.status = status; }
}

// parts: [{ kind: 'image', mimeType, base64 } | { kind: 'pdf', base64, filename }]
// ocrText: texto opcional de un OCR previo (Tesseract) como referencia; la
// imagen sigue mandando y el OCR sólo ayuda a cotejar números difíciles.
async function extract({ format, documentName, pageFrom, pageTo, parts, ocrText = null, signal }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new ExtractionError('OPENAI_API_KEY no está configurada en el servidor.', { retryable: false });
  const content = [{ type: 'text', text: `${PROMPT}\n\nFormato del lote: ${format === '606' ? '606 (compras: el emisor es el proveedor)' : '607 (ventas: el receptor es el cliente)'}.\nDocumento: ${documentName} (páginas ${pageFrom}-${pageTo}).` }];
  for (const part of parts) {
    if (part.kind === 'image') content.push({ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.base64}`, detail: 'high' } });
    else content.push({ type: 'file', file: { filename: part.filename, file_data: `data:application/pdf;base64,${part.base64}` } });
  }
  if (ocrText && String(ocrText).trim()) {
    content.push({ type: 'text', text: `Texto OCR de referencia (Tesseract; puede traer errores de lectura). Úsalo SÓLO para cotejar y no dejar vacíos montos, NCF o RNC cuando la imagen sea difícil de leer. Si hay conflicto, manda lo que ves en la imagen; no copies ciegamente del OCR:\n"""\n${String(ocrText).trim().slice(0, 6000)}\n"""` });
  }
  let response;
  try {
    response = await fetch(OPENAI_URL, {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL(), temperature: 0, max_tokens: 8000,
        messages: [{ role: 'user', content }],
        response_format: { type: 'json_schema', json_schema: { name: 'comprobantes', strict: true, schema: RESPONSE_SCHEMA } },
      }),
    });
  } catch (error) {
    throw new ExtractionError(`No se pudo contactar el servicio de IA: ${error.message}`);
  }
  if (!response.ok) {
    const text = (await response.text()).slice(0, 500);
    const retryable = response.status === 429 || response.status >= 500;
    throw new ExtractionError(`Servicio de IA respondió ${response.status}: ${text}`, { retryable, status: response.status });
  }
  const data = await response.json();
  const choice = data.choices?.[0];
  if (choice?.message?.refusal) throw new ExtractionError(`La IA rechazó el documento: ${choice.message.refusal}`, { retryable: false });
  let parsed;
  try { parsed = JSON.parse(choice?.message?.content || ''); } catch { throw new ExtractionError('La respuesta de la IA no es JSON válido.'); }
  if (!Array.isArray(parsed.facturas)) throw new ExtractionError('La respuesta de la IA no contiene facturas.');
  return { invoices: parsed.facturas, emptyPages: parsed.paginas_sin_factura || [], model: data.model || MODEL(), usage: data.usage || null };
}

module.exports = { extract, toFields, mapCurrency, ExtractionError, RESPONSE_SCHEMA, PROMPT };
