"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { parseTags } from "@/lib/format";

const str = (f: FormData, k: string) => String(f.get(k) || "").trim();

export async function createClientAction(formData: FormData) {
  const db = await requireUser();
  const name = str(formData, "name");
  if (!name) redirect("/clientes?error=" + encodeURIComponent("El nombre es obligatorio."));
  const phone = str(formData, "phone").replace(/[\s()-]/g, "");
  if (phone && !/^\+\d{8,15}$/.test(phone)) redirect("/clientes?error=" + encodeURIComponent("El teléfono debe tener formato internacional, ej. +18095551234."));
  const email = str(formData, "email").toLowerCase();
  const { error } = await db.from("clients").insert({
    name,
    email: email || null,
    phone: phone || null,
    company: str(formData, "company") || null,
    tags: parseTags(str(formData, "tags")),
    notes: str(formData, "notes") || null,
    opt_in_email: formData.get("opt_in_email") === "on",
    opt_in_whatsapp: formData.get("opt_in_whatsapp") === "on",
  });
  if (error) redirect("/clientes?error=" + encodeURIComponent("No se pudo guardar: " + error.message));
  revalidatePath("/clientes");
  redirect("/clientes?ok=" + encodeURIComponent("Cliente guardado."));
}

export async function deleteClientAction(formData: FormData) {
  const db = await requireUser();
  const { error } = await db.from("clients").delete().eq("id", str(formData, "id"));
  if (error) redirect("/clientes?error=" + encodeURIComponent("No se pudo eliminar: " + error.message));
  revalidatePath("/clientes");
  redirect("/clientes?ok=" + encodeURIComponent("Cliente eliminado."));
}

/** Baja manual de un canal (cuando el cliente responde BAJA). */
export async function optOutAction(formData: FormData) {
  const db = await requireUser();
  const channel = str(formData, "channel");
  const col = channel === "whatsapp" ? "opt_in_whatsapp" : "opt_in_email";
  const { error } = await db.from("clients").update({ [col]: false }).eq("id", str(formData, "id"));
  if (error) redirect("/clientes?error=" + encodeURIComponent("No se pudo actualizar: " + error.message));
  revalidatePath("/clientes");
  redirect("/clientes?ok=" + encodeURIComponent("Baja registrada."));
}
