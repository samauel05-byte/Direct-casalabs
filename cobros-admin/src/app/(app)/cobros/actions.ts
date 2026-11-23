"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { remindInvoice } from "@/lib/reminders";
import type { Client, Invoice } from "@/lib/types";

const str = (f: FormData, k: string) => String(f.get(k) || "").trim();
const back = (kind: "ok" | "error", msg: string): never => redirect(`/cobros?${kind}=${encodeURIComponent(msg)}`);

function summarize(o: { sent: number; failed: number; skipped: boolean; errors: string[] }) {
  if (o.skipped) return { kind: "error" as const, msg: "El cliente no tiene un canal aceptado (consentimiento y dato de contacto)." };
  if (o.failed && !o.sent) return { kind: "error" as const, msg: `No se pudo enviar: ${o.errors[0] ?? "error desconocido"}. Queda registrado en el historial.` };
  if (o.failed) return { kind: "ok" as const, msg: `Enviado por ${o.sent} canal(es); ${o.failed} falló (ver historial).` };
  return { kind: "ok" as const, msg: "Mensaje enviado." };
}

export async function createInvoiceAction(formData: FormData) {
  const db = await requireUser();
  const amount = Number(str(formData, "amount").replace(/,/g, ""));
  const currency = str(formData, "currency") === "USD" ? "USD" : "DOP";
  const due = str(formData, "due_date");
  if (!str(formData, "client_id") || !str(formData, "concept") || !(amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(due))
    back("error", "Completa cliente, concepto, monto (mayor que 0) y fecha de vencimiento.");

  const { data, error } = await db.from("invoices").insert({
    client_id: str(formData, "client_id"),
    concept: str(formData, "concept"),
    amount,
    currency,
    due_date: due,
    payment_link: str(formData, "payment_link") || null,
  }).select("*, clients(*)").single();
  if (error || !data) back("error", "No se pudo crear el cobro: " + (error?.message ?? ""));

  let note = "Cobro creado.";
  if (formData.get("notify") === "on" && data) {
    const { clients, ...inv } = data as Invoice & { clients: Client };
    const s = summarize(await remindInvoice(db, inv as Invoice, clients, "invoice"));
    note += " " + s.msg;
  }
  revalidatePath("/cobros");
  back("ok", note);
}

export async function remindAction(formData: FormData) {
  const db = await requireUser();
  const { data, error } = await db.from("invoices").select("*, clients(*)").eq("id", str(formData, "id")).single();
  if (error || !data) back("error", "No se encontró el cobro.");
  const { clients, ...inv } = data as Invoice & { clients: Client };
  if (inv.status === "paid" || inv.status === "cancelled") back("error", "Ese cobro ya no está pendiente.");
  const s = summarize(await remindInvoice(db, inv as Invoice, clients));
  revalidatePath("/cobros");
  back(s.kind, s.msg);
}

export async function markPaidAction(formData: FormData) {
  const db = await requireUser();
  const { error } = await db.from("invoices").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", str(formData, "id"));
  if (error) back("error", "No se pudo actualizar: " + error.message);
  revalidatePath("/cobros");
  back("ok", "Cobro marcado como pagado.");
}
