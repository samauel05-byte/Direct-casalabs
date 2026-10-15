// Versioned fiscal rules. Every validation and export records the ruleset
// version it used so a later rule change never silently alters history.
// Sources: DGII Norma General 07-2018 (y 05-2019, 10-2018), instructivos de
// llenado 606 (feb. 2026) y 607 (dic. 2025) y las macros oficiales de las
// herramientas "Formato de Envío 606/607" (ver docs/nala/dgii-606-607.md).

const RULESETS = [
  {
    version: 'DGII-NG07-2018/2026.09',
    effectiveFrom: '201805',
    itbisRates: ['18', '16'],          // tasa general y tasa reducida (Ley 253-12)
    propinaRate: '10',                 // Ley 54-32
    consumerSummaryThreshold: '250000.00', // NG 10-2018: B02 < RD$250,000 van en resumen
    maxRecords: { '606': 10000, '607': 65000 },
    ncfTypes: {
      // Series aceptadas por la expresión regular de cada herramienta oficial.
      '606': ['B01', 'B02', 'B03', 'B04', 'B11', 'B12', 'B13', 'B14', 'B15', 'B17', 'E31', 'E32', 'E33', 'E34', 'E41', 'E43', 'E44', 'E45', 'E47'],
      // La herramienta 607 (v2023.1.1) no acepta series E: los e-CF emitidos
      // llegan a la DGII por facturación electrónica y se excluyen del TXT.
      '607': ['B01', 'B02', 'B03', 'B04', 'B11', 'B12', 'B13', 'B14', 'B15', 'B16'],
    },
    tipoBienesServicios: {
      '01': 'Gastos de personal', '02': 'Gastos por trabajos, suministros y servicios', '03': 'Arrendamientos',
      '04': 'Gastos de activos fijos', '05': 'Gastos de representación', '06': 'Otras deducciones admitidas',
      '07': 'Gastos financieros', '08': 'Gastos extraordinarios', '09': 'Compras y gastos que formarán parte del costo de venta',
      '10': 'Adquisiciones de activos', '11': 'Gastos de seguros',
    },
    tipoRetencionIsr: {
      '01': 'Alquileres', '02': 'Honorarios por servicios', '03': 'Otras rentas', '04': 'Otras rentas (rentas presuntas)',
      '05': 'Intereses pagados a personas jurídicas residentes', '06': 'Intereses pagados a personas físicas residentes',
      '07': 'Retención por proveedores del Estado', '08': 'Juegos telefónicos', '09': 'Retenciones subsector de ganadería de carne bovina',
    },
    formaPago: {
      '01': 'Efectivo', '02': 'Cheques/Transferencias/Depósito', '03': 'Tarjeta crédito/débito', '04': 'Compra a crédito',
      '05': 'Permuta', '06': 'Notas de crédito', '07': 'Mixto',
    },
    tipoIngreso: {
      '01': 'Ingresos por operaciones (no financieros)', '02': 'Ingresos financieros', '03': 'Ingresos extraordinarios',
      '04': 'Ingresos por arrendamientos', '05': 'Ingresos por venta de activo depreciable', '06': 'Otros ingresos',
    },
    tipoId: { '1': 'RNC', '2': 'Cédula', '3': 'Pasaporte o ID tributaria' },
  },
];

const CURRENT = RULESETS[RULESETS.length - 1];

function forPeriod(period) {
  const eligible = RULESETS.filter(r => String(period || '') >= r.effectiveFrom);
  return eligible.length ? eligible[eligible.length - 1] : CURRENT;
}

function byVersion(version) {
  return RULESETS.find(r => r.version === version) || null;
}

// Canonical invoice fields shared by both formats. Types: text, id, ncf, date,
// amount, code, currency, rate.
const FIELD_DEFS = {
  emisor_nombre: { label: 'Emisor', type: 'text' },
  emisor_id: { label: 'RNC/Cédula emisor', type: 'id' },
  receptor_nombre: { label: 'Receptor', type: 'text' },
  receptor_id: { label: 'RNC/Cédula receptor', type: 'id' },
  tipo_id: { label: 'Tipo Id', type: 'code' },
  ncf: { label: 'NCF / e-CF', type: 'ncf' },
  ncf_modificado: { label: 'NCF modificado', type: 'ncf' },
  fecha_comprobante: { label: 'Fecha comprobante', type: 'date' },
  fecha_pago: { label: 'Fecha pago', type: 'date' },
  fecha_retencion: { label: 'Fecha retención', type: 'date' },
  moneda: { label: 'Moneda', type: 'currency' },
  moneda_simbolo: { label: 'Símbolo impreso', type: 'text' },
  tasa_cambio: { label: 'Tasa de cambio', type: 'rate' },
  tasa_fecha: { label: 'Fecha de la tasa', type: 'date' },
  tasa_fuente: { label: 'Fuente de la tasa', type: 'text' },
  tipo_bienes_servicios: { label: 'Tipo bienes y servicios', type: 'code' },
  tipo_ingreso: { label: 'Tipo de ingreso', type: 'code' },
  forma_pago: { label: 'Forma de pago', type: 'code' },
  monto_servicios: { label: 'Monto servicios', type: 'amount' },
  monto_bienes: { label: 'Monto bienes', type: 'amount' },
  monto_facturado: { label: 'Monto facturado (sin impuestos)', type: 'amount' },
  itbis: { label: 'ITBIS facturado', type: 'amount' },
  itbis_retenido: { label: 'ITBIS retenido', type: 'amount' },
  itbis_proporcionalidad: { label: 'ITBIS sujeto a proporcionalidad', type: 'amount' },
  itbis_costo: { label: 'ITBIS llevado al costo', type: 'amount' },
  itbis_percibido: { label: 'ITBIS percibido', type: 'amount' },
  isr_tipo_retencion: { label: 'Tipo retención ISR', type: 'code' },
  isr_retenido: { label: 'Retención renta', type: 'amount' },
  isr_percibido: { label: 'ISR percibido', type: 'amount' },
  isc: { label: 'Impuesto selectivo', type: 'amount' },
  otros_impuestos: { label: 'Otros impuestos/tasas', type: 'amount' },
  propina: { label: 'Propina legal', type: 'amount' },
  total: { label: 'Total (automático)', type: 'amount' },
  pago_efectivo: { label: 'Efectivo', type: 'amount' },
  pago_cheque: { label: 'Cheque/Transferencia/Depósito', type: 'amount' },
  pago_tarjeta: { label: 'Tarjeta débito/crédito', type: 'amount' },
  pago_credito: { label: 'Venta a crédito', type: 'amount' },
  pago_bonos: { label: 'Bonos o certificados de regalo', type: 'amount' },
  pago_permuta: { label: 'Permuta', type: 'amount' },
  pago_otros: { label: 'Otras formas de venta', type: 'amount' },
};

const FORMAT_FIELDS = {
  '606': ['emisor_nombre', 'emisor_id', 'receptor_nombre', 'receptor_id', 'tipo_id', 'tipo_bienes_servicios', 'ncf', 'ncf_modificado',
    'fecha_comprobante', 'fecha_pago', 'moneda', 'moneda_simbolo', 'tasa_cambio', 'tasa_fecha', 'tasa_fuente', 'monto_servicios', 'monto_bienes',
    'itbis', 'itbis_retenido', 'itbis_proporcionalidad', 'itbis_costo', 'itbis_percibido', 'isr_tipo_retencion', 'isr_retenido',
    'isr_percibido', 'isc', 'otros_impuestos', 'propina', 'total', 'forma_pago'],
  '607': ['emisor_nombre', 'emisor_id', 'receptor_nombre', 'receptor_id', 'tipo_id', 'ncf', 'ncf_modificado', 'tipo_ingreso',
    'fecha_comprobante', 'fecha_retencion', 'moneda', 'moneda_simbolo', 'tasa_cambio', 'tasa_fecha', 'tasa_fuente', 'monto_facturado', 'itbis',
    'itbis_retenido', 'itbis_percibido', 'isr_retenido', 'isr_percibido', 'isc', 'otros_impuestos', 'propina', 'total',
    'pago_efectivo', 'pago_cheque', 'pago_tarjeta', 'pago_credito', 'pago_bonos', 'pago_permuta', 'pago_otros'],
};

const PAYMENT_FIELDS_607 = ['pago_efectivo', 'pago_cheque', 'pago_tarjeta', 'pago_credito', 'pago_bonos', 'pago_permuta', 'pago_otros'];

module.exports = { RULESETS, CURRENT, forPeriod, byVersion, FIELD_DEFS, FORMAT_FIELDS, PAYMENT_FIELDS_607 };
