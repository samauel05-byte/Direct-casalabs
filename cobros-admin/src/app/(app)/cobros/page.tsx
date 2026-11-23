import { createClient } from "@/lib/supabase/server";
import { Flash } from "@/components/Flash";
import { dateDO, money, todayDO } from "@/lib/format";
import type { Invoice } from "@/lib/types";
import { createInvoiceAction, markPaidAction, remindAction } from "./actions";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const STATUS: Record<string, string> = { pending: "Pendiente", paid: "Pagado", overdue: "Vencido", cancelled: "Cancelado" };

export default async function Cobros({ searchParams }: { searchParams: { ok?: string; error?: string } }) {
  const db = createClient();
  const [inv, cli] = await Promise.all([
    db.from("invoices").select("*, clients(name)").order("due_date", { ascending: true }),
    db.from("clients").select("id,name").order("name"),
  ]);
  const invoices = (inv.data || []) as (Invoice & { clients: { name: string } | null })[];
  const clients = (cli.data || []) as { id: string; name: string }[];
  const today = todayDO();

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Cobros</h1>
      <Flash ok={searchParams.ok} error={searchParams.error} />
      <form action={createInvoiceAction} className="card grid gap-3 md:grid-cols-3">
        <div><label className="label">Cliente *</label>
          <select name="client_id" required className="input" defaultValue="">
            <option value="" disabled>Selecciona…</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></div>
        <div><label className="label">Concepto *</label><input name="concept" required className="input" /></div>
        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-2"><label className="label">Monto *</label><input name="amount" type="number" step="0.01" min="0.01" required className="input" /></div>
          <div><label className="label">Moneda</label>
            <select name="currency" defaultValue="DOP" className="input"><option value="DOP">RD$</option><option value="USD">US$</option></select></div>
        </div>
        <div><label className="label">Vence *</label><input name="due_date" type="date" required className="input" /></div>
        <div className="md:col-span-2"><label className="label">Enlace de pago (Azul, CardNET, Fygaro, PayPal…)</label><input name="payment_link" type="url" className="input" /></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="notify" /> Avisar al cliente al crear</label>
        <div className="md:col-span-2 md:text-right"><button className="btn" type="submit">Crear cobro</button></div>
      </form>
      <div className="card overflow-x-auto">
        <table className="min-w-full">
          <thead><tr><th className="th">Cliente</th><th className="th">Concepto</th><th className="th">Monto</th><th className="th">Vence</th><th className="th">Estado</th><th className="th">Avisos</th><th className="th"></th></tr></thead>
          <tbody>
            {invoices.map((i) => {
              const late = i.status === "pending" && i.due_date < today;
              const open = i.status === "pending" || i.status === "overdue";
              return (
                <tr key={i.id} className="border-t border-slate-100">
                  <td className="td">{i.clients?.name}</td>
                  <td className="td">{i.concept}{i.payment_link && <a className="ml-2 text-xs text-indigo-700 underline" href={i.payment_link} target="_blank" rel="noreferrer">enlace</a>}</td>
                  <td className="td whitespace-nowrap font-medium">{money(i.amount, i.currency)}</td>
                  <td className="td whitespace-nowrap">{dateDO(i.due_date)}</td>
                  <td className={`td ${i.status === "overdue" || late ? "text-red-700" : i.status === "paid" ? "text-green-700" : ""}`}>{late ? "Vencido" : STATUS[i.status]}</td>
                  <td className="td text-xs text-slate-500">{i.reminder_count}{i.last_reminder_at ? ` · ${dateDO(i.last_reminder_at)}` : ""}</td>
                  <td className="td">
                    {open && (
                      <div className="flex flex-wrap justify-end gap-1">
                        <form action={remindAction}><input type="hidden" name="id" value={i.id} /><button className="btn-sec">Recordar</button></form>
                        <form action={markPaidAction}><input type="hidden" name="id" value={i.id} /><button className="btn-sec">Marcar pagado</button></form>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {!invoices.length && <tr><td className="td text-slate-500" colSpan={7}>Aún no hay cobros.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
