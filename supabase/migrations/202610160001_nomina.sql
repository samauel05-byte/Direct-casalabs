-- Módulo Nómina (dentro de Direct/SERP). Núcleo:
--   empresas = clientes de SERP (direct_clients) · columnas dinámicas por empresa
--   (monto/número/texto/fórmula, sin eval) · empleados manuales · períodos de
--   nómina editables con totales/neto · exportación a Excel.
-- Aditiva e idempotente. Todo filtrado por tenant en el servidor (service role);
-- RLS cerrada al navegador como el resto de SERP.
create extension if not exists pgcrypto;

-- Acceso individual al módulo (igual que access_nala / access_ir2).
alter table public.direct_profiles add column if not exists access_nomina boolean not null default false;

-- ── Columnas dinámicas por empresa ────────────────────────────────────────
-- Cada empresa define sus conceptos de nómina. type:
--   monto   → dinero (2 decimales)      numero → cantidad (horas, días…)
--   texto   → nota libre                formula → se calcula con otras columnas
-- 'sign' indica si una columna de dinero suma (+1, ingreso) o resta (-1,
-- deducción) para el neto; las de fórmula definen su propio valor.
create table if not exists public.nomina_columns (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.direct_tenants(id) on delete cascade,
  client_id   uuid not null,
  key         text not null check (key ~ '^[a-z][a-z0-9_]{0,38}$'),
  label       text not null check (char_length(label) between 1 and 60),
  type        text not null check (type in ('monto','numero','texto','formula')),
  formula     text check (char_length(formula) <= 500),
  sign        smallint not null default 1 check (sign in (-1, 0, 1)),
  include_total boolean not null default true,
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, client_id, key),
  foreign key (tenant_id, client_id) references public.direct_clients (tenant_id, id) on delete cascade
);
create index if not exists nomina_columns_client_idx on public.nomina_columns (tenant_id, client_id, position);

-- ── Empleados (manuales) ──────────────────────────────────────────────────
create table if not exists public.nomina_employees (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.direct_tenants(id) on delete cascade,
  client_id   uuid not null,
  full_name   text not null check (char_length(full_name) between 1 and 120),
  identifier  text check (char_length(identifier) <= 20),
  position    text check (char_length(position) <= 80),
  active      boolean not null default true,
  notes       text check (char_length(notes) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, client_id) references public.direct_clients (tenant_id, id) on delete cascade
);
create index if not exists nomina_employees_client_idx on public.nomina_employees (tenant_id, client_id, active);

-- ── Períodos de nómina ────────────────────────────────────────────────────
create table if not exists public.nomina_periods (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.direct_tenants(id) on delete cascade,
  client_id   uuid not null,
  label       text not null check (char_length(label) between 1 and 80),
  year        integer check (year between 2000 and 2100),
  month       integer check (month between 1 and 12),
  status      text not null default 'draft' check (status in ('draft','closed')),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, client_id) references public.direct_clients (tenant_id, id) on delete cascade
);
create index if not exists nomina_periods_client_idx on public.nomina_periods (tenant_id, client_id, created_at desc);

-- ── Valores por empleado y período ────────────────────────────────────────
-- values: { "<column key>": <valor> }. Las columnas de fórmula no se guardan
-- aquí: se calculan al vuelo desde las demás.
create table if not exists public.nomina_entries (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.direct_tenants(id) on delete cascade,
  period_id   uuid not null,
  employee_id uuid not null,
  values      jsonb not null default '{}'::jsonb check (jsonb_typeof(values) = 'object'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, period_id, employee_id),
  foreign key (tenant_id, period_id)   references public.nomina_periods   (tenant_id, id) on delete cascade,
  foreign key (tenant_id, employee_id) references public.nomina_employees (tenant_id, id) on delete cascade
);
create index if not exists nomina_entries_period_idx on public.nomina_entries (tenant_id, period_id);

-- ── RLS: cerrada al navegador (sólo el service role del servidor entra) ────
alter table public.nomina_columns   enable row level security;
alter table public.nomina_employees enable row level security;
alter table public.nomina_periods   enable row level security;
alter table public.nomina_entries   enable row level security;
revoke all on public.nomina_columns, public.nomina_employees, public.nomina_periods, public.nomina_entries from anon, authenticated;
do $$
declare t text;
begin
  foreach t in array array['nomina_columns','nomina_employees','nomina_periods','nomina_entries'] loop
    execute format('drop policy if exists deny_jwt on public.%I', t);
    execute format('create policy deny_jwt on public.%I for all to authenticated using (false) with check (false)', t);
  end loop;
end $$;
