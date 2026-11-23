"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { dispatch } from "@/lib/messaging";
import { UNSUBSCRIBE_FOOTER, fillVars } from "@/lib/templates";
import type { Client } from "@/lib/types";

const str = (f: FormData, k: string) => String(f.get(k) || "").trim();
const back = (kind: "ok" | "error", msg: string): never => redirect(`/promociones?${kind}=${encodeURIComponent(msg)}`);

// Sin cola: tope por envío para no pasar el tiempo máximo de la función. Ver README.
const MAX_RECIPIENTS = 150;
const CONCURRENCY = 5;

export async function sendCampaignAction(formData: FormData) {
  const db = await requireUser();
  const name = str(formData, "name");
  const channel = str(formData, "channel");
  const subject = str(formData, "subject");
  const body = str(formData, "body");
  const tag = str(formData, "tag").toLowerCase();

  if (!name || !body || !["email", "whatsapp", "both"].includes(channel)) back("error", "Completa nombre, canal y mensaje.");
  if (channel !== "whatsapp" && !subject) back("error", "El asunto es obligatorio para correo.");
  if (formData.get("confirm") !== "on") back("error", "Confirma que los destinatarios aceptaron recibir promociones y que el mensaje incluye la baja.");

  let q = db.from("clients").select("*");
  if (tag) q = q.contains("tags", [tag]);
  const { data, error } = await q.limit(MAX_RECIPIENTS + 1);
  if (error) back("error", "No se pudo leer la audiencia: " + error.message);
  let clients = (data || []) as Client[];
  const truncated = clients.length > MAX_RECIPIENTS;
  clients = clients.slice(0, MAX_RECIPIENTS);

  const { data: camp, error: cErr } = await db.from("campaigns").insert({
    name, channel, subject: subject || null, body, audience_tag: tag || null, status: "sending",
  }).select("id").single();
  if (cErr || !camp) back("error", "No se pudo crear la campaña: " + (cErr?.message ?? ""));

  const channels = channel === "both" ? (["email", "whatsapp"] as const) : ([channel] as ("email" | "whatsapp")[]);
  let sent = 0, failed = 0;

  for (let i = 0; i < clients.length; i += CONCURRENCY) {
    await Promise.all(clients.slice(i, i + CONCURRENCY).map(async (c) => {
      for (const ch of channels) {
        const text = fillVars(body, c) + UNSUBSCRIBE_FOOTER;
        // dispatch respeta opt_in_* y devuelve null (sin enviar) si no lo aceptó
        const r = await dispatch({ db, channel: ch, kind: "promo", client: c, subject: fillVars(subject, c), body: text, campaignId: camp!.id });
        if (r?.ok) sent++; else if (r) failed++;
      }
    }));
  }

  await db.from("campaigns").update({ status: "sent", sent_count: sent, failed_count: failed }).eq("id", camp!.id);
  revalidatePath("/promociones");
  revalidatePath("/historial");
  back("ok", `Campaña procesada: ${sent} enviados, ${failed} fallidos.${truncated ? ` Se limitó a ${MAX_RECIPIENTS} destinatarios; repite el envío con una etiqueta más específica.` : ""}`);
}
