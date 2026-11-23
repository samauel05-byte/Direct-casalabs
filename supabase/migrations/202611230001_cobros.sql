-- Cobros: módulo restringido de Direct (clientes, cobros, recordatorios y promociones por correo/WhatsApp).
-- Solo ve la tarjeta quien tenga access_cobros (Camila y root al crearse; el resto se marca en Usuarios).
-- Las tablas son del módulo y se filtran por tenant_id en el servidor; la RLS queda cerrada al navegador.
alter table public.direct_profiles add column if not exists access_cobros boolean not null default false;
update public.direct_profiles set access_cobros = true
 where id in (select id from auth.users where email in ('camila@direct.local','root@direct.local'));

create table if not exists public.cobros_clients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.direct_tenants(id) on delete cascade,
  name text not null,
  email text,
  phone text,
  company text,
  tags text[] not null default '{}',
  notes text,
  opt_in_email boolean not null default true,
  opt_in_whatsapp boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists cobros_clients_tenant on public.cobros_clients (tenant_id);
create index if not exists cobros_clients_tags_gin on public.cobros_clients using gin (tags);

create table if not exists public.cobros_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.direct_tenants(id) on delete cascade,
  client_id uuid not null references public.cobros_clients(id) on delete cascade,
  concept text not null,
  amount numeric(14,2) not null check (amount > 0),
  currency text not null default 'DOP' check (currency in ('DOP','USD')),
  due_date date not null,
  status text not null default 'pending' check (status in ('pending','paid','overdue','cancelled')),
  payment_link text,
  paid_at timestamptz,
  last_reminder_at timestamptz,
  reminder_count integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists cobros_invoices_status_due on public.cobros_invoices (status, due_date);
create index if not exists cobros_invoices_tenant on public.cobros_invoices (tenant_id);

create table if not exists public.cobros_campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.direct_tenants(id) on delete cascade,
  name text not null,
  channel text not null check (channel in ('email','whatsapp','both')),
  subject text,
  body text not null,
  audience_tag text,
  status text not null default 'draft' check (status in ('draft','sending','sent')),
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.cobros_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.direct_tenants(id) on delete cascade,
  client_id uuid references public.cobros_clients(id) on delete set null,
  invoice_id uuid references public.cobros_invoices(id) on delete set null,
  campaign_id uuid references public.cobros_campaigns(id) on delete set null,
  channel text not null check (channel in ('email','whatsapp')),
  kind text not null check (kind in ('reminder','invoice','promo')),
  recipient text,
  body text,
  status text not null check (status in ('sent','failed')),
  error text,
  created_at timestamptz not null default now()
);
create index if not exists cobros_log_tenant_created on public.cobros_log (tenant_id, created_at desc);

alter table public.cobros_clients enable row level security;
alter table public.cobros_invoices enable row level security;
alter table public.cobros_campaigns enable row level security;
alter table public.cobros_log enable row level security;
