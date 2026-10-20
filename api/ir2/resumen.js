const supabase = require('../../lib/supabase');
const { authenticate } = require('../../lib/auth');

module.exports = async (req, res) => {
  const session = await authenticate(req);
  if (!session) return res.status(401).json({ error: 'No autorizado' });
  const requestedType = req.method === 'POST' ? req.body?.tipo : req.query?.tipo;
  // 'dgii-modulos' es el módulo de Estimación Fiscal (Anexos DGII); se rige por
  // el permiso de Estimación, igual que 'estimacion'. Se admite también IR-2.
  const isEstimate = requestedType === 'estimacion' || requestedType === 'dgii-modulos';
  const allowed = session.role === 'admin' || (isEstimate ? (session.access_estimacion || session.access_ir2) : session.access_ir2);
  if (!allowed) {
    return res.status(403).json({ error: isEstimate ? 'Sin acceso a Estimación Fiscal' : 'Sin acceso a IR-2' });
  }
  // Aislamiento multiempresa: toda fila de ir2_resumen pertenece a un tenant.
  // Sin tenant no se puede garantizar el aislamiento, así que se rechaza.
  if (!session.tenantId) return res.status(409).json({ error: 'Falta la migración de empresas' });
  const tenantId = session.tenantId;

  try {
    // Estimación Fiscal pide lo que NALA tiene aprobado (606/607) de la empresa y el año:
    // solo lectura, mismo permiso y mismo tenant que el resto de este endpoint.
    if (req.method === 'GET' && req.query?.fuente === 'nala') {
      if (!req.query.rnc) return res.status(400).json({ error: 'rnc requerido' });
      try {
        const summary = await require('../../lib/nala/fiscal-summary').summarize({ tenantId, rnc: req.query.rnc, anio: req.query.anio || new Date().getFullYear() });
        return res.json({ ok: true, ...summary });
      } catch (e) {
        if (e.status === 400) return res.status(400).json({ error: e.message });
        throw e;
      }
    }

    if (req.method === 'GET') {
      const { rnc, anio, tipo = 'ir2' } = req.query;
      if (!rnc) return res.status(400).json({ error: 'rnc requerido' });

      if (anio) {
        const { data, error } = await supabase
          .from('ir2_resumen')
          .select('*')
          .eq('tenant_id', tenantId)
          .eq('rnc', rnc)
          .eq('anio', parseInt(anio))
          .eq('tipo', tipo)
          .maybeSingle();
        if (error) throw error;
        return res.json({ ok: true, record: data || null });
      } else {
        const { data, error } = await supabase
          .from('ir2_resumen')
          .select('rnc, anio, nombre, tipo, updated_at')
          .eq('tenant_id', tenantId)
          .eq('rnc', rnc)
          .eq('tipo', tipo)
          .order('anio', { ascending: false });
        if (error) throw error;
        return res.json({ ok: true, records: data || [] });
      }
    }

    if (req.method === 'POST') {
      const { rnc, anio, nombre, data, tipo = 'ir2' } = req.body || {};
      if (!rnc || !anio) return res.status(400).json({ error: 'rnc y anio requeridos' });

      const { data: saved, error } = await supabase
        .from('ir2_resumen')
        .upsert(
          { tenant_id: tenantId, rnc, anio: parseInt(anio), nombre: nombre || '', tipo, data: data || {}, updated_at: new Date().toISOString() },
          { onConflict: 'tenant_id,rnc,anio,tipo' }
        )
        .select()
        .single();
      if (error) throw error;
      return res.json({ ok: true, record: saved });
    }

    if (req.method === 'DELETE') {
      const { rnc, anio, tipo = 'ir2' } = req.query;
      if (!rnc || !anio) return res.status(400).json({ error: 'rnc y anio requeridos' });
      const { error } = await supabase
        .from('ir2_resumen')
        .delete()
        .eq('tenant_id', tenantId)
        .eq('rnc', rnc)
        .eq('anio', parseInt(anio))
        .eq('tipo', tipo);
      if (error) throw error;
      return res.json({ ok: true });
    }

    res.status(405).end();
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Error interno del servidor' });
  }
};
