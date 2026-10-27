const supabase = require('./supabase');

async function getTenant(session) {
  if (!session?.userId) return null;
  const { data, error } = await supabase
    .from('direct_profiles')
    .select('tenant_id')
    .eq('id', session.userId)
    .maybeSingle();
  if (error) {
    // Keep older deployments usable until the migration is applied, while the
    // tenant-only routes remain unavailable instead of falling back to global data.
    if (/tenant_id|column/i.test(error.message || '')) return null;
    throw error;
  }
  return data?.tenant_id || null;
}

async function ensureDefaultTenant() {
  // Si ya existe se respeta su nombre actual (SAVE CONSULTORES SRL); solo se crea si falta.
  const { data: cur, error: e1 } = await supabase.from('direct_tenants').select('id').eq('slug', 'save').maybeSingle();
  if (e1) throw e1;
  if (cur) return cur.id;
  const { data, error } = await supabase.from('direct_tenants')
    .upsert({ name: 'SAVE CONSULTORES SRL', slug: 'save' }, { onConflict: 'slug' })
    .select('id').single();
  if (error) throw error;
  return data.id;
}

function requireTenant(res, tenantId) {
  if (tenantId) return true;
  res.status(503).json({ error: 'La migración multiempresa todavía no está aplicada.' });
  return false;
}

module.exports = { getTenant, requireTenant, ensureDefaultTenant };
