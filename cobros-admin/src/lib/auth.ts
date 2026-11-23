import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "./supabase/server";

/** Las Server Actions son endpoints públicos: cada una debe verificar sesión. */
export async function requireUser() {
  const supabase = createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) redirect("/login");
  return supabase;
}
