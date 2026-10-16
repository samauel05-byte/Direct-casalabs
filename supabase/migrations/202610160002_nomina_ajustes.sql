-- Nómina · Parte 1 (aditiva): forma de pago del empleado y ajustes por empresa
-- (tasas de ley RD y aportes del empleador, configurables). No toca datos
-- existentes: solo agrega una columna nullable y una tabla nueva.

alter table public.nomina_employees add column if not exists forma_pago text check (forma_pago is null or char_length(forma_pago) <= 30);

-- Ajustes por empresa: una fila por (tenant, empresa). settings jsonb guarda las
-- tasas (empleado, isr, empleador) y el tipo de período. Sin fila = se usan los
-- valores por defecto del servidor (lib/nomina/settings.js).
create table if not exists public.nomina_settings (
  tenant_id  uuid not null references public.direct_tenants(id) on delete cascade,
  client_id  uuid not null,
  settings   jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, client_id),
  foreign key (tenant_id, client_id) references public.direct_clients (tenant_id, id) on delete cascade
);

alter table public.nomina_settings enable row level security;
revoke all on public.nomina_settings from anon, authenticated;
