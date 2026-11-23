import { login } from "./actions";

export default function LoginPage({ searchParams }: { searchParams: { error?: string } }) {
  const msg =
    searchParams.error === "credenciales" ? "Correo o contraseña incorrectos."
    : searchParams.error === "conexion" ? "No se pudo conectar con el servidor. Intenta de nuevo en unos minutos."
    : "";
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form action={login} className="card w-full max-w-sm space-y-4">
        <h1 className="text-xl font-semibold">Panel de cobros</h1>
        {msg && <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{msg}</p>}
        <div>
          <label className="label" htmlFor="email">Correo</label>
          <input id="email" name="email" type="email" required autoComplete="username" className="input" />
        </div>
        <div>
          <label className="label" htmlFor="password">Contraseña</label>
          <input id="password" name="password" type="password" required autoComplete="current-password" className="input" />
        </div>
        <button className="btn w-full" type="submit">Entrar</button>
      </form>
    </main>
  );
}
