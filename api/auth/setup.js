const supabase = require('../../lib/supabase');
const { ensureDefaultTenant } = require('../../lib/tenant');
const { allow } = require('../../lib/rate-limit');

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const { count } = await supabase
        .from('direct_profiles')
        .select('*', { count: 'exact', head: true });
      return res.json({ hasUsers: (count || 0) > 0 });
    }

    if (req.method === 'POST') {
      if (!await allow(req, 'setup', 5, 15 * 60 * 1000)) return res.status(429).json({ error: 'Demasiados intentos. Intenta nuevamente en unos minutos.' });
      const { count } = await supabase
        .from('direct_profiles')
        .select('*', { count: 'exact', head: true });
      if ((count || 0) > 0) return res.status(409).json({ error: 'Ya existe un administrador' });

      const { username, password, vaultKeyIv, vaultKeyCt, userSalt } = req.body || {};
      if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
      const email = username.toLowerCase().trim() + '@direct.local';
      const tenantId = await ensureDefaultTenant();

      const { data: { user }, error } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (error) { console.error(error); return res.status(400).json({ error: 'No se pudo crear el administrador' }); }

      const { error: profileError } = await supabase.from('direct_profiles').insert({
        id: user.id,
        tenant_id: tenantId,
        role: 'admin',
        access_direct: true,
        access_cami: true,
        access_nala: true,
        access_nomina: true,
        access_ir2: true,
        access_estimacion: true,
        access_clientes: true,
        portals_direct: ['dgii', 'tss', 'trabajo', 'sirla', 'carnet', 'azul'],
        user_key_salt: userSalt || null,
        vault_key_iv: vaultKeyIv || null,
        vault_key_ct: vaultKeyCt || null,
      });
      if (profileError) {
        await supabase.auth.admin.deleteUser(user.id);
        console.error(profileError); return res.status(500).json({ error: 'Error interno del servidor' });
      }

      return res.json({ ok: true });
    }

    res.status(405).end();
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Error interno del servidor' });
  }
};
