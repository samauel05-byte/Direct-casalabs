// Contexto y autorización de Nómina. Reutiliza el login/usuarios de SERP: la
// sesión sale del perfil autenticado. Entra admin o quien tenga access_nomina.
// El alcance por empresa reutiliza companies_direct del perfil (null = todas),
// igual que el resto de Direct, para que un usuario limitado no vea ni toque la
// nómina de empresas que no le corresponden.
const { authenticate } = require('../auth');
const { fail } = require('../nala/http');

async function nominaContext(req) {
  const session = await authenticate(req);
  if (!session) fail(401, 'No autorizado');
  const isAdmin = session.role === 'admin';
  if (!isAdmin && !session.access_nomina) fail(403, 'Sin acceso a Nómina');
  if (!session.tenantId) fail(503, 'La migración multiempresa todavía no está aplicada.');
  const scope = Array.isArray(session.companies_direct) ? new Set(session.companies_direct) : null; // null = todas
  return {
    session, userId: session.userId, tenantId: session.tenantId, isAdmin,
    canClient: id => scope === null || scope.has(id),
    requireClient(id) { if (scope !== null && !scope.has(id)) fail(404, 'Empresa no encontrada o no asignada.'); },
    scopeArray: () => (scope === null ? null : [...scope]),
  };
}

module.exports = { nominaContext };
