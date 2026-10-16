// Contexto y autorización de Nómina. Reutiliza el login/usuarios de SERP: la
// sesión sale del perfil autenticado. Entra admin o quien tenga access_nomina.
// Las empresas de Nómina son propias del módulo (nomina_companies): el usuario
// las crea dentro de Nómina, así que el alcance es por tenant (no por el
// companies_direct de Direct, que refería a otros clientes). Todo filtra por
// tenant_id en el servidor; la RLS queda cerrada al navegador.
const { authenticate } = require('../auth');
const { fail } = require('../nala/http');

async function nominaContext(req) {
  const session = await authenticate(req);
  if (!session) fail(401, 'No autorizado');
  const isAdmin = session.role === 'admin';
  if (!isAdmin && !session.access_nomina) fail(403, 'Sin acceso a Nómina');
  if (!session.tenantId) fail(503, 'La migración multiempresa todavía no está aplicada.');
  return {
    session, userId: session.userId, tenantId: session.tenantId, isAdmin,
    canClient: () => true,
    requireClient() {},
    scopeArray: () => null,
  };
}

module.exports = { nominaContext };
