-- Cobros: cotizaciones (COT-0001) con líneas que se convierten en cobro, y factura comercial (FAC-0001, sin NCF) por cobro.
-- Este sistema no maneja ITBIS: los montos son los de las líneas.
create table if not exists public.cobros_quotes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.direct_tenants(id) on delete cascade,
  client_id uuid not null references public.cobros_clients(id) on delete cascade,
  seq integer not null,
  title text not null,
  items jsonb not null default '[]',
  currency text not null default 'DOP' check (currency in ('DOP','USD')),
  total numeric(14,2) not null check (total >= 0),
  valid_until date,
  notes text,
  status text not null default 'draft' check (status in ('draft','sent','accepted','rejected')),
  invoice_id uuid references public.cobros_invoices(id) on delete set null,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, seq)
);
create index if not exists cobros_quotes_tenant on public.cobros_quotes (tenant_id, created_at desc);
alter table public.cobros_quotes enable row level security;

alter table public.cobros_invoices add column if not exists items jsonb;
alter table public.cobros_invoices add column if not exists factura_seq integer;
alter table public.cobros_invoices add column if not exists factura_sent_at timestamptz;
create unique index if not exists cobros_invoices_factura_seq on public.cobros_invoices (tenant_id, factura_seq) where factura_seq is not null;

alter table public.cobros_log drop constraint if exists cobros_log_kind_check;
alter table public.cobros_log add constraint cobros_log_kind_check check (kind in ('reminder','invoice','promo','receipt','quote','factura'));
