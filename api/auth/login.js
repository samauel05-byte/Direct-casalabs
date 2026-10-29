const supabase = require('../../lib/supabase');
const db = require('../../lib/db');
const { authenticate, loadProfile } = require('../../lib/auth');
const { allow } = require('../../lib/rate-limit');
const { randomUUID } = require('crypto');
const L = require('../../lib/licenses');

const VAULT_COLUMNS = ', user_key_salt, vault_key_iv, vault_key_ct';

function profileResponse(profile, defaultPortals, extra = {}) {
  return {
    ...extra,
    ok: true,
    role: profile.role,
    access_direct: profile.access_direct !== false,
    access_cami: profile.access_cami || false,
    access_nala: profile.access_nala || false,
    access_nomina: profile.access_nomina === true,
    access_ir2: profile.access_ir2 === true,
    access_estimacion: profile.access_estimacion === true,
    access_clientes: profile.access_clientes !== false,
    portals: profile.portals_direct || defaultPortals,
    userSalt: profile.user_key_salt,
    vaultKeyIv: profile.vault_key_iv,
    vaultKeyCt: profile.vault_key_ct,
  };
}

module.exports = async (req, res) => {
  // POST: sign in server-side, return JWT + vault data in one call
  if (req.method === 'POST') {
    if (!await allow(req, 'login', 10, 15 * 60 * 1000)) return res.status(429).json({ error: 'Demasiados intentos. Intenta nuevamente en unos minutos.' });
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !/^[a-zA-Z0-9._-]{3,64}$/.test(username.trim())) {
      return res.status(400).json({ error: 'Credenciales inválidas' });
    }

    const email = username.toLowerCase().trim() + '@direct.local';
    try {
      const authRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_ANON_KEY },
        body: JSON.stringify({ email, password }),
      });

      if (!authRes.ok) {
        const errBody = await authRes.json().catch(() => ({}));
        const detail = errBody.error_description || errBody.msg || '';
        return res.status(401).json({ error: /invalid login credentials/i.test(detail) || !detail ? 'Usuario o contraseña incorrectos' : detail });
      }

      // The password grant already returns the signed-in user, so no second
      // round trip to the auth server is needed.
      const grant = await authRes.json();
      const access_token = grant.access_token;
      const refresh_token = grant.refresh_token || null;
      const expires_at = grant.expires_at || null;
      let user = grant.user;
      if (!user?.id) {
        const { data, error: userErr } = await supabase.auth.getUser(access_token);
        if (userErr || !data?.user) return res.status(401).json({ error: 'Token inválido' });
        user = data.user;
      }

      // Profile, the single active browser session and the vault config are
      // independent, so they run together. The config travels with the login
      // response, sparing the browser a separate /api/config request.
      const nextSessionId = randomUUID();
      const now = new Date().toISOString();
      const [{ profile }, { error: sessionError }] = await Promise.all([
        loadProfile(user.id, VAULT_COLUMNS),
        supabase.from('direct_active_sessions').upsert({ user_id: user.id, session_id: nextSessionId, issued_at: now, updated_at: now }, { onConflict: 'user_id' }),
      ]);
      if (!profile) return res.status(404).json({ error: 'Perfil no encontrado' });
      const license = await L.tenantState(profile.tenant_id);
      if (license.blocked) return res.status(403).json({ error: license.message });
      const platformAdmin = await L.isPlatformAdmin(user.id);
      // La config (incluido el verificador de bóveda) viaja con el login, pero
      // debe ser la de la firma del usuario, así que se lee ya con su tenant.
      const config = await db.getConfig(profile.tenant_id || null).catch(() => null);

      return res.json({
        ...profileResponse(profile, [], { platformAdmin, license: { code: license.code, daysLeft: license.daysLeft, graceDaysLeft: license.graceDaysLeft } }),
        access_token,
        refresh_token,
        expires_at,
        session_id: sessionError ? null : nextSessionId,
        config,
      });
    } catch (e) {
      console.error(e); return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }

  // GET: return vault data for already-authenticated session (token restore)
  if (req.method === 'GET') {
    const session = await authenticate(req);
    if (!session) return res.status(401).json({ error: 'No autorizado' });
    try {
      const { profile } = await loadProfile(session.userId, VAULT_COLUMNS);
      if (!profile) return res.status(404).json({ error: 'Perfil no encontrado' });
      const license = await L.tenantState(profile.tenant_id);
      return res.json(profileResponse(profile, ['dgii', 'tss', 'trabajo', 'sirla', 'carnet', 'azul'], { platformAdmin: await L.isPlatformAdmin(session.userId), license: { code: license.code, daysLeft: license.daysLeft, graceDaysLeft: license.graceDaysLeft } }));
    } catch (e) {
      console.error(e); return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }

  // PATCH: migra la envoltura del secreto de bóveda a la llave v2 (600.000 iteraciones).
  // Sólo del propio usuario y sólo si la sal anterior sigue siendo la guardada, para
  // no pisar un cambio de contraseña hecho en otra sesión.
  if (req.method === 'PATCH') {
    const session = await authenticate(req);
    if (!session) return res.status(401).json({ error: 'No autorizado' });
    if (!await allow(req, 'kdf-upgrade', 5, 15 * 60 * 1000)) return res.status(429).json({ error: 'Demasiados intentos.' });
    const { prevSalt, userSalt, vaultKeyIv, vaultKeyCt } = req.body || {};
    const b64 = /^[A-Za-z0-9+/]+={0,2}$/;
    if (typeof prevSalt !== 'string' || typeof userSalt !== 'string' || !/^v2\$[A-Za-z0-9+/]{22}={2}$/.test(userSalt)
      || typeof vaultKeyIv !== 'string' || typeof vaultKeyCt !== 'string' || !b64.test(vaultKeyIv) || !b64.test(vaultKeyCt)
      || vaultKeyIv.length > 32 || vaultKeyCt.length > 256) {
      return res.status(400).json({ error: 'Datos inválidos' });
    }
    try {
      const { data, error } = await supabase.from('direct_profiles')
        .update({ user_key_salt: userSalt, vault_key_iv: vaultKeyIv, vault_key_ct: vaultKeyCt })
        .eq('id', session.userId).eq('user_key_salt', prevSalt).select('id');
      if (error) throw error;
      return res.json({ ok: true, updated: (data || []).length });
    } catch (e) {
      console.error(e); return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }

  res.status(405).end();
};
