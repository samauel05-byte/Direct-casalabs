-- Panel de cobros: esquema inicial
create extension if not exists pgcrypto;

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  phone text,                       -- WhatsApp, formato +1809...
  company text,
  tags text[] not null default '{}',
  notes text,
  opt_in_email boolean not null default true,
  opt_in_whatsapp boolean not null default false,
  created_at timestamptz not null default now()
);
create index clients_tags_gin on public.clients using gin (tags);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
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
create index invoices_status_due on public.invoices (status, due_date);
create index invoices_client on public.invoices (client_id);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
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

create table public.message_log (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete set null,
  invoice_id uuid references public.invoices(id) on delete set null,
  campaign_id uuid references public.campaigns(id) on delete set null,
  channel text not null check (channel in ('email','whatsapp')),
  kind text not null check (kind in ('reminder','invoice','promo')),
  recipient text,
  body text,
  status text not null check (status in ('sent','failed')),
  error text,
  created_at timestamptz not null default now()
);
create index message_log_created on public.message_log (created_at desc);

-- RLS: solo usuarios autenticados (el cron usa service role y la omite)
alter table public.clients enable row level security;
alter table public.invoices enable row level security;
alter table public.campaigns enable row level security;
alter table public.message_log enable row level security;

create policy "auth all" on public.clients for all to authenticated using (true) with check (true);
create policy "auth all" on public.invoices for all to authenticated using (true) with check (true);
create policy "auth all" on public.campaigns for all to authenticated using (true) with check (true);
create policy "auth all" on public.message_log for all to authenticated using (true) with check (true);
