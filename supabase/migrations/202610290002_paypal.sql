-- Cobro con PayPal (suscripción mensual): la licencia nace al confirmarse la
-- suscripción y cada cobro mensual renueva la vigencia de la firma.

alter table public.direct_licenses
  add column if not exists source text not null default 'manual',
  add column if not exists paypal_subscription_id text,
  add column if not exists paypal_status text,
  add column if not exists paid_until timestamptz;
create unique index if not exists direct_licenses_paypal_sub_uidx on public.direct_licenses (paypal_subscription_id) where paypal_subscription_id is not null;

do $$ begin
  alter table public.direct_licenses add constraint direct_licenses_source_chk check (source in ('manual','paypal'));
exception when duplicate_object then null; end $$;

alter table public.direct_tenants add column if not exists paypal_subscription_id text;

-- Eventos de PayPal ya procesados (los webhooks se reintentan y pueden repetirse).
create table if not exists public.direct_paypal_events (
  event_id    text primary key,
  event_type  text not null,
  received_at timestamptz not null default now()
);
alter table public.direct_paypal_events enable row level security;
do $$ begin
  create policy "deny_jwt" on public.direct_paypal_events for all using (false);
exception when duplicate_object then null; end $$;
