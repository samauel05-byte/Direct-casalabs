// Contexto y autorización de Estados Financieros. Reutiliza el login/usuarios de Direct: entra el
// administrador o quien tenga access_estados. Los permisos salen del rol del módulo (fin_members);
// quien tiene acceso y aún no tiene fila entra como «Solo lectura» (nunca con más permisos por omisión).
const supabase = require('../supabase');
const { authenticate } = require('../auth');
const { fail, dbError } = require('../nala/http');
const rules = require('./rules');

async function estadosContext(req) {
  const session = await authenticate(req);
  if (!session) fail(401, 'No autorizado');
  const isAdmin = session.role === 'admin';
  const access = isAdmin || session.access_estados === true;
  if (!access) fail(403, 'Sin acceso a Estados Financieros');
  if (!session.tenantId) fail(503, 'La migración multiempresa todavía no está aplicada.');
  let role = 'admin'; let perms = new Set(rules.PERMISSIONS); let clientScope = null; let member = null;
  if (!isAdmin) {
    const { data, error } = await supabase.from('fin_members').select('fin_role, all_clients, permissions').eq('tenant_id', session.tenantId).eq('user_id', session.userId).maybeSingle();
    dbError(error);
    member = data;
    role = data?.fin_role || 'lectura';
    perms = rules.permissionsFor(role, data?.permissions);
    if (data && data.all_clients === false) {
      const { data: rows, error: e2 } = await supabase.from('fin_member_clients').select('client_id').eq('tenant_id', session.tenantId).eq('user_id', session.userId);
      dbError(e2);
      clientScope = new Set((rows || []).map(r => r.client_id));
    }
  }
  return {
    session, userId: session.userId, username: session.username, tenantId: session.tenantId, isAdmin, role, roleLabel: rules.ROLE_LABELS[role], perms, member, clientScope,
    can: p => perms.has(p),
    require(p) { if (!perms.has(p)) fail(403, 'No tiene permiso para esta acción en Estados Financieros.'); },
    canClient: id => clientScope === null || clientScope.has(id),
    requireClient(id) { if (clientScope !== null && !clientScope.has(id)) fail(404, 'Empresa o informe no encontrado.'); },
    scopeArray: () => (clientScope === null ? null : [...clientScope]),
  };
}

module.exports = { estadosContext };
