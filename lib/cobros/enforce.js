// Suspender y reactivar el acceso por falta de pago. Dos destinos:
//  · Direct: direct_tenants.license_status = 'suspended' | 'active' (el administrador de la plataforma, root, nunca queda fuera).
//  · Nexo: otra base de datos; se le habla por una Edge Function propia protegida con un secreto compartido
//    (variable NEXO_COBROS_SECRET en Vercel y en Nexo; URL opcional NEXO_COBROS_URL). Ver supabase/nexo/cobros-license.
const supabase = require('../supabase');
const licenses = require('../licenses');

async function setDirect(tenantId, suspended) {
  const { error } = await supabase.from('direct_tenants').update({ license_status: suspended ? 'suspended' : 'active' }).eq('id', tenantId);
  if (error) throw new Error(`Direct: ${error.message}`);
  licenses.forget(tenantId);
}

const nexoConfigured = () => !!process.env.NEXO_COBROS_SECRET;
const nexoUrl = () => process.env.NEXO_COBROS_URL || 'https://jwdwhqzviikwreemkxzh.supabase.co/functions/v1/cobros-license';

// action: 'status' | 'suspend' | 'reactivate'. Lanza Error si no está configurado o Nexo no confirma.
async function nexoCall(action, org, extra = {}) {
  if (!nexoConfigured()) throw new Error('Falta configurar Nexo (variable NEXO_COBROS_SECRET).');
  let r;
  try {
    r = await fetch(nexoUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cobros-secret': process.env.NEXO_COBROS_SECRET }, body: JSON.stringify({ action, org, ...extra }), signal: AbortSignal.timeout(10000) });
  } catch (e) { throw new Error(`Nexo no respondió (${String(e.message || e).slice(0, 80)})`); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.ok === false) throw new Error(`Nexo: ${d.error || 'respondió ' + r.status}`);
  return d;
}

module.exports = { setDirect, nexoCall, nexoConfigured, nexoUrl };
