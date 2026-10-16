const supabase = require('../../lib/supabase');
const { authenticate } = require('../../lib/auth');
const { requireTenant } = require('../../lib/tenant');

module.exports = async (req, res) => {
  const session = await authenticate(req);
  if (!session) return res.status(401).json({ error: 'No autorizado' });
  if (session.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
  if (!requireTenant(res, session.tenantId)) return;

  const { id } = req.query;
  try {
    const { data: target, error: targetError } = await supabase.from('direct_profiles').select('id').eq('id', id).eq('tenant_id', session.tenantId).maybeSingle();
    if (targetError) throw targetError;
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado en tu empresa' });
    if (req.method === 'PUT') {
      const { password, role, access_direct, portals_direct, companies_direct, access_cami, access_nala, access_nomina, access_ir2, access_estimacion, userSalt, vaultKeyIv, vaultKeyCt } = req.body || {};

      if (password) {
        const { error } = await supabase.auth.admin.updateUserById(id, { password });
        if (error) { console.error(error); return res.status(400).json({ error: 'No se pudo actualizar la contraseña' }); }
      }

      const update = {};
      if (role !== undefined) update.role = role;
      if (access_direct !== undefined) update.access_direct = access_direct;
      if (portals_direct !== undefined) update.portals_direct = portals_direct;
      // null = every company; an array limits the user to those credential ids.
      if (companies_direct !== undefined) update.companies_direct = Array.isArray(companies_direct) ? companies_direct.map(String).slice(0, 5000) : null;
      if (access_cami !== undefined) update.access_cami = access_cami;
      if (access_nala !== undefined) update.access_nala = access_nala;
      if (access_nomina !== undefined) update.access_nomina = access_nomina;
      if (access_ir2 !== undefined) update.access_ir2 = access_ir2;
      if (access_estimacion !== undefined) update.access_estimacion = access_estimacion;
      if (userSalt && vaultKeyIv && vaultKeyCt) {
        update.user_key_salt = userSalt;
        update.vault_key_iv = vaultKeyIv;
        update.vault_key_ct = vaultKeyCt;
      }

      if (Object.keys(update).length > 0) {
        const { error } = await supabase.from('direct_profiles').update(update).eq('id', id).eq('tenant_id', session.tenantId);
        if (error) { console.error(error); return res.status(500).json({ error: 'Error interno del servidor' }); }
      }

      return res.json({ ok: true });
    }

    if (req.method === 'DELETE') {
      if (session.userId === id) return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });
      const { error } = await supabase.auth.admin.deleteUser(id);
      if (error) { console.error(error); return res.status(400).json({ error: 'No se pudo eliminar el usuario' }); }
      return res.json({ ok: true });
    }

    res.status(405).end();
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Error interno del servidor' });
  }
};
