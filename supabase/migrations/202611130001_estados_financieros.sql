-- Estados Financieros (Proyectados, Interinos y Del año). Migración aditiva: no modifica ni borra
-- datos existentes. Todo pertenece a un tenant; las empresas son las de direct_clients.
-- Tablas de solo servidor (RLS activada y sin políticas): el navegador nunca las toca directo.

create extension if not exists pgcrypto;
create unique index if not exists direct_clients_tenant_id_id_key on public.direct_clients (tenant_id, id);

-- Acceso al módulo (como access_nala, access_nomina, etc.).
alter table public.direct_profiles add column if not exists access_estados boolean not null default false;

-- Configuración del tenant: estados del flujo, regla de cuadre, comparaciones, documentos por modalidad,
-- proceso de legalización. Se guarda como JSON para que Contabilidad lo ajuste sin cambiar el código.
create table if not exists public.fin_config (
  tenant_id uuid primary key references public.direct_tenants(id) on delete cascade,
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.fin_members (
  tenant_id uuid not null references public.direct_tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  fin_role text not null default 'lectura' check (fin_role in ('lectura', 'preparador', 'revisor', 'aprobador', 'contador')),
  all_clients boolean not null default true,
  permissions jsonb not null default '{}'::jsonb check (jsonb_typeof(permissions) = 'object'),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create table if not exists public.fin_member_clients (
  tenant_id uuid not null,
  user_id uuid not null,
  client_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id, client_id),
  foreign key (tenant_id, client_id) references public.direct_clients (tenant_id, id) on delete cascade,
  foreign key (tenant_id, user_id) references public.fin_members (tenant_id, user_id) on delete cascade
);

create table if not exists public.fin_reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.direct_tenants(id) on delete cascade,
  client_id uuid not null,
  modality text not null check (modality in ('proyectado', 'interino', 'anual')),
  title text not null check (char_length(btrim(title)) between 1 and 160),
  scenario text check (scenario is null or char_length(btrim(scenario)) between 1 and 120),
  currency text not null default 'DOP' check (currency ~ '^[A-Z]{3}$'),
  prepared_on date not null default current_date,
  period_start date,
  period_end date,
  fiscal_year integer check (fiscal_year is null or fiscal_year between 2000 and 2100),
  fiscal_period text check (fiscal_period is null or char_length(fiscal_period) <= 60),
  status text not null default 'borrador' check (char_length(status) between 1 and 40),
  version integer not null default 1,
  documents jsonb not null default '[]'::jsonb check (jsonb_typeof(documents) = 'array'),
  notes text check (notes is null or char_length(notes) <= 4000),
  prepared_by uuid references auth.users(id) on delete set null,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  closed_by uuid references auth.users(id) on delete set null,
  closed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, client_id) references public.direct_clients (tenant_id, id) on delete restrict,
  check (period_end is null or period_start is null or period_end >= period_start)
);
create index if not exists fin_reports_tenant_idx on public.fin_reports (tenant_id, modality, client_id, updated_at desc);

-- Registros contables reales (interinos y del año). Nada se borra: «active=false» los deja fuera del
-- informe pero conservados (y su importación consta en fin_imports).
create table if not exists public.fin_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.direct_tenants(id) on delete cascade,
  report_id uuid not null references public.fin_reports(id) on delete cascade,
  import_id uuid,
  row_no integer,
  entry_date date not null,
  account_code text not null check (char_length(account_code) between 1 and 60),
  account_name text check (account_name is null or char_length(account_name) <= 200),
  concept text check (concept is null or char_length(concept) <= 500),
  reference text check (reference is null or char_length(reference) <= 80),
  debit numeric(18, 2) not null default 0 check (debit >= 0),
  credit numeric(18, 2) not null default 0 check (credit >= 0),
  opening_balance numeric(18, 2),
  closing_balance numeric(18, 2),
  classification text check (classification is null or char_length(classification) <= 120),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists fin_entries_report_idx on public.fin_entries (report_id, active, account_code);

-- Supuestos y valores estimados (proyectados).
create table if not exists public.fin_assumptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.direct_tenants(id) on delete cascade,
  report_id uuid not null references public.fin_reports(id) on delete cascade,
  import_id uuid,
  row_no integer,
  kind text not null check (kind in ('supuesto', 'valor_estimado')),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  description text check (description is null or char_length(description) <= 1000),
  period text check (period is null or char_length(period) <= 40),
  account_code text check (account_code is null or char_length(account_code) <= 60),
  amount numeric(18, 2),
  value_text text check (value_text is null or char_length(value_text) <= 300),
  unit text check (unit is null or char_length(unit) <= 40),
  source text check (source is null or char_length(source) <= 300),
  pending boolean not null default false,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create index if not exists fin_assumptions_report_idx on public.fin_assumptions (report_id, active);

-- Ajustes y asientos de cierre registrados a mano (interinos y del año).
create table if not exists public.fin_adjustments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.direct_tenants(id) on delete cascade,
  report_id uuid not null references public.fin_reports(id) on delete cascade,
  kind text not null default 'ajuste' check (kind in ('ajuste', 'cierre')),
  adj_date date not null,
  reference text check (reference is null or char_length(reference) <= 80),
  concept text not null check (char_length(btrim(concept)) between 1 and 500),
  account_code text not null check (char_length(account_code) between 1 and 60),
  account_name text check (account_name is null or char_length(account_name) <= 200),
  debit numeric(18, 2) not null default 0 check (debit >= 0),
  credit numeric(18, 2) not null default 0 check (credit >= 0),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists fin_adjustments_report_idx on public.fin_adjustments (report_id, active);

-- Cada archivo cargado (y su huella) queda registrado; las filas apuntan a su importación.
create table if not exists public.fin_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.direct_tenants(id) on delete cascade,
  report_id uuid not null references public.fin_reports(id) on delete cascade,
  kind text not null check (kind in ('entries', 'assumptions')),
  file_name text not null check (char_length(file_name) <= 240),
  file_size integer,
  sha256 text,
  storage_path text,
  sheet text,
  mapping jsonb not null default '{}'::jsonb,
  row_count integer not null default 0,
  status text not null default 'applied' check (status in ('applied', 'reverted')),
  reverted_by uuid references auth.users(id) on delete set null,
  reverted_at timestamptz,
  revert_reason text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists fin_imports_report_idx on public.fin_imports (report_id, created_at desc);

-- Asociaciones de columnas guardadas (por modalidad y por encabezados del archivo).
create table if not exists public.fin_mappings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.direct_tenants(id) on delete cascade,
  modality text not null check (modality in ('proyectado', 'interino', 'anual')),
  headers_sig text not null,
  mapping jsonb not null check (jsonb_typeof(mapping) = 'object'),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (tenant_id, modality, headers_sig)
);

-- Versiones: una instantánea por cada modificación del informe (no se sobrescriben).
create table if not exists public.fin_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.direct_tenants(id) on delete cascade,
  report_id uuid not null references public.fin_reports(id) on delete cascade,
  version integer not null,
  change_type text not null,
  note text,
  snapshot jsonb not null default '{}'::jsonb,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now(),
  unique (report_id, version)
);

-- Registro de eventos (importaciones, ediciones, revisiones, aprobaciones, cierres, reaperturas). Solo se agrega.
create table if not exists public.fin_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.direct_tenants(id) on delete cascade,
  report_id uuid references public.fin_reports(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists fin_events_report_idx on public.fin_events (report_id, created_at desc);

alter table public.fin_config enable row level security;
alter table public.fin_members enable row level security;
alter table public.fin_member_clients enable row level security;
alter table public.fin_reports enable row level security;
alter table public.fin_entries enable row level security;
alter table public.fin_assumptions enable row level security;
alter table public.fin_adjustments enable row level security;
alter table public.fin_imports enable row level security;
alter table public.fin_mappings enable row level security;
alter table public.fin_versions enable row level security;
alter table public.fin_events enable row level security;
