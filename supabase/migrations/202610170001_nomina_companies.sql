-- Nómina: empresas propias del módulo (ya NO se reutilizan direct_clients).
-- El usuario crea sus empresas dentro de Nómina y les sube la nómina. Aditiva e
-- idempotente: migra los datos existentes conservando el id de cada empresa.
create extension if not exists pgcrypto;

-- ── Empresas de Nómina ─────────────────────────────────────────────────────
create table if not exists public.nomina_companies (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.direct_tenants(id) on delete cascade,
  legal_name  text not null check (char_length(legal_name) between 1 and 160),
  rnc         text check (char_length(rnc) <= 20),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id)
);
create index if not exists nomina_companies_tenant_idx on public.nomina_companies (tenant_id, legal_name);

-- Semilla: cada direct_client que ya tenga datos de nómina se vuelve empresa
-- propia, conservando su id para que columnas/empleados/períodos sigan válidos.
insert into public.nomina_companies (id, tenant_id, legal_name, rnc)
select distinct dc.id, dc.tenant_id, dc.legal_name, dc.rnc
from public.direct_clients dc
join (
  select tenant_id, client_id from public.nomina_columns
  union select tenant_id, client_id from public.nomina_employees
  union select tenant_id, client_id from public.nomina_periods
) used on used.tenant_id = dc.tenant_id and used.client_id = dc.id
on conflict (id) do nothing;

-- ── Repuntar las FKs de client_id: de direct_clients → nomina_companies ─────
alter table public.nomina_columns   drop constraint if exists nomina_columns_tenant_id_client_id_fkey;
alter table public.nomina_employees drop constraint if exists nomina_employees_tenant_id_client_id_fkey;
alter table public.nomina_periods   drop constraint if exists nomina_periods_tenant_id_client_id_fkey;

alter table public.nomina_columns   drop constraint if exists nomina_columns_company_fk;
alter table public.nomina_employees drop constraint if exists nomina_employees_company_fk;
alter table public.nomina_periods   drop constraint if exists nomina_periods_company_fk;

alter table public.nomina_columns   add constraint nomina_columns_company_fk   foreign key (tenant_id, client_id) references public.nomina_companies (tenant_id, id) on delete cascade;
alter table public.nomina_employees add constraint nomina_employees_company_fk foreign key (tenant_id, client_id) references public.nomina_companies (tenant_id, id) on delete cascade;
alter table public.nomina_periods   add constraint nomina_periods_company_fk   foreign key (tenant_id, client_id) references public.nomina_companies (tenant_id, id) on delete cascade;

-- ── RLS: cerrada al navegador (sólo el service role entra) ──────────────────
alter table public.nomina_companies enable row level security;
revoke all on public.nomina_companies from anon, authenticated;
drop policy if exists deny_jwt on public.nomina_companies;
create policy deny_jwt on public.nomina_companies for all to authenticated using (false) with check (false);
