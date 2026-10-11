-- Direct: analítica de uso DENTRO de SERP (por usuario, privacy-safe).
--
-- Registra cómo la gente navega el sistema (abre módulos/portales, cambia de
-- vista, usa el buscador, duración de sesión) para aprender a qué se dedica
-- cada quien y proponer mejoras. Complementa a direct_access_events, que sigue
-- siendo el historial de ENTRADAS a portales y resultados de login.
--
-- PRIVACIDAD (regla dura): NUNCA guarda nombres de empresa, RNC, textos de
-- búsqueda ni nada de lo que pasa DENTRO de los portales del gobierno; eso
-- viaja cifrado en el navegador y el servidor no lo ve. 'target' solo lleva
-- claves opacas (clave de módulo/portal, nombre de vista) y 'meta' solo
-- contadores seguros (p. ej. duración en ms, número de resultados).
create table if not exists public.direct_usage_events (
  id         bigserial primary key,
  tenant_id  uuid not null references public.direct_tenants(id) on delete cascade,
  user_id    uuid,
  username   text,
  kind       text not null,   -- 'module_open' | 'portal_view' | 'view' | 'search' | 'session' | 'feature'
  target     text,            -- clave de módulo/portal/vista/feature (opaca)
  meta       jsonb,           -- contadores seguros (sin datos sensibles)
  created_at timestamptz not null default now()
);

create index if not exists direct_usage_events_tenant_created_idx
  on public.direct_usage_events (tenant_id, created_at desc);
create index if not exists direct_usage_events_tenant_kind_idx
  on public.direct_usage_events (tenant_id, kind, created_at desc);
create index if not exists direct_usage_events_tenant_user_idx
  on public.direct_usage_events (tenant_id, user_id, created_at desc);

-- Solo el servidor (service role) lee/escribe; se niega todo acceso por JWT.
alter table public.direct_usage_events enable row level security;
drop policy if exists "deny_jwt" on public.direct_usage_events;
create policy "deny_jwt" on public.direct_usage_events for all using (false);
