// Ajustes de nómina por empresa: tasas de ley RD (empleado), escala del ISR y
// aportes del empleador. Configurables desde Ajustes; si una empresa no tiene
// fila en nomina_settings, se usan estos valores por defecto. Las tasas son
// fracciones (0.0287 = 2.87%).
const supabase = require('../supabase');
const h = require('../nala/http');

// Vigentes a la fecha (DGII / TSS, RD). Editables por empresa.
const DEFAULTS = {
  period_type: 'quincenal',               // 'quincenal' | 'mensual'
  empleado: {
    afp: 0.0287,                           // Pensión (AFP), aporte del empleado
    sfs: 0.0304,                           // Salud (SFS/SDSS), aporte del empleado
    tope_sfs: 134820,                      // Salario cotizable máximo para el SFS
    tope_afp: 404460,                      // Salario cotizable máximo para la AFP
  },
  isr: {                                   // Escala anual del ISR sobre asalariados
    exento: 416220.00,                     // hasta aquí, 0%
    tramo2: 624329.00,                     // 15% del excedente de "exento"
    tramo3: 867123.00,                     // +20% del excedente de "tramo2"
    // sobre "tramo3": +25% del excedente
  },
  empleador: {
    afp: 0.0710,                           // Pensión, aporte del empleador
    sfs: 0.0709,                           // Salud, aporte del empleador
    srl: 0.0120,                           // Seguro de Riesgos Laborales (≈1.2%)
    infotep: 0.0100,                       // INFOTEP 1% de la nómina
  },
};

// Mezcla superficial por secciones: lo que el usuario guardó pisa el default,
// pero nunca se pierde una clave que el usuario no tocó.
function merge(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  return {
    period_type: s.period_type === 'mensual' ? 'mensual' : 'quincenal',
    empleado: { ...DEFAULTS.empleado, ...(s.empleado || {}) },
    isr: { ...DEFAULTS.isr, ...(s.isr || {}) },
    empleador: { ...DEFAULTS.empleador, ...(s.empleador || {}) },
  };
}

async function load(tenantId, clientId) {
  const { data, error } = await supabase.from('nomina_settings').select('settings').eq('tenant_id', tenantId).eq('client_id', clientId).maybeSingle();
  h.dbError(error);
  return merge(data?.settings);
}

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const rate = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 1 ? n : d; };

// Normaliza/valida lo que llega del cliente antes de guardar (nunca confía en
// montos o tasas fuera de rango).
function sanitize(body) {
  const d = DEFAULTS;
  const e = body.empleado || {}; const i = body.isr || {}; const p = body.empleador || {};
  return {
    period_type: body.period_type === 'mensual' ? 'mensual' : 'quincenal',
    empleado: { afp: rate(e.afp, d.empleado.afp), sfs: rate(e.sfs, d.empleado.sfs), tope_sfs: num(e.tope_sfs, d.empleado.tope_sfs), tope_afp: num(e.tope_afp, d.empleado.tope_afp) },
    isr: { exento: num(i.exento, d.isr.exento), tramo2: num(i.tramo2, d.isr.tramo2), tramo3: num(i.tramo3, d.isr.tramo3) },
    empleador: { afp: rate(p.afp, d.empleador.afp), sfs: rate(p.sfs, d.empleador.sfs), srl: rate(p.srl, d.empleador.srl), infotep: rate(p.infotep, d.empleador.infotep) },
  };
}

async function save(tenantId, clientId, body) {
  const settings = sanitize(body || {});
  const { error } = await supabase.from('nomina_settings').upsert({ tenant_id: tenantId, client_id: clientId, settings, updated_at: new Date().toISOString() }, { onConflict: 'tenant_id,client_id' });
  h.dbError(error);
  return settings;
}

module.exports = { DEFAULTS, merge, load, save, sanitize };
