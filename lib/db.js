const supabase = require('./supabase');

const db = {
  async getCredentials(tenantId, portals = null, ids = null) {
    let query = supabase.from('direct_credentials').select('*').order('updated_at', { ascending: false });
    if (tenantId) query = query.eq('tenant_id', tenantId);
    if (Array.isArray(portals)) query = query.in('institution', portals);
    if (Array.isArray(ids)) query = query.in('id', ids.length ? ids : ['__ninguna__']);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },
  async getCredential(tenantId, id) {
    let query = supabase.from('direct_credentials').select('id, institution, category').eq('id', id);
    if (tenantId) query = query.eq('tenant_id', tenantId);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    return data || null;
  },
  async upsertCredential(tenantId, id, institution, category, iv, ct, updated_at) {
    const row = { id, institution, category, iv, ct, updated_at };
    if (tenantId) row.tenant_id = tenantId;
    const { error } = await supabase.from('direct_credentials').upsert(row, tenantId ? { onConflict: 'tenant_id,id' } : undefined);
    if (error) throw error;
  },
  async upsertCredentials(tenantId, batch) {
    const now = Date.now();
    const rows = batch.map(c => ({ ...(tenantId ? { tenant_id: tenantId } : {}), id: c.id, institution: c.institution, category: c.category || 'acceso', iv: c.iv, ct: c.ct, updated_at: now }));
    // Supabase upsert in chunks of 200 to avoid payload limits
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await supabase.from('direct_credentials').upsert(rows.slice(i, i + 200), tenantId ? { onConflict: 'tenant_id,id' } : undefined);
      if (error) throw error;
    }
    return rows.length;
  },
  async deleteCredential(tenantId, id) {
    let query = supabase.from('direct_credentials').delete().eq('id', id);
    if (tenantId) query = query.eq('tenant_id', tenantId);
    const { error } = await query;
    if (error) throw error;
  },
  async getCredentialsSince(tenantId, since, portals = null, ids = null) {
    let query = supabase.from('direct_credentials').select('*').gt('updated_at', since).order('updated_at');
    if (tenantId) query = query.eq('tenant_id', tenantId);
    if (Array.isArray(portals)) query = query.in('institution', portals);
    if (Array.isArray(ids)) query = query.in('id', ids.length ? ids : ['__ninguna__']);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },
  async getConfig(tenantId) {
    let query = supabase.from('direct_config').select('key, value');
    if (tenantId) query = query.eq('tenant_id', tenantId);
    const { data, error } = await query;
    if (error) throw error;
    const config = {};
    for (const r of (data || [])) config[r.key] = r.value;
    return config;
  },
  async setConfig(tenantId, key, value) {
    const row = { key, value };
    if (tenantId) row.tenant_id = tenantId;
    const { error } = await supabase.from('direct_config').upsert(row, tenantId ? { onConflict: 'tenant_id,key' } : undefined);
    if (error) throw error;
  },
};

module.exports = db;
