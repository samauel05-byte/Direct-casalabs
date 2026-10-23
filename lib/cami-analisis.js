// CAMI · análisis de ITBIS guardados (tabla cami_analisis).
//   GET  ?id=…        → un análisis completo (con data)
//   GET  ?borrador=1  → el autoguardado del usuario (o null)
//   GET               → lista de copias guardadas del equipo (sin data)
//   POST {id?, nombre, rnc, periodo, data, resumen, borrador}
//        borrador:true  → sobrescribe el autoguardado del usuario
//        id             → actualiza esa copia (solo los campos enviados)
//        sin id         → crea una copia nueva
//   DELETE ?id=…      → borra (el autor o un administrador; el borrador solo su dueño)
// Aislado por tenant. `data` llega comprimido desde el navegador ({v, gz}); aquí solo se valida el
// tamaño (el límite de Vercel para el cuerpo es 4.5 MB).
const supabase = require('./supabase');

const MAX_DATA = 3.8 * 1024 * 1024;
const LIST_COLS = 'id, nombre, rnc, periodo, borrador, resumen, created_by, updated_by, created_at, updated_at';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bytes = v => Buffer.byteLength(JSON.stringify(v == null ? null : v), 'utf8');

async function handle(req, res, session) {
  if (!(session.role === 'admin' || session.access_cami)) return res.status(403).json({ error: 'Sin acceso a CAMI' });
  if (!session.tenantId) return res.status(409).json({ error: 'Falta la migración de empresas' });
  const tenantId = session.tenantId;
  const q = req.query || {};
  const table = () => supabase.from('cami_analisis');

  try {
    if (req.method === 'GET') {
      if (q.borrador) {
        const { data, error } = await table().select('*').eq('tenant_id', tenantId).eq('created_by', session.userId).eq('borrador', true).maybeSingle();
        if (error) throw error;
        return res.json({ ok: true, record: data || null });
      }
      if (q.id) {
        if (!UUID.test(String(q.id))) return res.status(400).json({ error: 'id inválido' });
        const { data, error } = await table().select('*').eq('tenant_id', tenantId).eq('id', q.id).maybeSingle();
        if (error) throw error;
        if (!data || (data.borrador && data.created_by !== session.userId)) return res.status(404).json({ error: 'Análisis no encontrado' });
        return res.json({ ok: true, record: data });
      }
      const { data, error } = await table().select(LIST_COLS).eq('tenant_id', tenantId).eq('borrador', false).order('updated_at', { ascending: false }).limit(300);
      if (error) throw error;
      return res.json({ ok: true, items: (data || []).map(r => ({ ...r, mio: r.created_by === session.userId })), me: session.userId });
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      const patch = { updated_by: session.userId, updated_at: new Date().toISOString() };
      if (b.nombre !== undefined) {
        const nombre = str(b.nombre, 160);
        if (!nombre) return res.status(400).json({ error: 'Escribe un nombre para el análisis.' });
        patch.nombre = nombre;
      }
      if (b.rnc !== undefined) patch.rnc = str(b.rnc, 40) || null;
      if (b.periodo !== undefined) patch.periodo = str(b.periodo, 40) || null;
      if (b.resumen !== undefined) {
        if (typeof b.resumen !== 'object' || b.resumen === null || bytes(b.resumen) > 8192) return res.status(400).json({ error: 'Resumen inválido' });
        patch.resumen = b.resumen;
      }
      if (b.data !== undefined) {
        if (typeof b.data !== 'object' || b.data === null || Array.isArray(b.data)) return res.status(400).json({ error: 'Datos inválidos' });
        if (bytes(b.data) > MAX_DATA) return res.status(413).json({ error: 'El análisis es demasiado grande para guardarse (límite ≈ 3.8 MB comprimido).' });
        patch.data = b.data;
      }

      if (b.borrador) {
        patch.nombre = patch.nombre || 'Borrador automático';
        const find = () => table().select('id').eq('tenant_id', tenantId).eq('created_by', session.userId).eq('borrador', true).maybeSingle();
        const update = id => table().update(patch).eq('tenant_id', tenantId).eq('id', id).select('id, updated_at').single();
        let { data: cur, error } = await find();
        if (error) throw error;
        if (cur) { ({ data: cur, error } = await update(cur.id)); if (error) throw error; return res.json({ ok: true, id: cur.id, updated_at: cur.updated_at }); }
        const ins = await table().insert({ ...patch, tenant_id: tenantId, created_by: session.userId, borrador: true }).select('id, updated_at').single();
        if (ins.error && ins.error.code === '23505') { // carrera entre dos pestañas
          const again = await find(); if (again.data) { const u = await update(again.data.id); if (u.error) throw u.error; return res.json({ ok: true, id: u.data.id, updated_at: u.data.updated_at }); }
        }
        if (ins.error) throw ins.error;
        return res.json({ ok: true, id: ins.data.id, updated_at: ins.data.updated_at });
      }

      if (b.id) {
        if (!UUID.test(String(b.id))) return res.status(400).json({ error: 'id inválido' });
        const { data, error } = await table().update(patch).eq('tenant_id', tenantId).eq('id', b.id).eq('borrador', false).select('id, updated_at').maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Análisis no encontrado' });
        return res.json({ ok: true, id: data.id, updated_at: data.updated_at });
      }

      if (!patch.nombre) return res.status(400).json({ error: 'Escribe un nombre para el análisis.' });
      if (patch.data === undefined) return res.status(400).json({ error: 'Faltan los datos del análisis.' });
      const { data, error } = await table().insert({ ...patch, tenant_id: tenantId, created_by: session.userId, borrador: false }).select('id, updated_at').single();
      if (error) throw error;
      return res.status(201).json({ ok: true, id: data.id, updated_at: data.updated_at });
    }

    if (req.method === 'DELETE') {
      if (!q.id || !UUID.test(String(q.id))) return res.status(400).json({ error: 'id requerido' });
      const { data: cur, error } = await table().select('id, created_by, borrador').eq('tenant_id', tenantId).eq('id', q.id).maybeSingle();
      if (error) throw error;
      if (!cur) return res.status(404).json({ error: 'Análisis no encontrado' });
      if (cur.created_by !== session.userId && (cur.borrador || session.role !== 'admin')) return res.status(403).json({ error: 'Solo quien lo guardó o un administrador puede borrarlo.' });
      const del = await table().delete().eq('tenant_id', tenantId).eq('id', q.id);
      if (del.error) throw del.error;
      return res.json({ ok: true });
    }

    return res.status(405).end();
  } catch (e) {
    console.error('[cami-analisis]', e);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = { handle };
