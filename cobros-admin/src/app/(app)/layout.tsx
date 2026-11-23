import Link from "next/link";
import { logout } from "./actions";

const links = [
  ["/", "Resumen"],
  ["/clientes", "Clientes"],
  ["/cobros", "Cobros"],
  ["/promociones", "Promociones"],
  ["/historial", "Historial"],
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="font-semibold">Panel de cobros</span>
          <nav className="flex flex-wrap gap-4 text-sm">
            {links.map(([href, label]) => (
              <Link key={href} href={href} className="text-slate-600 hover:text-indigo-700">{label}</Link>
            ))}
          </nav>
          <form action={logout} className="ml-auto">
            <button className="btn-sec" type="submit">Salir</button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
