import { createClient } from "@/lib/supabase/server";
import { dateTimeDO, money, todayDO } from "@/lib/format";
import type { Currency, Invoice, MessageLog } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function Resumen() {
  const supabase = createClient();
  const today = todayDO();
  const monthStart = today.slice(0, 8) + "01";

  const [inv, cli, logs] = await Promise.all([
    supabase.from("invoices").select("amount,currency,status,due_date,paid_at"),
    supabase.from("clients").select("id", { count: "exact", head: true }),
    supabase.from("message_log").select("id,channel,kind,recipient,status,error,created_at").order("created_at", { ascending: false }).limit(8),
  ]);

  const rows = (inv.data || []) as Pick<Invoice, "amount" | "currency" | "status" | "due_date" | "paid_at">[];
  const totals: Record<Currency, { receivable: number; overdue: number; paid: number }> = {
    DOP: { receivable: 0, overdue: 0, paid: 0 },
    USD: { receivable: 0, overdue: 0, paid: 0 },
  };
  for (const r of rows) {
    const t = totals[r.currency] ?? totals.DOP;
    const amount = Number(r.amount);
    if (r.status === "pending" || r.status === "overdue") {
      t.receivable += amount;
      if (r.status === "overdue" || r.due_date < today) t.overdue += amount;
    } else if (r.status === "paid" && r.paid_at && todayDO(new Date(r.paid_at)) >= monthStart) {
      t.paid += amount;
    }
  }

  const recent = (logs.data || []) as Pick<MessageLog, "id" | "channel" | "kind" | "recipient" | "status" | "error" | "created_at">[];

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Resumen</h1>
      <div className="grid gap-4 md:grid-cols-2">
        {(["DOP", "USD"] as Currency[]).map((c) => (
          <section key={c} className="card">
            <h2 className="mb-3 text-sm font-semibold text-slate-600">{c === "DOP" ? "Pesos dominicanos (RD$)" : "Dólares (US$)"}</h2>
            <dl className="grid grid-cols-3 gap-2 text-sm">
              <div><dt className="text-xs text-slate-500">Por cobrar</dt><dd className="text-lg font-semibold">{money(totals[c].receivable, c)}</dd></div>
              <div><dt className="text-xs text-slate-500">Vencido</dt><dd className="text-lg font-semibold text-red-700">{money(totals[c].overdue, c)}</dd></div>
              <div><dt className="text-xs text-slate-500">Cobrado este mes</dt><dd className="text-lg font-semibold text-green-700">{money(totals[c].paid, c)}</dd></div>
            </dl>
          </section>
        ))}
      </div>
      <p className="text-sm text-slate-600">Clientes registrados: <strong>{cli.count ?? 0}</strong></p>
      <section className="card overflow-x-auto">
        <h2 className="mb-2 text-sm font-semibold text-slate-600">Últimos mensajes</h2>
        <table className="min-w-full">
          <thead><tr><th className="th">Fecha</th><th className="th">Canal</th><th className="th">Tipo</th><th className="th">Destino</th><th className="th">Estado</th></tr></thead>
          <tbody>
            {recent.map((m) => (
              <tr key={m.id} className="border-t border-slate-100">
                <td className="td">{dateTimeDO(m.created_at)}</td>
                <td className="td">{m.channel === "email" ? "Correo" : "WhatsApp"}</td>
                <td className="td">{m.kind === "reminder" ? "Recordatorio" : m.kind === "promo" ? "Promoción" : "Cobro"}</td>
                <td className="td">{m.recipient}</td>
                <td className={`td ${m.status === "failed" ? "text-red-700" : "text-green-700"}`}>{m.status === "failed" ? `Fallido${m.error ? `: ${m.error}` : ""}` : "Enviado"}</td>
              </tr>
            ))}
            {!recent.length && <tr><td className="td text-slate-500" colSpan={5}>Aún no hay mensajes.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
