import auth from '../../lib/auth.js';
import rl from '../../lib/rate-limit.js';
import ocr from '../../lib/nala/ocr.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = await auth.authenticate(req);
  if (!session) return res.status(401).json({ error: 'No autorizado' });
  if (session.role !== 'admin' && !session.access_nala) {
    return res.status(403).json({ error: 'Sin acceso a NALA' });
  }
  // Límite por usuario: el análisis usa visión de OpenAI (costoso), ritmo acotado.
  // El Asistente lee varias facturas en paralelo; se da margen para ese caso.
  if (!await rl.allow(req, 'nala-analyze', 120, 60 * 1000, session.userId)) {
    return res.status(429).json({ error: 'Demasiadas solicitudes. Espera un momento.' });
  }

  const { base64, mimeType, pdfText, mode } = req.body || {};
  if (!base64 && !pdfText) return res.status(400).json({ error: 'archivo requerido' });
  if ((base64 && typeof base64 !== 'string') || (pdfText && typeof pdfText !== 'string')) return res.status(400).json({ error: 'Formato de archivo inválido.' });
  if ((typeof base64 === 'string' && base64.length > 12 * 1024 * 1024) || (typeof pdfText === 'string' && pdfText.length > 500000)) {
    return res.status(413).json({ error: 'El archivo supera el tamaño permitido para análisis.' });
  }
  if (mimeType && (typeof mimeType !== 'string' || !/^(image\/(jpeg|png|webp)|application\/pdf|text\/plain)$/i.test(mimeType))) {
    return res.status(400).json({ error: 'Tipo de archivo no permitido.' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key no configurada' });

  const tipo = mode === 'IR17' ? 'IR17' : (mode === '607' ? '607' : '606');

  const prompt606 = `Eres un experto en comprobantes fiscales de República Dominicana para el formulario 606 (Compras).
Extrae EXACTAMENTE estos campos del comprobante y responde SOLO con JSON válido:

{
  "proveedor": "Nombre o razón social del proveedor/emisor. Vacío si no aparece.",
  "moneda": "DOP o USD. USD solo si dice explícitamente US$, USD o dólares. Siempre DOP si no se especifica.",
  "rncCedula": "RNC (9 dígitos) o Cédula (11 dígitos) del proveedor, solo números sin guiones. Si no aparece pon cadena vacía.",
  "tipoId": "1 si es RNC (9 dígitos), 2 si es Cédula (11 dígitos). Vacío si no hay número.",
  "tipoBienesServicios": "Código 01-11 según: 01=GASTOS DE PERSONAL, 02=GASTOS POR TRABAJOS/SUMINISTROS/SERVICIOS, 03=ARRENDAMIENTOS, 04=GASTOS DE ACTIVOS FIJO, 05=GASTOS DE REPRESENTACIÓN, 06=OTRAS DEDUCCIONES ADMITIDAS, 07=GASTOS FINANCIEROS, 08=GASTOS EXTRAORDINARIOS, 09=COMPRAS Y GASTOS DEL COSTO DE VENTA, 10=ADQUISICIONES DE ACTIVOS, 11=GASTOS DE SEGUROS",
  "ncf": "Número de Comprobante Fiscal completo (ej: B0100000001)",
  "ncfModificado": "NCF modificado si aplica. Vacío si no.",
  "fechaComprobante": "Año y mes en formato YYYYMM (solo 6 dígitos)",
  "diaComprobante": "Día en formato DD (2 dígitos, ej: 05)",
  "fechaPago": "YYYYMM si hay retención de ITBIS o ISR. Vacío si no hay retención.",
  "diaPago": "DD si hay retención. Vacío si no hay retención.",
  "montoFacturadoServicios": 0,
  "montoFacturadoBienes": 0,
  "totalMontoFacturado": 0,
  "itbisFacturado": 0,
  "itbisRetenido": 0,
  "itbisProporcionalidad": 0,
  "itbisLlevadoCosto": 0,
  "itbisPorAdelantar": 0,
  "itbisPercibidoCompras": 0,
  "tipoRetencionIsr": "00",
  "montoRetencionRenta": 0,
  "isrPercibidoCompras": 0,
  "isc": 0,
  "otrosImpuestos": 0,
  "montoPropinaLegal": 0,
  "formaPago": "01=EFECTIVO, 02=CHEQUES/TRANSFERENCIAS/DEPÓSITO, 03=TARJETA CRÉDITO/DÉBITO, 04=COMPRA A CRÉDITO, 05=PERMUTA, 06=NOTA DE CRÉDITO, 07=MIXTO"
}

IMPORTANTE:
- totalMontoFacturado = montoFacturadoServicios + montoFacturadoBienes (sin ITBIS)
- El monto sin ITBIS va en servicios o bienes según corresponda
- itbisFacturado = monto del ITBIS (18% normalmente)
- Todos los montos son números, no strings
- formaPago: usa solo el código (01, 02, etc.)
- tipoRetencionIsr: usa "00" si no hay retención ISR
- SOLO responde con el JSON, sin explicaciones`;

  const prompt607 = `Eres un experto en comprobantes fiscales de República Dominicana para el formulario 607 (Ventas).
Extrae EXACTAMENTE estos campos del comprobante y responde SOLO con JSON válido:

{
  "cliente": "Nombre o razón social del cliente/receptor. Vacío si no aparece.",
  "moneda": "DOP o USD. USD solo si dice explícitamente US$, USD o dólares. Siempre DOP si no se especifica.",
  "rncCedulaPasaporte": "RNC (9 dígitos), Cédula (11 dígitos) o vacío si no aparece.",
  "tipoId": "1 si es RNC, 2 si es Cédula. Vacío si no hay número.",
  "ncf": "Número de Comprobante Fiscal completo",
  "ncfModificado": "NCF modificado si aplica. Vacío si no.",
  "tipoIngreso": "01=INGRESOS POR OPERACIONES (NO FINANCIEROS), 02=INGRESOS FINANCIEROS, 03=INGRESOS EXTRAORDINARIOS, 04=INGRESOS POR ARRENDAMIENTOS, 05=INGRESOS POR VENTA DE ACTIVO DEPRECIABLE, 06=OTROS INGRESOS",
  "fechaComprobante": "YYYYMM",
  "diaComprobante": "DD",
  "fechaRetencion": "YYYYMM si hay retención por terceros. Vacío si no.",
  "diaRetencion": "DD si hay retención. Vacío si no.",
  "montoFacturado": 0,
  "itbisFacturado": 0,
  "itbisRetenidoTerceros": 0,
  "itbisPercibido": 0,
  "retencionRentaTerceros": 0,
  "isrPercibido": 0,
  "isc": 0,
  "otrosImpuestos": 0,
  "montoPropinaLegal": 0,
  "efectivo": 0,
  "chequeTransferenciaDeposito": 0,
  "tarjetaDebitoCredito": 0,
  "ventaCredito": 0,
  "bonosCertificadosRegalo": 0,
  "permuta": 0,
  "otrasFormasVentas": 0
}

IMPORTANTE:
- montoFacturado = monto total SIN ITBIS
- itbisFacturado = monto del ITBIS
- La forma de pago va distribuida en los campos de pago (efectivo, tarjeta, etc.)
- Todos los montos son números, no strings
- tipoIngreso: usa solo el código (01, 02, etc.)
- SOLO responde con el JSON, sin explicaciones`;

  const promptIR17 = `Eres un experto en comprobantes fiscales de República Dominicana para el formulario IR-17 (Retenciones de ISR).
Extrae EXACTAMENTE estos campos del comprobante de retención y responde SOLO con JSON válido:

{
  "retenido": "Nombre o razón social de quien se le retuvo el ISR. Vacío si no aparece.",
  "rncCedula": "RNC (9 dígitos) o Cédula (11 dígitos) del retenido, solo números sin guiones. Vacío si no aparece.",
  "tipoId": "1 si es RNC (9 dígitos), 2 si es Cédula (11 dígitos), 3 si es Pasaporte. Vacío si no hay número.",
  "tipoRenta": "Código 01-11 según: 01=SUELDOS Y SALARIOS, 02=HONORARIOS POR SERVICIOS, 03=ARRENDAMIENTOS, 04=DIVIDENDOS, 05=INTERESES, 06=PREMIOS O GANANCIAS, 07=OTRAS RENTAS, 08=OTRAS RENTAS GOBIERNO, 09=RETENCIONES EN EL EXTERIOR, 10=RENDIMIENTOS DEPÓSITOS A PLAZO, 11=RETENCIONES ITBIS AL GOBIERNO",
  "montoRenta": 0,
  "isrRetenido": 0,
  "itbisRetenido": 0,
  "fechaPago": "YYYYMM del período de pago/retención",
  "diaPago": "DD del día de pago"
}

IMPORTANTE:
- montoRenta = monto total pagado/acreditado ANTES de la retención
- isrRetenido = monto del ISR retenido (suele ser 10% sobre honorarios, 25% sobre dividendos, 27% sobre sueldos etc.)
- itbisRetenido = monto del ITBIS retenido si aplica (0 si no hay retención de ITBIS)
- tipoRenta: usa solo el código (01, 02, etc.)
- Si es factura de servicios profesionales/consultoría, tipoRenta es "02"
- Si es factura de arrendamiento, tipoRenta es "03"
- Si es nómina o sueldo, tipoRenta es "01"
- Todos los montos son números, no strings
- SOLO responde con el JSON, sin explicaciones`;

  const systemPrompt = tipo === 'IR17' ? promptIR17 : (tipo === '607' ? prompt607 : prompt606);
  const isImage = base64 && mimeType && mimeType.startsWith('image/');

  // OCR previo opcional (Tesseract) como apoyo del modelo de visión, igual que
  // en el lote. Sólo corre si NALA_OCR_TESSERACT está encendido y nunca
  // interrumpe el análisis (ante cualquier fallo devuelve null).
  let ocrText = null;
  if (isImage) {
    ocrText = await ocr.ocrImageParts([{ kind: 'image', base64 }]).catch(() => null);
  }

  let messages;
  if (isImage) {
    messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: systemPrompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'high' } },
          ...(ocrText ? [{ type: 'text', text: `Texto OCR de referencia (Tesseract; puede traer errores). Úsalo para no dejar vacíos montos, NCF o RNC; si hay conflicto, manda lo que ves en la imagen:\n"""\n${ocrText}\n"""` }] : []),
        ],
      },
    ];
  } else {
    messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Extrae los datos de este comprobante fiscal:\n\n${pdfText || base64}` },
    ];
  }

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: isImage ? 'gpt-4o' : 'gpt-4o-mini',
        max_tokens: 1024,
        messages,
        response_format: { type: 'json_object' },
      }),
    });

    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: err });
    }

    const data = await r.json();
    const raw = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    res.json({ data: parsed, tipo });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Error interno del servidor' });
  }
}
