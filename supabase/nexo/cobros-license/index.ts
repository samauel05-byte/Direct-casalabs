// Cobros (Direct) → Nexo: consultar, suspender o reactivar una empresa de Nexo por falta de pago.
// Se despliega en el proyecto «nexo» de Supabase como Edge Function `cobros-license` (sin verificación de JWT:
// la autorización es el secreto compartido NEXO_COBROS_SECRET que también está en Vercel, en el proyecto de Direct).
//   POST { action: 'status' | 'suspend' | 'reactivate', org: '<uuid | nombre exacto>', reason?, period?, paid_period? }
//   Cabecera: x-cobros-secret: <NEXO_COBROS_SECRET>
// Seguridad: compara el secreto en tiempo constante, resuelve la empresa por id o por nombre EXACTO (si hay más de una, falla),
// nunca suspende la empresa de la plataforma («CaSa Labs») y deja cada cambio en license_events.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Método no permitido' }, 405)
  const secret = Deno.env.get('NEXO_COBROS_SECRET') || ''
  if (secret.length < 24) return json({ ok: false, error: 'NEXO_COBROS_SECRET no está configurado (mínimo 24 caracteres)' }, 503)
  if (!safeEqual(req.headers.get('x-cobros-secret') || '', secret)) return json({ ok: false, error: 'No autorizado' }, 401)

  const body = await req.json().catch(() => ({}))
  const action = String(body.action || '')
  if (!['status', 'suspend', 'reactivate'].includes(action)) return json({ ok: false, error: 'Acción desconocida' }, 400)
  const orgRef = String(body.org || '').trim()
  if (!orgRef) return json({ ok: false, error: 'Falta la empresa' }, 400)

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const cols = 'id, name, status, license_until, settings'
  const q = UUID.test(orgRef) ? admin.from('organizations').select(cols).eq('id', orgRef) : admin.from('organizations').select(cols).ilike('name', orgRef.replace(/[%_]/g, (c) => '\\' + c))
  const { data: found, error } = await q.limit(3)
  if (error) return json({ ok: false, error: 'No se pudo consultar la empresa' }, 500)
  const matches = (found || []).filter((o: any) => UUID.test(orgRef) || String(o.name).toLowerCase() === orgRef.toLowerCase())
  if (matches.length !== 1) return json({ ok: false, error: matches.length ? 'Hay más de una empresa con ese nombre: usa el id' : 'Empresa no encontrada' }, matches.length ? 409 : 404)
  const org: any = matches[0]
  const view = { id: org.id, name: org.name, status: org.status, license_until: org.license_until }
  if (action === 'status') return json({ ok: true, org: view })

  const reason = String(body.reason || '').slice(0, 200)
  if (action === 'suspend') {
    if (/^casa\s*labs$/i.test(String(org.name).trim())) return json({ ok: false, error: 'La empresa de la plataforma no se puede suspender' }, 403)
    if (org.status === 'suspended') return json({ ok: true, org: view, unchanged: true })
    if (!['active', 'past_due', 'trial'].includes(org.status)) return json({ ok: false, error: `No se suspende una empresa en estado «${org.status}»` }, 409)
    const { error: e1 } = await admin.from('organizations').update({ status: 'suspended', updated_at: new Date().toISOString() }).eq('id', org.id)
    if (e1) return json({ ok: false, error: 'No se pudo suspender' }, 500)
    await admin.from('license_events').insert({ org_id: org.id, kind: 'manual', payload: { status: 'suspended', note: 'Cobros: ' + (reason || 'pago no recibido'), by: 'cobros' } })
    return json({ ok: true, org: { ...view, status: 'suspended' } })
  }

  // reactivate: solo si la suspendió falta de pago (estado suspended); nunca revive una cancelada
  if (org.status !== 'suspended') return json({ ok: true, org: view, unchanged: true })
  const settings = { ...(org.settings || {}) }
  const paid = String(body.paid_period || '').trim()
  if (/^\d{4}-\d{2}$/.test(paid) && settings.payment_reminder) settings.payment_reminder = { ...settings.payment_reminder, paid_period: paid }
  const { error: e2 } = await admin.from('organizations').update({ status: 'active', settings, updated_at: new Date().toISOString() }).eq('id', org.id)
  if (e2) return json({ ok: false, error: 'No se pudo reactivar' }, 500)
  await admin.from('license_events').insert({ org_id: org.id, kind: 'manual', payload: { status: 'active', note: 'Cobros: ' + (reason || 'pago recibido'), by: 'cobros' } })
  return json({ ok: true, org: { ...view, status: 'active' } })
})
