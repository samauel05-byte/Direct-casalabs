import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dispatch } from "./messaging";
import { daysBetween, todayDO } from "./format";
import { reminderMessage } from "./templates";
import type { Client, Invoice } from "./types";

export interface RemindOutcome { sent: number; failed: number; skipped: boolean; errors: string[] }

/** Envía el recordatorio de un cobro por los canales aceptados y actualiza last_reminder_at/reminder_count. */
export async function remindInvoice(
  db: SupabaseClient,
  inv: Invoice,
  client: Client,
  kind: "reminder" | "invoice" = "reminder"
): Promise<RemindOutcome> {
  const today = todayDO();
  const { subject, body } = reminderMessage(inv, client, daysBetween(today, inv.due_date));
  const out: RemindOutcome = { sent: 0, failed: 0, skipped: false, errors: [] };

  for (const channel of ["email", "whatsapp"] as const) {
    const r = await dispatch({ db, channel, kind, client, subject, body, invoiceId: inv.id });
    if (!r) continue;
    if (r.ok) out.sent++;
    else { out.failed++; if (r.error) out.errors.push(r.error); }
  }
  if (out.sent + out.failed === 0) out.skipped = true;

  if (out.sent > 0) {
    await db.from("invoices").update({ last_reminder_at: new Date().toISOString(), reminder_count: inv.reminder_count + 1 }).eq("id", inv.id);
  }
  return out;
}

/** ¿Toca recordar hoy? 3 días antes, 1 día antes, el día del vencimiento y cada 3 días en mora. */
export function shouldRemindToday(inv: Pick<Invoice, "due_date" | "last_reminder_at">, today: string) {
  if (inv.last_reminder_at && todayDO(new Date(inv.last_reminder_at)) === today) return false; // máx. 1 por día
  const d = daysBetween(today, inv.due_date);
  return d === 3 || d === 1 || d === 0 || (d < 0 && Math.abs(d) % 3 === 0);
}
