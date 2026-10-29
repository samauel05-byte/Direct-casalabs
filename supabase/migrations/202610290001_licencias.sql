-- Licencias: cada firma (tenant) que compra Direct se da de alta sola con un
-- enlace de activación de un solo uso. Esta migración agrega la vigencia de la
-- firma, el super-administrador de la plataforma (root) y la tabla de licencias.
-- Las firmas existentes quedan sin vencimiento (license_until null).

alter table public.direct_tenants
  add column if not exists license_until  timestamptz,
  add column if not exists license_status text not null default 'active',
  add column if not exists license_plan   text,
  add column if not exists max_users      integer,
  add column if not exists billing_email  text;

do $$ begin
  alter table public.direct_tenants add constraint direct_tenants_license_status_chk check (license_status in ('active','suspended'));
exception when duplicate_object then null; end $$;

alter table public.direct_profiles
  add column if not exists is_platform_admin boolean not null default false;

-- El usuario root (firma Save) administra las licencias de toda la plataforma.
update public.direct_profiles p set is_platform_admin = true
from auth.users u where u.id = p.id and u.email = 'root@direct.local';

create table if not exists public.direct_licenses (
  id             uuid primary key default gen_random_uuid(),
  token_hash     text not null unique,
  customer_name  text not null check (char_length(trim(customer_name)) between 2 and 160),
  customer_email text not null check (char_length(customer_email) between 5 and 160),
  plan           text,
  months         integer not null default 1 check (months between 1 and 36),
  max_users      integer check (max_users is null or max_users between 1 and 500),
  status         text not null default 'pending' check (status in ('pending','activated','revoked')),
  link_expires_at timestamptz not null,
  tenant_id      uuid references public.direct_tenants(id) on delete set null,
  note           text,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  activated_at   timestamptz
);
create index if not exists direct_licenses_status_idx on public.direct_licenses (status, created_at desc);

-- Cerrada al navegador: sólo el service role (API) entra.
alter table public.direct_licenses enable row level security;
do $$ begin
  create policy "deny_jwt" on public.direct_licenses for all using (false);
exception when duplicate_object then null; end $$;
