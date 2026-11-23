import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { remindInvoice, shouldRemindToday } from "@/lib/reminders";
import { todayDO } from "@/lib/format";
import type { Client, Invoice } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  try {
    const db = createAdminClient();
    const today = todayDO();

    // 1) pendientes con fecha pasada -> vencidos
    const { data: marked, error: e1 } = await db.from("invoices").update({ status: "overdue" }).eq("status", "pending").lt("due_date", today).select("id");
    if (e1) throw e1;

    // 2) recordatorios
    const { data, error: e2 } = await db.from("invoices").select("*, clients(*)").in("status", ["pending", "overdue"]);
    if (e2) throw e2;

    let reminded = 0, failed = 0, skipped = 0;
    for (const row of (data || []) as (Invoice & { clients: Client | null })[]) {
      const { clients, ...inv } = row;
      if (!clients || !shouldRemindToday(inv, today)) continue;
      const r = await remindInvoice(db, inv as Invoice, clients);
      if (r.skipped) skipped++;
      else if (r.sent > 0) reminded++;
      else failed++;
    }
    return NextResponse.json({ ok: true, today, markedOverdue: marked?.length ?? 0, reminded, failed, skipped });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Error" }, { status: 500 });
  }
}
