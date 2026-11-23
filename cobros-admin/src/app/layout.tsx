import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Panel de cobros", description: "Clientes, cobros y recordatorios" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
