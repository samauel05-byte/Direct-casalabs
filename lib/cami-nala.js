// CAMI ← NALA: entrega el 606/607 APROBADO en NALA de una empresa y un período, con las
// columnas oficiales de la DGII, para que CAMI lo cargue solo (sin subir archivos).
// Solo lectura, aislado por tenant. Mismo armado (buildSnapshot) que el TXT/Excel de NALA,
// así CAMI ve exactamente lo que NALA exportaría.
const supabase = require('./supabase');
const formats = require('./nala/formats');
const ids = require('./nala/ids');
const settingsStore = require('./nala/settings');
const { dopAmount } = require('./nala/validate');

const cents = v => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : 0; };

async function handle(req, res, session) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!(session.role === 'admin' || session.access_cami || session.access_nala)) return res.status(403).json({ error: 'Sin acceso a CAMI' });
  if (!session.tenantId) return res.status(409).json({ error: 'Falta la migración de empresas' });
  const tenantId = session.tenantId;
  const rnc = ids.digitsOnly(req.query?.rnc);
  const period = String(req.query?.periodo || '').replace(/\D/g, '');
  if (!rnc) return res.status(400).json({ error: 'rnc requerido' });
  if (!/^20\d{2}(0[1-9]|1[0-2])$/.test(period)) return res.status(400).json({ error: 'Período inválido (AAAAMM)' });
  try {
    const { data: clients, error: ce } = await supabase.from('direct_clients').select('id, legal_name, rnc, cedula, status').eq('tenant_id', tenantId);
    if (ce) throw ce;
    const matches = (clients || []).filter(c => ids.digitsOnly(c.rnc) === rnc || ids.digitsOnly(c.cedula) === rnc);
    const client = matches.find(c => c.status !== 'inactive') || matches[0] || null;
    if (!client) return res.json({ ok: true, client: null, periodo: period, formatos: {} });

    // Respeta las empresas asignadas en NALA (Equipo): si el usuario tiene un alcance limitado, solo ve las suyas.
    if (session.role !== 'admin') {
      const { data: member } = await supabase.from('nala_members').select('all_clients').eq('tenant_id', tenantId).eq('user_id', session.userId).maybeSingle();
      if (member && member.all_clients === false) {
        const { data: asg } = await supabase.from('nala_member_clients').select('client_id').eq('tenant_id', tenantId).eq('user_id', session.userId).eq('client_id', client.id).limit(1);
        if (!asg || !asg.length) return res.status(403).json({ error: 'Esa empresa no está asignada a tu usuario en NALA' });
      }
    }

    const { data: invoices, error } = await supabase.from('nala_invoices').select('*')
      .eq('tenant_id', tenantId).eq('client_id', client.id).eq('period', period).in('format', ['606', '607']).neq('status', 'excluded').limit(70000);
    if (error) throw error;
    const settings = await settingsStore.load(tenantId);
    const out = {};
    for (const format of ['606', '607']) {
      const list = (invoices || []).filter(i => i.format === format);
      const aprobados = list.filter(i => i.status === 'approved');
      const pendientes = list.length - aprobados.length;
      const entry = { aprobados: aprobados.length, pendientes, headers: [], rows: [], consumo: null, ecf_excluidos: 0 };
      if (aprobados.length) {
        const snap = formats.buildSnapshot({ format, period, client, invoices: list, pendingCount: pendientes, settings: settings.rules });
        entry.headers = snap.columns.map(c => c.label);
        entry.rows = snap.lines.map(l => Object.fromEntries(snap.columns.map((c, i) => [c.label, l.values[i] === '' || l.values[i] == null ? null : l.values[i]])));
        entry.ecf_excluidos = snap.excluded.filter(e => /e-CF/.test(e.reason || '')).length;
        if (snap.consumer_summary) {
          let base = 0, exento = 0, itbis = 0;
          for (const c of snap.consumer_summary.invoices) { const m = cents(c.monto_facturado), t = cents(c.itbis); itbis += t; if (t > 0) base += m; else exento += m; }
          entry.consumo = { count: snap.consumer_summary.count, gravado: base / 100, exento: exento / 100, itbis: itbis / 100 };
        }
      }
      out[format] = entry;
    }
    return res.json({ ok: true, client: { id: client.id, legal_name: client.legal_name, rnc: client.rnc || client.cedula || '' }, periodo: period, formatos: out });
  } catch (e) {
    console.error(e); return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = { handle };
