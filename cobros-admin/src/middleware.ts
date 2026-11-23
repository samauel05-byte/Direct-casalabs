import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

// Todas las rutas protegidas excepto el cron (usa su propio Bearer) y los estáticos.
// /login se deja pasar dentro de updateSession.
export const config = {
  matcher: ["/((?!api/cron/|_next/static|_next/image|favicon.ico).*)"],
};
