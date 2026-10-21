// Request context for NALA: authenticated user, tenant (always from the
// profile, never from the request), NALA role, permissions and the set of
// client companies the user may see. Every route checks these server-side,
// including direct links to an invoice, document or export.
const supabase = require('../supabase');
const { authenticate } = require('../auth');
const { fail, dbError } = require('./http');

const PERMISSIONS = ['view', 'upload', 'edit', 'approve', 'revert', 'relocate', 'exclude', 'reprocess', 'export', 'submit', 'clients_manage', 'rnc', 'team_manage', 'settings_manage', 'retention_purge'];

const ROLE_PERMISSIONS = {
  supervisor: ['view', 'upload', 'edit', 'approve', 'revert', 'relocate', 'exclude', 'reprocess', 'export', 'submit', 'clients_manage', 'rnc'],
  oficial: ['view', 'upload', 'edit', 'approve', 'revert', 'exclude', 'reprocess', 'export', 'rnc'],
  auditor: ['view', 'edit', 'approve', 'revert', 'rnc'],
  lectura: ['view', 'rnc'],
};

const ROLE_LABELS = { admin: 'Administrador', supervisor: 'Supervisor', oficial: 'Oficial', auditor: 'Auditor', lectura: 'Sólo lectura' };

function permissionsFor(role, overrides = {}) {
  const set = new Set(ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.lectura);
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!PERMISSIONS.includes(key) || ['team_manage', 'settings_manage', 'retention_purge'].includes(key)) continue;
    if (value === true) set.add(key); else if (value === false) set.delete(key);
  }
  return set;
}

async function nalaContext(req) {
  const session = await authenticate(req);
  if (!session) fail(401, 'No autorizado');
  const isAdmin = session.role === 'admin';
  if (!isAdmin && !session.access_nala) fail(403, 'Sin acceso a NALA');
  if (!session.tenantId) fail(503, 'La migración multiempresa todavía no está aplicada.');
  let role = 'admin'; let perms = new Set(PERMISSIONS); let clientScope = null; let member = null;
  if (!isAdmin) {
    const { data, error } = await supabase.from('nala_members').select('nala_role, all_clients, permissions')
      .eq('tenant_id', session.tenantId).eq('user_id', session.userId).maybeSingle();
    dbError(error);
    member = data;
    // Users with NALA access and no explicit membership keep working as
    // officers over all the firm's clients, as before this module existed.
    role = data?.nala_role || 'oficial';
    perms = permissionsFor(role, data?.permissions);
    if (data && data.all_clients === false) {
      const { data: rows, error: e2 } = await supabase.from('nala_member_clients').select('client_id').eq('tenant_id', session.tenantId).eq('user_id', session.userId);
      dbError(e2);
      clientScope = new Set((rows || []).map(r => r.client_id));
    }
  }
  const ctx = {
    session, userId: session.userId, tenantId: session.tenantId, isAdmin, role, roleLabel: ROLE_LABELS[role], perms, clientScope, member,
    can: p => perms.has(p),
    require(p) { if (!perms.has(p)) fail(403, 'No tiene permiso para esta acción en NALA.'); },
    canClient: id => clientScope === null || clientScope.has(id),
    requireClient(id) { if (clientScope !== null && !clientScope.has(id)) fail(404, 'Empresa no encontrada o no asignada.'); },
    scopeArray: () => (clientScope === null ? null : [...clientScope]),
  };
  return ctx;
}

module.exports = { nalaContext, PERMISSIONS, ROLE_PERMISSIONS, ROLE_LABELS, permissionsFor };
