"use server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function login(formData: FormData) {
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");
  if (!email || !password) redirect("/login?error=credenciales");

  let kind: "ok" | "credenciales" | "conexion" = "ok";
  try {
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      // 400 con invalid_credentials = datos incorrectos; cualquier otro caso es de conexión/servicio.
      kind = error.status === 400 || /invalid login credentials|invalid_credentials/i.test(error.message) ? "credenciales" : "conexion";
    }
  } catch {
    kind = "conexion";
  }
  if (kind !== "ok") redirect(`/login?error=${kind}`);
  redirect("/");
}
