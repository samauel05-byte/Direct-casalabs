-- Registro del empleado: fecha de entrada, baja (salida) y soportes/documentos.
-- Aditivo y compatible con lo existente.

alter table public.nomina_employees
  add column if not exists hire_date date,
  add column if not exists exit_date date,
  add column if not exists exit_reason text check (exit_reason is null or char_length(exit_reason) <= 40),
  add column if not exists severance_paid boolean not null default false,
  add column if not exists severance_amount numeric;

-- Archivos subidos por empleado. period_id nulo = expediente general del
-- empleado; con period_id = soporte/recibo firmado de ese período de nómina.
create table if not exists public.nomina_employee_files (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.direct_tenants(id) on delete cascade,
  client_id     uuid not null,
  employee_id   uuid not null,
  period_id     uuid,
  kind          text not null default 'documento' check (char_length(kind) <= 30),
  original_name text not null check (char_length(original_name) between 1 and 200),
  mime_type     text check (mime_type is null or char_length(mime_type) <= 100),
  size_bytes    integer,
  storage_path  text not null check (char_length(storage_path) <= 400),
  created_at    timestamptz not null default now(),
  created_by    uuid,
  foreign key (tenant_id, employee_id) references public.nomina_employees (tenant_id, id) on delete cascade
);
create index if not exists nomina_employee_files_emp_idx
  on public.nomina_employee_files (tenant_id, employee_id, created_at desc);

alter table public.nomina_employee_files enable row level security;
revoke all on public.nomina_employee_files from anon, authenticated;
