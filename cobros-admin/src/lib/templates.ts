import type { Client, Invoice } from "./types";
import { dateDO, money } from "./format";

export const businessName = () => process.env.BUSINESS_NAME || "Nuestro negocio";

export function fillVars(text: string, client: Pick<Client, "name" | "company">) {
  return text
    .replace(/\{\{\s*nombre\s*\}\}/gi, client.name)
    .replace(/\{\{\s*empresa\s*\}\}/gi, client.company || "")
    .replace(/\{\{\s*negocio\s*\}\}/gi, businessName());
}

/** Pie de baja para promociones masivas (mecanismo de baja). */
export const UNSUBSCRIBE_FOOTER = "\n\nSi no deseas recibir más promociones, responde BAJA y te quitaremos de la lista.";

export function reminderMessage(inv: Invoice, client: Pick<Client, "name">, daysToDue: number) {
  const when =
    daysToDue > 1 ? `vence en ${daysToDue} días (${dateDO(inv.due_date)})`
    : daysToDue === 1 ? `vence mañana (${dateDO(inv.due_date)})`
    : daysToDue === 0 ? `vence hoy (${dateDO(inv.due_date)})`
    : `venció el ${dateDO(inv.due_date)} y tiene ${Math.abs(daysToDue)} día(s) de atraso`;
  const subject = daysToDue < 0 ? `Pago vencido: ${inv.concept}` : `Recordatorio de pago: ${inv.concept}`;
  const link = inv.payment_link ? `\n\nPuedes pagar aquí: ${inv.payment_link}` : "";
  const body =
    `Hola ${client.name}, te recordamos que el cobro «${inv.concept}» por ${money(inv.amount, inv.currency)} ${when}.${link}` +
    `\n\nGracias,\n${businessName()}`;
  return { subject, body };
}
