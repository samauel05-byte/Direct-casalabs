import { createClient } from "@/lib/supabase/server";
import { dateTimeDO } from "@/lib/format";
import type { MessageLog } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function Historial() {
  const { data } = await createClient().from("message_log").select("*, clients(name)").order("created_at", { ascending: false }).limit(200);
  const logs = (data || []) as (MessageLog & { clients: { name: string } | null })[];
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Historial de envíos</h1>
      <div className="card overflow-x-auto">
        <table className="min-w-full">
          <thead><tr><th className="th">Fecha</th><th className="th">Cliente</th><th className="th">Canal</th><th className="th">Tipo</th><th className="th">Destino</th><th className="th">Estado</th><th className="th">Mensaje</th></tr></thead>
          <tbody>
            {logs.map((m) => (
              <tr key={m.id} className="border-t border-slate-100">
                <td className="td whitespace-nowrap">{dateTimeDO(m.created_at)}</td>
                <td className="td">{m.clients?.name ?? "—"}</td>
                <td className="td">{m.channel === "email" ? "Correo" : "WhatsApp"}</td>
                <td className="td">{m.kind === "reminder" ? "Recordatorio" : m.kind === "promo" ? "Promoción" : "Cobro"}</td>
                <td className="td">{m.recipient}</td>
                <td className={`td ${m.status === "failed" ? "text-red-700" : "text-green-700"}`}>{m.status === "failed" ? "Fallido" : "Enviado"}{m.error && <div className="text-xs">{m.error}</div>}</td>
                <td className="td max-w-xs truncate text-xs text-slate-500" title={m.body ?? ""}>{m.body}</td>
              </tr>
            ))}
            {!logs.length && <tr><td className="td text-slate-500" colSpan={7}>Sin envíos todavía.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
