import type { Currency } from "./types";

export function money(amount: number, currency: Currency | string = "DOP") {
  const cur = currency === "USD" ? "USD" : "DOP";
  return new Intl.NumberFormat("es-DO", { style: "currency", currency: cur }).format(Number(amount) || 0);
}

const TZ = "America/Santo_Domingo";

/** Fecha de hoy (YYYY-MM-DD) en hora de República Dominicana. */
export function todayDO(d: Date = new Date()) {
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

export function dateDO(value: string | null) {
  if (!value) return "—";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + "T12:00:00Z") : new Date(value);
  return new Intl.DateTimeFormat("es-DO", { dateStyle: "medium", timeZone: /^\d{4}-\d{2}-\d{2}$/.test(value) ? "UTC" : TZ }).format(d);
}

export function dateTimeDO(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("es-DO", { dateStyle: "short", timeStyle: "short", timeZone: TZ }).format(new Date(value));
}

/** Días entre dos fechas YYYY-MM-DD (b - a). */
export function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}

export function parseTags(raw: string) {
  return Array.from(new Set(raw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)));
}
