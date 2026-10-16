const supabase = require('./supabase');

const PROFILE_COLUMNS = 'role, access_direct, access_cami, access_nala, access_nomina, portals_direct, access_ir2, access_estimacion, access_clientes, tenant_id, companies_direct';
const BASE_COLUMNS = 'role, access_direct, access_cami, access_nala, portals_direct';

// Reads the whole profile in one round trip. Older databases without the
// module or tenant columns fall back to the base columns, with the same
// defaults the application has always applied.
async function loadProfile(userId, extra = '') {
  const full = await supabase.from('direct_profiles').select(PROFILE_COLUMNS + extra).eq('id', userId).maybeSingle();
  if (!full.error) return { profile: full.data, legacy: false };
  const base = await supabase.from('direct_profiles').select(BASE_COLUMNS + extra).eq('id', userId).maybeSingle();
  if (!base.data) return { profile: null, legacy: true };
  return {
    legacy: true,
    profile: { ...base.data, access_ir2: base.data.access_cami === true, access_estimacion: base.data.access_cami === true, access_clientes: true, tenant_id: null },
  };
}

async function authenticate(req) {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return null;
  const jwt = auth.slice(7);
  const { data: { user }, error } = await supabase.auth.getUser(jwt);
  if (error || !user) return null;
  const [{ profile }, { data: activeSession, error: sessionError }] = await Promise.all([
    loadProfile(user.id),
    supabase.from('direct_active_sessions').select('session_id').eq('user_id', user.id).maybeSingle(),
  ]);
  // A valid Supabase account without an application profile must not gain
  // access to the application APIs.
  if (!profile) return null;
  // Before the migration this table does not exist. Preserve access to the
  // established application, but once it is available a missing or mismatched
  // browser session immediately invalidates the older browser.
  if (!sessionError && activeSession && activeSession.session_id !== req.headers['x-direct-session']) return null;
  return {
    userId: user.id,
    username: (user.email || '').replace('@direct.local', ''),
    role: profile.role || 'user',
    access_direct: profile.access_direct !== false,
    access_cami: profile.access_cami === true,
    access_nala: profile.access_nala === true,
    access_nomina: profile.access_nomina === true,
    access_ir2: profile.access_ir2 === true,
    access_estimacion: profile.access_estimacion === true,
    access_clientes: profile.access_clientes !== false,
    portals_direct: Array.isArray(profile.portals_direct) ? profile.portals_direct : [],
    // Credential ids this user may see; null = every company of the tenant.
    companies_direct: Array.isArray(profile.companies_direct) ? profile.companies_direct : null,
    // A missing column means an older database. Tenant-only routes fail
    // closed until the migration has been applied.
    tenantId: profile.tenant_id || null,
  };
}

module.exports = { authenticate, loadProfile };
