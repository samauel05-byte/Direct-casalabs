import { createClient } from "@/lib/supabase/server";
import { Flash } from "@/components/Flash";
import { dateTimeDO } from "@/lib/format";
import { sendCampaignAction } from "./actions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Campaign { id: string; name: string; channel: string; audience_tag: string | null; status: string; sent_count: number; failed_count: number; created_at: string }

export default async function Promociones({ searchParams }: { searchParams: { ok?: string; error?: string } }) {
  const db = createClient();
  const [camps, cli] = await Promise.all([
    db.from("campaigns").select("id,name,channel,audience_tag,status,sent_count,failed_count,created_at").order("created_at", { ascending: false }).limit(20),
    db.from("clients").select("tags"),
  ]);
  const tags = Array.from(new Set(((cli.data || []) as { tags: string[] }[]).flatMap((c) => c.tags))).sort();
  const campaigns = (camps.data || []) as Campaign[];

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Promociones</h1>
      <Flash ok={searchParams.ok} error={searchParams.error} />
      <form action={sendCampaignAction} className="card grid gap-3 md:grid-cols-3">
        <div><label className="label">Nombre interno *</label><input name="name" required className="input" /></div>
        <div><label className="label">Canal</label>
          <select name="channel" defaultValue="email" className="input"><option value="email">Correo</option><option value="whatsapp">WhatsApp</option><option value="both">Ambos</option></select></div>
        <div><label className="label">Audiencia</label>
          <select name="tag" defaultValue="" className="input"><option value="">Todos los clientes</option>{tags.map((t) => <option key={t} value={t}>Etiqueta: {t}</option>)}</select></div>
        <div className="md:col-span-3"><label className="label">Asunto (correo)</label><input name="subject" className="input" /></div>
        <div className="md:col-span-3"><label className="label">Mensaje * — variables: {"{{nombre}} {{empresa}} {{negocio}}"}</label>
          <textarea name="body" required rows={5} className="input" /></div>
        <label className="flex items-start gap-2 text-sm md:col-span-3"><input type="checkbox" name="confirm" className="mt-1" />
          <span>Confirmo que envío solo a quienes aceptaron promociones. Se respeta el consentimiento de cada cliente y se añade al final el aviso para responder BAJA.</span></label>
        <div className="md:col-span-3 md:text-right"><button className="btn" type="submit">Enviar campaña</button></div>
      </form>
      <div className="card overflow-x-auto">
        <table className="min-w-full">
          <thead><tr><th className="th">Fecha</th><th className="th">Campaña</th><th className="th">Canal</th><th className="th">Audiencia</th><th className="th">Enviados</th><th className="th">Fallidos</th></tr></thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.id} className="border-t border-slate-100">
                <td className="td">{dateTimeDO(c.created_at)}</td><td className="td">{c.name}</td>
                <td className="td">{c.channel === "both" ? "Correo + WhatsApp" : c.channel === "email" ? "Correo" : "WhatsApp"}</td>
                <td className="td">{c.audience_tag ?? "Todos"}</td><td className="td">{c.sent_count}</td><td className="td">{c.failed_count}</td>
              </tr>
            ))}
            {!campaigns.length && <tr><td className="td text-slate-500" colSpan={6}>Sin campañas todavía.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
