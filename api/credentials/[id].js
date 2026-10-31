const db = require('../../lib/db');
const { authenticate } = require('../../lib/auth');

// Quién puede tocar qué:
//  · Administrador: crear, editar y eliminar cualquier credencial de su firma.
//  · Usuario normal: solo ACTUALIZAR (p. ej. la clave) credenciales que ya existen y que él mismo puede ver
//    (portal en portals_direct y, si tiene empresas asignadas, solo esas). No crea, no elimina y no
//    cambia la credencial de portal.
module.exports = async (req, res) => {
  const session = await authenticate(req);
  if (!session) return res.status(401).json({ error: 'No autorizado' });
  const isAdmin = session.role === 'admin';
  if (!isAdmin && !session.access_direct) return res.status(403).json({ error: 'Sin acceso a Direct' });
  // Sin tenant no se puede garantizar el aislamiento entre firmas: fallar cerrado.
  if (!session.tenantId) return res.status(409).json({ error: 'Falta la migración de empresas' });
  const { id } = req.query;
  try {
    if (req.method === 'PUT') {
      const { institution, category, iv, ct } = req.body || {};
      if (!institution || !category || !iv || !ct) return res.status(400).json({ error: 'missing fields' });
      if (!isAdmin) {
        const current = await db.getCredential(session.tenantId, id);
        const portalOk = current && Array.isArray(session.portals_direct) && session.portals_direct.includes(current.institution);
        const companyOk = current && (!Array.isArray(session.companies_direct) || session.companies_direct.includes(current.id));
        if (!current) return res.status(403).json({ error: 'Solo un administrador puede agregar empresas nuevas.' });
        if (!portalOk || !companyOk) return res.status(403).json({ error: 'No tienes acceso a esta empresa.' });
        if (institution !== current.institution || category !== current.category) return res.status(403).json({ error: 'Solo un administrador puede cambiar el portal de una empresa.' });
      }
      const ts = Date.now();
      await db.upsertCredential(session.tenantId, id, institution, category, iv, ct, ts);
      return res.json({ ok: true, updated_at: ts });
    }
    if (req.method === 'DELETE') {
      if (!isAdmin) return res.status(403).json({ error: 'Solo un administrador puede eliminar empresas.' });
      await db.deleteCredential(session.tenantId, id);
      return res.json({ ok: true });
    }
    res.status(405).end();
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Error interno del servidor' });
  }
};
