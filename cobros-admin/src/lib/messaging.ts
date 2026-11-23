import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Channel, Client } from "./types";

export interface SendResult { ok: boolean; error?: string }

/** Correo con Resend (fetch). Nunca lanza: devuelve {ok:false,error}. */
export async function sendEmail(to: string, subject: string, text: string): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!key || !from) return { ok: false, error: "Falta configurar RESEND_API_KEY o RESEND_FROM" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${(await res.text()).slice(0, 300)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Resend: ${e instanceof Error ? e.message : "error de red"}` };
  }
}

/** WhatsApp con Twilio (fetch). Nunca lanza. */
export async function sendWhatsApp(to: string, body: string): Promise<SendResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!sid || !token || !from) return { ok: false, error: "Falta configurar TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN o TWILIO_WHATSAPP_FROM" };
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: from, To: `whatsapp:${to.replace(/^whatsapp:/, "")}`, Body: body }),
    });
    if (!res.ok) return { ok: false, error: `Twilio ${res.status}: ${(await res.text()).slice(0, 300)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Twilio: ${e instanceof Error ? e.message : "error de red"}` };
  }
}

interface DispatchInput {
  db: SupabaseClient;
  channel: Channel;
  kind: "reminder" | "invoice" | "promo";
  client: Pick<Client, "id" | "email" | "phone" | "opt_in_email" | "opt_in_whatsapp">;
  subject: string;
  body: string;
  invoiceId?: string;
  campaignId?: string;
}

/**
 * Envía por un canal respetando opt_in_*, y registra SIEMPRE el resultado en message_log
 * (incluidos los fallos). Devuelve null si el cliente no aceptó o no tiene el dato (no se registra nada).
 */
export async function dispatch(i: DispatchInput): Promise<SendResult | null> {
  const dest = i.channel === "email" ? i.client.email : i.client.phone;
  const optedIn = i.channel === "email" ? i.client.opt_in_email : i.client.opt_in_whatsapp;
  if (!optedIn || !dest) return null;

  const result = i.channel === "email" ? await sendEmail(dest, i.subject, i.body) : await sendWhatsApp(dest, i.body);
  try {
    await i.db.from("message_log").insert({
      client_id: i.client.id,
      invoice_id: i.invoiceId ?? null,
      campaign_id: i.campaignId ?? null,
      channel: i.channel,
      kind: i.kind,
      recipient: dest,
      body: i.channel === "email" ? `${i.subject}\n\n${i.body}` : i.body,
      status: result.ok ? "sent" : "failed",
      error: result.ok ? null : result.error ?? "Error desconocido",
    });
  } catch {
    // el registro nunca debe tumbar el envío
  }
  return result;
}
