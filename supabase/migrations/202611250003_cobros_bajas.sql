-- Cobros: lista de bajas por firma. Un correo en esta lista nunca recibe promociones, venga de un cliente o de una lista pegada.
create table if not exists public.cobros_optouts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.direct_tenants(id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, email)
);
alter table public.cobros_optouts enable row level security;
