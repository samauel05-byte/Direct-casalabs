const supabase = require('../../lib/supabase');
const { authenticate } = require('../../lib/auth');
const { requireTenant } = require('../../lib/tenant');

module.exports = async (req, res) => {
  const session = await authenticate(req);
  if (!session) return res.status(401).json({ error: 'No autorizado' });
  if (session.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });

  try {
    // Preserve the legacy user list while a pre-existing installation has not
    // yet run the tenant migration. It is read-only; mutations remain blocked.
    if (req.method === 'GET' && !session.tenantId) {
      const { data: profiles, error } = await supabase
        .from('direct_profiles')
        .select('id, role, access_direct, access_cami, access_nala, portals_direct, created_at')
        .order('created_at');
      if (error) throw error;
      const { data: { users: authUsers } } = await supabase.auth.admin.listUsers({ perPage: 1000 });
      const emailMap = Object.fromEntries((authUsers || []).map(user => [user.id, (user.email || '').replace('@direct.local', '')]));
      return res.json({ ok: true, users: (profiles || []).map(profile => ({
        ...profile,
        username: emailMap[profile.id] || '',
        access_ir2: profile.access_cami === true,
        access_estimacion: profile.access_cami === true,
        access_clientes: true,
      })) });
    }
    if (!requireTenant(res, session.tenantId)) return;
    if (req.method === 'GET') {
      const { data: profiles } = await supabase
        .from('direct_profiles')
        .select('id, role, access_direct, access_cami, access_nala, access_nomina, access_ir2, access_estimacion, access_clientes, portals_direct, companies_direct, created_at')
        .eq('tenant_id', session.tenantId)
        .order('created_at');

      const { data: { users: authUsers } } = await supabase.auth.admin.listUsers({ perPage: 1000 });
      const emailMap = {};
      for (const u of authUsers || []) emailMap[u.id] = (u.email || '').replace('@direct.local', '');

      const users = (profiles || []).map(p => ({
        id: p.id,
        username: emailMap[p.id] || '',
        role: p.role,
        access_direct: p.access_direct !== false,
        access_cami: p.access_cami,
        access_nala: p.access_nala,
        access_nomina: p.access_nomina === true,
        access_ir2: p.access_ir2,
        access_estimacion: p.access_estimacion,
        access_clientes: p.access_clientes !== false,
        portals_direct: p.portals_direct,
        companies_direct: Array.isArray(p.companies_direct) ? p.companies_direct : null,
        created_at: p.created_at,
      }));

      return res.json({ ok: true, users });
    }

    if (req.method === 'POST') {
      const { username, password, role, access_direct, portals_direct, companies_direct, access_cami, access_nala, access_nomina, access_ir2, access_estimacion, userSalt, vaultKeyIv, vaultKeyCt } = req.body || {};
      if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
      const email = username.toLowerCase().trim() + '@direct.local';

      // Tope de usuarios de la licencia (null = sin tope).
      const { data: ten } = await supabase.from('direct_tenants').select('max_users').eq('id', session.tenantId).maybeSingle();
      if (ten?.max_users) {
        const { count } = await supabase.from('direct_profiles').select('*', { count: 'exact', head: true }).eq('tenant_id', session.tenantId);
        if ((count || 0) >= ten.max_users) return res.status(403).json({ error: `Tu licencia permite hasta ${ten.max_users} usuarios. Pide ampliarla a soporte.` });
      }

      const { data: { user }, error } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (error) { console.error(error); return res.status(400).json({ error: 'No se pudo crear el usuario' }); }

      const { error: profileError } = await supabase.from('direct_profiles').insert({
        id: user.id,
        tenant_id: session.tenantId,
        role: role || 'user',
        access_direct: access_direct !== false,
        access_cami: access_cami || false,
        access_nala: access_nala || false,
        access_nomina: access_nomina || false,
        access_ir2: access_ir2 || false,
        access_estimacion: access_estimacion || false,
        // Client records are isolated by the tenant, not by a module checkbox.
        access_clientes: true,
        portals_direct: portals_direct || ['dgii', 'tss', 'trabajo', 'sirla', 'carnet', 'azul'],
        companies_direct: Array.isArray(companies_direct) ? companies_direct.map(String).slice(0, 5000) : null,
        user_key_salt: userSalt || null,
        vault_key_iv: vaultKeyIv || null,
        vault_key_ct: vaultKeyCt || null,
      });
      if (profileError) {
        await supabase.auth.admin.deleteUser(user.id);
        console.error(profileError); return res.status(500).json({ error: 'Error interno del servidor' });
      }

      return res.json({ ok: true, id: user.id });
    }

    res.status(405).end();
  } catch (e) {
    if (e.message?.includes('already registered') || e.message?.includes('duplicate')) {
      return res.status(409).json({ error: 'Usuario ya registrado' });
    }
    console.error(e); res.status(500).json({ error: 'Error interno del servidor' });
  }
};
