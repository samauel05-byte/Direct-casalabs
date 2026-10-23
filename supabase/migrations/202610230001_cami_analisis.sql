-- CAMI · Análisis de ITBIS guardados.
-- Cada análisis es una «foto» del trabajo (606/607, reportes de tarjeta, balance IR-2 y los datos
-- digitados) para poder retomarlo y modificarlo después. Dos clases de fila:
--   borrador = true  → autoguardado: uno por usuario (se sobrescribe), recupera el trabajo al volver.
--   borrador = false → copia guardada a propósito, visible para todo el equipo del tenant.
-- data va comprimido en el navegador (gzip + base64) dentro de {v, gz}; resumen es un extracto chico
-- para la lista. Aditiva e idempotente. Acceso solo desde el servidor (service role): RLS cerrada.
create extension if not exists pgcrypto;

create table if not exists public.cami_analisis (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.direct_tenants(id) on delete cascade,
  nombre      text not null check (char_length(nombre) between 1 and 160),
  rnc         text,
  periodo     text,
  borrador    boolean not null default false,
  data        jsonb not null default '{}'::jsonb,
  resumen     jsonb not null default '{}'::jsonb,
  created_by  uuid,
  updated_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Un solo borrador por usuario y tenant.
create unique index if not exists cami_analisis_borrador_uidx
  on public.cami_analisis (tenant_id, created_by) where borrador;
create index if not exists cami_analisis_tenant_idx
  on public.cami_analisis (tenant_id, borrador, updated_at desc);

alter table public.cami_analisis enable row level security;
