// Tenant-level NALA configuration with safe defaults and bounded values.
const supabase = require('../supabase');
const { dbError, fail } = require('./http');
const money = require('./money');

const DEFAULTS = {
  limits: { max_file_mb: 50, max_files_per_batch: 300, max_pages_per_document: 200, pages_per_chunk: 3, max_attempts: 3, zip_max_uncompressed_mb: 300, concurrent_jobs: 3 },
  rules: { total_tolerance: '1.00' },
  retention: { years: 10 },
  excel_templates: [],
  // DGII templates uploaded by the user (lib/nala/api/templates.js):
  // { '606': { excel: {...}, examples: [...], txt_style: {...} } }
  dgii_templates: {},
};

const BOUNDS = {
  max_file_mb: [1, 50], max_files_per_batch: [1, 2000], max_pages_per_document: [1, 1000], pages_per_chunk: [1, 10],
  max_attempts: [1, 10], zip_max_uncompressed_mb: [10, 1000], concurrent_jobs: [1, 5],
};

function merge(stored = {}) {
  return {
    limits: { ...DEFAULTS.limits, ...(stored.limits || {}) },
    rules: { ...DEFAULTS.rules, ...(stored.rules || {}) },
    retention: { ...DEFAULTS.retention, ...(stored.retention || {}) },
    excel_templates: Array.isArray(stored.excel_templates) ? stored.excel_templates : [],
    dgii_templates: stored.dgii_templates && typeof stored.dgii_templates === 'object' ? stored.dgii_templates : {},
  };
}

async function load(tenantId) {
  const { data, error } = await supabase.from('nala_settings').select('settings, updated_at').eq('tenant_id', tenantId).maybeSingle();
  dbError(error);
  return merge(data?.settings || {});
}

function sanitize(input) {
  const out = merge({});
  const limits = input?.limits || {};
  for (const [key, [min, max]] of Object.entries(BOUNDS)) {
    if (limits[key] === undefined) continue;
    const n = Number(limits[key]);
    if (!Number.isInteger(n) || n < min || n > max) fail(400, `El límite ${key} debe ser un entero entre ${min} y ${max}.`);
    out.limits[key] = n;
  }
  if (input?.rules?.total_tolerance !== undefined) {
    const tol = String(input.rules.total_tolerance);
    if (!money.isValid(tol) || money.cmp(tol, '0') < 0 || money.cmp(tol, '100') > 0) fail(400, 'La tolerancia de totales debe estar entre 0.00 y 100.00.');
    out.rules.total_tolerance = money.normalize(tol);
  }
  if (input?.retention?.years !== undefined) {
    const years = Number(input.retention.years);
    if (!Number.isInteger(years) || years < 10 || years > 30) fail(400, 'La retención documental debe ser de 10 a 30 años (Código Tributario, art. 50).');
    out.retention.years = years;
  }
  if (Array.isArray(input?.excel_templates)) {
    out.excel_templates = input.excel_templates.slice(0, 20).map(t => ({
      name: String(t?.name || '').trim().slice(0, 60),
      format: ['606', '607'].includes(t?.format) ? t.format : '606',
      columns: Array.isArray(t?.columns) ? t.columns.map(String).slice(0, 60) : [],
    })).filter(t => t.name && t.columns.length);
  }
  return out;
}

async function write(tenantId, userId, settings) {
  const { error } = await supabase.from('nala_settings').upsert({ tenant_id: tenantId, settings, updated_by: userId, updated_at: new Date().toISOString() }, { onConflict: 'tenant_id' });
  dbError(error);
  return settings;
}

// The general form never sends dgii_templates: keep the stored ones.
async function save(tenantId, userId, input) {
  const settings = sanitize(input);
  settings.dgii_templates = (await load(tenantId)).dgii_templates;
  const { error } = await supabase.from('nala_settings').upsert({ tenant_id: tenantId, settings, updated_by: userId, updated_at: new Date().toISOString() }, { onConflict: 'tenant_id' });
  dbError(error);
  return settings;
}

async function saveTemplates(tenantId, userId, dgiiTemplates) {
  const current = await load(tenantId);
  return write(tenantId, userId, { ...current, dgii_templates: dgiiTemplates });
}

module.exports = { DEFAULTS, load, save, saveTemplates, merge, sanitize };
