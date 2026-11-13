-- Estados Financieros: paquete de estados (Situación Financiera, Resultados y Flujo de Efectivo) por mes.
-- Aditiva. Las cifras de cada línea las entrega Contabilidad (a mano o desde su Excel); los totales los calcula el motor.

alter table public.fin_reports add column if not exists package jsonb not null default '{}'::jsonb check (jsonb_typeof(package) = 'object');
alter table public.fin_reports add column if not exists custom_lines jsonb not null default '[]'::jsonb check (jsonb_typeof(custom_lines) = 'array');

-- Una fila por (informe, estado, línea, mes). month = 0 es la columna anual cuando se digita a mano (flujo de efectivo).
-- Nada se borra: un valor retirado se guarda como null (la versión anterior queda en fin_versions).
create table if not exists public.fin_statement_values (
  report_id uuid not null references public.fin_reports(id) on delete cascade,
  statement text not null check (statement in ('esf', 'er', 'efe')),
  line_key text not null check (char_length(line_key) between 1 and 60),
  month smallint not null check (month between 0 and 24),
  tenant_id uuid not null references public.direct_tenants(id) on delete cascade,
  amount numeric(18, 2),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (report_id, statement, line_key, month)
);
create index if not exists fin_statement_values_tenant_idx on public.fin_statement_values (tenant_id, report_id);
alter table public.fin_statement_values enable row level security;

-- La importación de estados desde Excel también queda registrada en fin_imports.
alter table public.fin_imports drop constraint if exists fin_imports_kind_check;
alter table public.fin_imports add constraint fin_imports_kind_check check (kind in ('entries', 'assumptions', 'statements'));
