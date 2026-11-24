-- Cobros: planes de cobro recurrente (mensual) con corte automático. Un plan genera cada mes la factura con enlace de PayPal,
-- detecta el pago solo y, si al día/hora límite no se pagó, suspende la firma en Direct y la empresa en Nexo (modo «real»);
-- en modo «simulación» solo registra lo que habría hecho. Suspensión/reactivación en Direct = direct_tenants.license_status.
create table if not exists public.cobros_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.direct_tenants(id) on delete cascade,
  client_id uuid not null references public.cobros_clients(id) on delete cascade,
  name text not null,
  concept text not null,
  amount numeric(14,2) not null check (amount > 0),
  currency text not null default 'USD' check (currency = 'USD'),
  create_day smallint not null default 25 check (create_day between 1 and 28),
  due_day smallint not null default 5 check (due_day between 1 and 28),
  cutoff_time text not null default '11:55' check (cutoff_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  remind_offsets smallint[] not null default '{5,3,1,0}',
  mode text not null default 'simulation' check (mode in ('simulation','live')),
  active boolean not null default true,
  direct_tenant_id uuid references public.direct_tenants(id) on delete set null,
  nexo_org text,
  notify_email text,
  suspended_at timestamptz,
  suspended_direct boolean not null default false,
  suspended_nexo boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists cobros_plans_tenant on public.cobros_plans (tenant_id);

create table if not exists public.cobros_plan_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.direct_tenants(id) on delete cascade,
  plan_id uuid not null references public.cobros_plans(id) on delete cascade,
  period text,
  kind text not null,
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists cobros_plan_events_plan on public.cobros_plan_events (plan_id, created_at desc);

alter table public.cobros_invoices add column if not exists plan_id uuid references public.cobros_plans(id) on delete set null;
alter table public.cobros_invoices add column if not exists period text;
alter table public.cobros_invoices add column if not exists created_notice_at timestamptz;
create unique index if not exists cobros_invoices_plan_period on public.cobros_invoices (plan_id, period) where plan_id is not null;

alter table public.cobros_log drop constraint if exists cobros_log_kind_check;
alter table public.cobros_log add constraint cobros_log_kind_check check (kind in ('reminder','invoice','promo','receipt','quote','factura','plan'));

alter table public.cobros_plans enable row level security;
alter table public.cobros_plan_events enable row level security;
