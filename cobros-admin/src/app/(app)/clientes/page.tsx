import { createClient } from "@/lib/supabase/server";
import { Flash } from "@/components/Flash";
import type { Client } from "@/lib/types";
import { createClientAction, deleteClientAction, optOutAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function Clientes({ searchParams }: { searchParams: { ok?: string; error?: string } }) {
  const { data } = await createClient().from("clients").select("*").order("created_at", { ascending: false });
  const clients = (data || []) as Client[];
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Clientes</h1>
      <Flash ok={searchParams.ok} error={searchParams.error} />
      <form action={createClientAction} className="card grid gap-3 md:grid-cols-3">
        <div><label className="label">Nombre *</label><input name="name" required className="input" /></div>
        <div><label className="label">Correo</label><input name="email" type="email" className="input" /></div>
        <div><label className="label">WhatsApp (+1809…)</label><input name="phone" placeholder="+18095551234" className="input" /></div>
        <div><label className="label">Empresa</label><input name="company" className="input" /></div>
        <div><label className="label">Etiquetas (separadas por coma)</label><input name="tags" placeholder="web, mantenimiento" className="input" /></div>
        <div><label className="label">Notas</label><input name="notes" className="input" /></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="opt_in_email" defaultChecked /> Acepta correos</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="opt_in_whatsapp" /> Acepta WhatsApp</label>
        <div className="md:text-right"><button className="btn" type="submit">Agregar cliente</button></div>
      </form>
      <div className="card overflow-x-auto">
        <table className="min-w-full">
          <thead><tr><th className="th">Nombre</th><th className="th">Contacto</th><th className="th">Etiquetas</th><th className="th">Consentimiento</th><th className="th"></th></tr></thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id} className="border-t border-slate-100">
                <td className="td"><div className="font-medium">{c.name}</div><div className="text-xs text-slate-500">{c.company}</div></td>
                <td className="td"><div>{c.email}</div><div className="text-xs text-slate-500">{c.phone}</div></td>
                <td className="td">{c.tags.join(", ")}</td>
                <td className="td text-xs">
                  <div className="flex flex-wrap gap-1">
                    {c.opt_in_email && <form action={optOutAction}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="channel" value="email" /><button className="btn-sec" title="Dar de baja del correo">Correo ✓ · baja</button></form>}
                    {c.opt_in_whatsapp && <form action={optOutAction}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="channel" value="whatsapp" /><button className="btn-sec" title="Dar de baja de WhatsApp">WhatsApp ✓ · baja</button></form>}
                    {!c.opt_in_email && !c.opt_in_whatsapp && <span className="text-slate-500">Sin consentimiento</span>}
                  </div>
                </td>
                <td className="td text-right"><form action={deleteClientAction}><input type="hidden" name="id" value={c.id} /><button className="btn-danger">Eliminar</button></form></td>
              </tr>
            ))}
            {!clients.length && <tr><td className="td text-slate-500" colSpan={5}>Aún no hay clientes.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
