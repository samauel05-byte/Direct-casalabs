// Panel, empresas clientes, Consulta RNC, documentos, equipo, configuración,
// retención documental e historial.
const supabase = require('../../supabase');
const settingsStore = require('../settings');
const storage = require('../storage');
const ids = require('../ids');
const rules = require('../rules');
const rncDgii = require('../rnc-dgii');
const rncRegistry = require('../rnc-registry');
const { ROLE_PERMISSIONS, ROLE_LABELS, PERMISSIONS, permissionsFor } = require('../context');
const { logEvent, getClient } = require('../store');
const h = require('../http');

async function me(ctx) {
  const { data: tenant, error } = await supabase.from('direct_tenants').select('id, name, slug').eq('id', ctx.tenantId).maybeSingle();
  h.dbError(error);
  return {
    user_id: ctx.userId, tenant, role: ctx.role, role_label: ctx.roleLabel, is_admin: ctx.isAdmin,
    permissions: [...ctx.perms], client_scope: ctx.scopeArray(),
    catalogs: { tipoBienesServicios: rules.CURRENT.tipoBienesServicios, formaPago: rules.CURRENT.formaPago, tipoRetencionIsr: rules.CURRENT.tipoRetencionIsr, tipoIngreso: rules.CURRENT.tipoIngreso, tipoId: rules.CURRENT.tipoId },
    rules_version: rules.CURRENT.version,
  };
}

async function stats(ctx, q) {
  ctx.require('view');
  let clients = ctx.scopeArray();
  if (q.client_id) { ctx.requireClient(h.uuid(q.client_id)); clients = [q.client_id]; }
  const { data, error } = await supabase.rpc('nala_stats', {
    p_tenant: ctx.tenantId, p_clients: clients, p_period_from: h.optPeriod(q.period_from), p_period_to: h.optPeriod(q.period_to),
    p_format: h.optFormat(q.format), p_batch: h.optUuid(q.batch_id),
  });
  h.dbError(error);
  return { stats: data, scope: q.client_id ? 'client' : 'consolidated' };
}

// ─── Empresas clientes (direct_clients del tenant) ────────────────────────
const cleanDigits = v => (typeof v === 'string' ? v.replace(/\D/g, '') : '');

function clientPayload(body, partial = false) {
  const out = {};
  if (!partial || body.legal_name !== undefined) out.legal_name = h.text(body.legal_name, { max: 180, min: 2, label: 'La razón social' });
  for (const key of ['rnc', 'cedula']) {
    if (partial && body[key] === undefined) continue;
    const value = cleanDigits(body[key] || '');
    if (value && key === 'rnc' && ![9, 11].includes(value.length)) h.fail(400, 'El RNC debe tener 9 u 11 dígitos.');
    if (value && key === 'cedula' && value.length !== 11) h.fail(400, 'La cédula debe tener 11 dígitos.');
    out[key] = value || null;
  }
  if (!partial || body.email !== undefined) {
    const email = h.text(body.email || '', { max: 254 }).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) h.fail(400, 'El correo no es válido.');
    out.email = email || null;
  }
  if (!partial || body.phone !== undefined) out.phone = h.text(body.phone || '', { max: 48 }) || null;
  if (body.status !== undefined) { if (!['active', 'inactive'].includes(body.status)) h.fail(400, 'Estado inválido.'); out.status = body.status; }
  return out;
}

function clientSettingsPayload(input = {}) {
  const s = {};
  const code = (v, list, label) => { if (v === null || v === '' || v === undefined) return null; const c = String(v).padStart(2, '0'); if (!list[c]) h.fail(400, `${label} inválido.`); return c; };
  s.default_tipo_bienes_servicios = code(input.default_tipo_bienes_servicios, rules.CURRENT.tipoBienesServicios, 'Tipo de bienes y servicios');
  s.default_tipo_ingreso = code(input.default_tipo_ingreso, rules.CURRENT.tipoIngreso, 'Tipo de ingreso');
  s.default_split = ['bienes', 'servicios'].includes(input.default_split) ? input.default_split : null;
  s.regimen = h.text(input.regimen || '', { max: 60 }) || null;
  s.actividad = h.text(input.actividad || '', { max: 120 }) || null;
  s.cierre_fiscal = ['03', '06', '09', '12'].includes(String(input.cierre_fiscal || '')) ? String(input.cierre_fiscal) : null;
  s.formatos = Array.isArray(input.formatos) ? input.formatos.filter(f => ['606', '607'].includes(f)) : ['606', '607'];
  s.notas = h.text(input.notas || '', { max: 1000 }) || null;
  return s;
}

async function listClients(ctx, q) {
  ctx.require('view');
  let query = supabase.from('direct_clients').select('id, legal_name, rnc, cedula, email, phone, status, source, created_at, updated_at').eq('tenant_id', ctx.tenantId).order('legal_name').limit(2000);
  if (ctx.scopeArray()) query = query.in('id', ctx.scopeArray().length ? ctx.scopeArray() : ['00000000-0000-0000-0000-000000000000']);
  if (q.q) {
    const term = String(q.q).replace(/[%,()]/g, ' ').trim().slice(0, 80);
    if (term) query = query.or(`legal_name.ilike.%${term}%,rnc.ilike.%${term.replace(/\D/g, '') || term}%,cedula.ilike.%${term.replace(/\D/g, '') || term}%`);
  }
  if (q.status) query = query.eq('status', q.status === 'inactive' ? 'inactive' : 'active');
  const { data, error } = await query;
  h.dbError(error);
  const idsList = (data || []).map(c => c.id);
  const { data: settings, error: se } = idsList.length ? await supabase.from('nala_client_settings').select('client_id, settings').eq('tenant_id', ctx.tenantId).in('client_id', idsList) : { data: [] };
  h.dbError(se);
  const map = Object.fromEntries((settings || []).map(s => [s.client_id, s.settings]));
  return { clients: (data || []).map(c => ({ ...c, settings: map[c.id] || {} })) };
}

async function createClient(ctx, body) {
  ctx.require('clients_manage');
  const fields = clientPayload(body);
  const key = (fields.rnc || fields.cedula || fields.legal_name.toLocaleLowerCase('es-DO').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')).slice(0, 180);
  const { data, error } = await supabase.from('direct_clients').insert({ ...fields, client_key: key, tenant_id: ctx.tenantId, created_by: ctx.userId, source: 'manual' }).select('id, legal_name, rnc, cedula, email, phone, status, source, created_at, updated_at').single();
  if (error?.code === '23505') h.fail(409, 'Esa empresa ya existe en su empresa operadora.');
  h.dbError(error);
  if (body.settings) await saveClientSettings(ctx, data.id, body.settings);
  await logEvent(ctx, { entity: 'client', entity_id: data.id, client_id: data.id, action: 'client_created', details: fields });
  return { client: data };
}

async function saveClientSettings(ctx, clientId, input) {
  const settings = clientSettingsPayload(input);
  const { error } = await supabase.from('nala_client_settings').upsert({ client_id: clientId, tenant_id: ctx.tenantId, settings, updated_by: ctx.userId, updated_at: new Date().toISOString() }, { onConflict: 'client_id' });
  h.dbError(error);
  return settings;
}

async function updateClient(ctx, id, body) {
  ctx.require('clients_manage');
  const client = await getClient(ctx, h.uuid(id));
  const fields = clientPayload(body, true);
  let updated = client;
  if (Object.keys(fields).length) {
    const { data, error } = await supabase.from('direct_clients').update({ ...fields, updated_at: new Date().toISOString() }).eq('tenant_id', ctx.tenantId).eq('id', client.id).select('id, legal_name, rnc, cedula, email, phone, status, source, created_at, updated_at').single();
    if (error?.code === '23505') h.fail(409, 'Otra empresa ya usa ese identificador.');
    h.dbError(error);
    updated = data;
  }
  const settings = body.settings ? await saveClientSettings(ctx, client.id, body.settings) : client.settings;
  const before = Object.fromEntries(Object.keys(fields).map(k => [k, client[k]]));
  await logEvent(ctx, { entity: 'client', entity_id: client.id, client_id: client.id, action: 'client_updated', details: { before, after: fields, settings: body.settings ? settings : undefined } });
  return { client: { ...updated, settings } };
}

async function clientDetail(ctx, id) {
  ctx.require('view');
  const client = await getClient(ctx, h.uuid(id));
  return { client };
}

// ─── Consulta RNC ─────────────────────────────────────────────────────────
// What the DGII does not publish about third parties: debts, payments and
// tax compliance are confidential (Código Tributario, Ley 11-92, art. 47) and
// only visible to the taxpayer in its Oficina Virtual.
const DEBT_NOTICE = 'La DGII no publica deudas, pagos ni si un contribuyente está al día: es información reservada (Código Tributario, Ley 11-92, art. 47). '
  + 'Sólo el propio contribuyente la ve en su Oficina Virtual (Estado de cuenta) o mediante una Certificación de estar al día emitida a su nombre. '
  + 'Si es su cliente y tiene su acceso a la Oficina Virtual en Direct, consúltela desde allí.';

const splitCached = data => {
  const { _adecuacion = null, ...fields } = data || {};
  return { fields, adecuacion: _adecuacion };
};

async function rnc(ctx, value, q) {
  ctx.require('rnc');
  const structure = ids.analyzeTaxId(value);
  const response = { structure, official: null, registry: null, debts: { available: false, message: DEBT_NOTICE } };
  if (!structure.structureValid) return response;
  const registryPromise = rncRegistry.find(structure.digits)
    .then(r => ({ status: 'ok', ...r, source: 'DGII — archivo oficial de RNC (DGII_RNC.zip)' }))
    .catch(e => ({ status: 'unavailable', message: `No fue posible leer el archivo de RNC de la DGII: ${e.message}` }));
  const maxAgeHours = q.refresh === '1' ? 0 : 24;
  const { data: cached, error } = await supabase.from('nala_rnc_cache').select('*').eq('rnc', structure.digits).maybeSingle();
  h.dbError(error);
  if (cached && Date.now() - Date.parse(cached.fetched_at) < maxAgeHours * 3600e3) {
    const { fields, adecuacion } = splitCached(cached.data);
    response.official = { status: 'ok', cached: true, found: cached.found, data: fields, adecuacion, source: cached.source, source_url: cached.source_url, fetched_at: cached.fetched_at };
  } else {
    try {
      const result = await rncDgii.lookup(structure.digits);
      const data = result.found ? { ...result.data, _adecuacion: result.adecuacion || null } : { message: result.message };
      const { error: ue } = await supabase.from('nala_rnc_cache').upsert({ rnc: structure.digits, found: result.found, data, source: result.source, source_url: result.source_url, fetched_at: result.fetched_at }, { onConflict: 'rnc' });
      h.dbError(ue);
      const { fields, adecuacion } = splitCached(data);
      response.official = { status: 'ok', cached: false, found: result.found, data: fields, adecuacion, source: result.source, source_url: result.source_url, fetched_at: result.fetched_at };
      await logEvent(ctx, { entity: 'rnc', entity_id: structure.digits, action: 'rnc_lookup', details: { found: result.found } });
    } catch (e) {
      // The official source is unreachable: say so; never fabricate a status.
      response.official = { status: 'unavailable', message: `No fue posible consultar la DGII: ${e.message}`, stale: cached ? { found: cached.found, data: splitCached(cached.data).fields, fetched_at: cached.fetched_at } : null };
    }
  }
  response.registry = await registryPromise;
  return response;
}

// ─── Documentos: enlace temporal al original ──────────────────────────────
async function documentUrl(ctx, id) {
  ctx.require('view');
  const { data: doc, error } = await supabase.from('nala_documents').select('id, batch_id, original_name, mime_type, kind, page_count, storage_path, status, sha256').eq('tenant_id', ctx.tenantId).eq('id', h.uuid(id)).maybeSingle();
  h.dbError(error);
  if (!doc) h.fail(404, 'Documento no encontrado.');
  const { data: batch } = await supabase.from('nala_batches').select('client_id').eq('id', doc.batch_id).single();
  // Access follows the invoices read from the document (they may have been
  // relocated) or, if none, the batch's company.
  const { data: invs } = await supabase.from('nala_invoices').select('client_id').eq('document_id', doc.id).limit(50);
  const allowed = [batch?.client_id, ...(invs || []).map(i => i.client_id)].some(c => c && ctx.canClient(c));
  if (!allowed) h.fail(404, 'Documento no encontrado.');
  if (doc.status === 'purged') h.fail(410, 'El original fue depurado por la política de retención; se conserva su huella SHA-256.', { sha256: doc.sha256 });
  if (doc.status === 'pending_upload') h.fail(409, 'El archivo todavía no se ha subido. Reintenta la carga desde el lote.');
  const url = await storage.signedDownload(doc.storage_path, 300);
  return { url, expires_in: 300, document: { id: doc.id, name: doc.original_name, mime_type: doc.mime_type, kind: doc.kind, page_count: doc.page_count, sha256: doc.sha256 } };
}

// ─── Equipo y oficiales ───────────────────────────────────────────────────
async function team(ctx) {
  ctx.require('view');
  const { data: profiles, error } = await supabase.from('direct_profiles').select('id, role, access_nala, created_at').eq('tenant_id', ctx.tenantId).order('created_at');
  h.dbError(error);
  const { data: members, error: me2 } = await supabase.from('nala_members').select('*').eq('tenant_id', ctx.tenantId);
  h.dbError(me2);
  const { data: assigned, error: ae } = await supabase.from('nala_member_clients').select('user_id, client_id').eq('tenant_id', ctx.tenantId);
  h.dbError(ae);
  let names = {};
  try {
    const { data: { users } } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    names = Object.fromEntries((users || []).map(u => [u.id, String(u.email || '').replace('@direct.local', '')]));
  } catch { /* nombres opcionales */ }
  const byUser = Object.fromEntries((members || []).map(m => [m.user_id, m]));
  const list = (profiles || []).filter(p => p.role === 'admin' || p.access_nala).map(p => {
    const m = byUser[p.id];
    const role = p.role === 'admin' ? 'admin' : (m?.nala_role || 'oficial');
    return {
      user_id: p.id, username: names[p.id] || p.id.slice(0, 8), app_role: p.role, nala_role: role, role_label: ROLE_LABELS[role],
      all_clients: p.role === 'admin' ? true : (m ? m.all_clients : true),
      client_ids: (assigned || []).filter(a => a.user_id === p.id).map(a => a.client_id),
      permissions: p.role === 'admin' ? PERMISSIONS : [...permissionsFor(role, m?.permissions)],
      overrides: m?.permissions || {}, updated_at: m?.updated_at || null,
    };
  });
  return { members: list, roles: Object.entries(ROLE_PERMISSIONS).map(([key, perms]) => ({ key, label: ROLE_LABELS[key], permissions: perms })), all_permissions: PERMISSIONS };
}

async function updateMember(ctx, userId, body) {
  ctx.require('team_manage');
  const id = h.uuid(userId, 'Usuario');
  const { data: profile, error } = await supabase.from('direct_profiles').select('id, role, access_nala').eq('tenant_id', ctx.tenantId).eq('id', id).maybeSingle();
  h.dbError(error);
  if (!profile) h.fail(404, 'Usuario no encontrado en su empresa.');
  if (profile.role === 'admin') h.fail(400, 'Los administradores tienen acceso completo; no requieren rol NALA.');
  if (!profile.access_nala) h.fail(400, 'Primero habilite el módulo NALA para este usuario en Usuarios.');
  const role = String(body.nala_role || 'oficial');
  if (!ROLE_PERMISSIONS[role]) h.fail(400, 'Rol inválido.');
  const allClients = body.all_clients !== false;
  const overrides = {};
  for (const [k, v] of Object.entries(body.permissions || {})) if (PERMISSIONS.includes(k) && typeof v === 'boolean' && !['team_manage', 'settings_manage', 'retention_purge'].includes(k)) overrides[k] = v;
  const clientIds = Array.isArray(body.client_ids) ? [...new Set(body.client_ids.map(c => h.uuid(c, 'Empresa')))] : [];
  if (clientIds.length) {
    const { data: valid, error: ve } = await supabase.from('direct_clients').select('id').eq('tenant_id', ctx.tenantId).in('id', clientIds);
    h.dbError(ve);
    if ((valid || []).length !== clientIds.length) h.fail(400, 'Alguna empresa asignada no pertenece a su empresa operadora.');
  }
  const { error: ue } = await supabase.from('nala_members').upsert({ tenant_id: ctx.tenantId, user_id: id, nala_role: role, all_clients: allClients, permissions: overrides, updated_by: ctx.userId, updated_at: new Date().toISOString() }, { onConflict: 'tenant_id,user_id' });
  h.dbError(ue);
  const { error: de } = await supabase.from('nala_member_clients').delete().eq('tenant_id', ctx.tenantId).eq('user_id', id);
  h.dbError(de);
  if (!allClients && clientIds.length) {
    const { error: ie } = await supabase.from('nala_member_clients').insert(clientIds.map(c => ({ tenant_id: ctx.tenantId, user_id: id, client_id: c })));
    h.dbError(ie);
  }
  await logEvent(ctx, { entity: 'member', entity_id: id, action: 'member_updated', details: { nala_role: role, all_clients: allClients, client_ids: allClients ? [] : clientIds, overrides } });
  return { ok: true };
}

// ─── Configuración ────────────────────────────────────────────────────────
async function getSettings(ctx) {
  ctx.require('view');
  const settings = await settingsStore.load(ctx.tenantId);
  let storageStatus = 'desconocido';
  try { await storage.ensureBucket(); storageStatus = 'ok'; } catch (e) { storageStatus = `error: ${e.message}`; }
  return {
    settings,
    integrations: {
      openai: { configured: !!process.env.OPENAI_API_KEY, model: process.env.NALA_OPENAI_MODEL || 'gpt-4.1' },
      dgii_rnc: { source: rncDgii.DGII_URL },
      storage: { bucket: storage.BUCKET, status: storageStatus },
      worker: { scheduled_secret_configured: !!process.env.NALA_WORKER_SECRET, cron_secret_configured: !!process.env.CRON_SECRET },
    },
    rules: { version: rules.CURRENT.version, itbis_rates: rules.CURRENT.itbisRates, consumer_threshold: rules.CURRENT.consumerSummaryThreshold, max_records: rules.CURRENT.maxRecords },
  };
}

async function putSettings(ctx, body) {
  ctx.require('settings_manage');
  const before = await settingsStore.load(ctx.tenantId);
  const saved = await settingsStore.save(ctx.tenantId, ctx.userId, body.settings || {});
  await logEvent(ctx, { entity: 'settings', entity_id: ctx.tenantId, action: 'settings_updated', details: { before, after: saved } });
  return { settings: saved };
}

// ─── Retención documental ─────────────────────────────────────────────────
async function retentionCandidates(ctx) {
  const settings = await settingsStore.load(ctx.tenantId);
  const cutoff = new Date(); cutoff.setUTCFullYear(cutoff.getUTCFullYear() - settings.retention.years);
  const { data, error } = await supabase.from('nala_documents').select('id, batch_id, original_name, size_bytes, sha256, created_at, status')
    .eq('tenant_id', ctx.tenantId).lt('created_at', cutoff.toISOString()).neq('status', 'purged').limit(1000);
  h.dbError(error);
  return { cutoff: cutoff.toISOString(), years: settings.retention.years, documents: data || [] };
}

async function retention(ctx) {
  ctx.require('view');
  return retentionCandidates(ctx);
}

async function purge(ctx, body) {
  ctx.require('retention_purge');
  if (body.confirm !== 'DEPURAR') h.fail(400, 'Confirme escribiendo DEPURAR.');
  const { documents, cutoff } = await retentionCandidates(ctx);
  const paths = documents.map(d => d.id);
  const { data: docs } = paths.length ? await supabase.from('nala_documents').select('id, storage_path').in('id', paths) : { data: [] };
  await storage.remove((docs || []).map(d => d.storage_path));
  if (paths.length) {
    const { error } = await supabase.from('nala_documents').update({ status: 'purged', purged_at: new Date().toISOString() }).in('id', paths).eq('tenant_id', ctx.tenantId);
    h.dbError(error);
  }
  await logEvent(ctx, { entity: 'settings', entity_id: ctx.tenantId, action: 'retention_purged', details: { cutoff, documents: documents.map(d => ({ id: d.id, sha256: d.sha256, name: d.original_name })) } });
  return { purged: paths.length };
}

// ─── Historial ────────────────────────────────────────────────────────────
async function events(ctx, q) {
  ctx.require('view');
  let query = supabase.from('nala_events').select('*').eq('tenant_id', ctx.tenantId).order('id', { ascending: false }).limit(Math.min(Number(q.limit) || 200, 500));
  if (q.invoice_id) { query = query.eq('invoice_id', h.uuid(q.invoice_id)); }
  if (q.batch_id) { query = query.eq('batch_id', h.uuid(q.batch_id)); }
  if (q.client_id) { ctx.requireClient(h.uuid(q.client_id)); query = query.eq('client_id', q.client_id); }
  if (q.entity) query = query.eq('entity', String(q.entity));
  const { data, error } = await query;
  h.dbError(error);
  const visible = (data || []).filter(e => !e.client_id || ctx.canClient(e.client_id));
  return { events: visible };
}

module.exports = { me, stats, listClients, createClient, updateClient, clientDetail, rnc, documentUrl, team, updateMember, getSettings, putSettings, retention, purge, events };
