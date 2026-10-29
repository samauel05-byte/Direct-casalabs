-- Columnas de Nómina que el código usa y que producción ya tenía, pero que
-- ninguna migración del repositorio creaba (una base nueva fallaba con
-- «column ... does not exist»). Todo es idempotente: en producción no cambia nada.

alter table public.nomina_companies
  add column if not exists auto_nomina boolean not null default true,
  add column if not exists pinned      boolean not null default false;

alter table public.nomina_columns
  add column if not exists carry boolean not null default false;

alter table public.nomina_periods
  add column if not exists cycle            text,
  add column if not exists pay_date         date,
  add column if not exists novedades_locked boolean not null default false;
