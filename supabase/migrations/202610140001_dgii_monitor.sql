-- Monitor DGII: disponibilidad de los servicios de facturación electrónica (e-CF).
--
-- Comprueba, desde el servidor, la "Obtención de semilla de autenticación" de la
-- DGII (GET de solo lectura, sin certificado y sin generar transacciones) en los
-- tres ambientes oficiales (TesteCF, CerteCF, eCF). Guarda cada resultado, abre
-- y cierra incidentes, resume por día y gestiona alertas por correo.
--
-- Fuente oficial de los endpoints: DGII, "Descripción Técnica de Facturación
-- Electrónica" v1.5 (mayo 2023). Base por ambiente:
--   https://ecf.dgii.gov.do/{testecf|certecf|ecf}/autenticacion
--   Semilla (GET): .../api/autenticacion/semilla
--
-- SEGURIDAD / AISLAMIENTO:
--  - Los resultados y el estado del servicio son GENERALES (compartidos): el
--    estado de la DGII es el mismo para todas las firmas.
--  - Las suscripciones a alertas y el registro de notificaciones son PRIVADOS
--    por firma (tenant). Nunca se guardan claves privadas ni certificados.
--  - Solo el servidor (service role) lee/escribe; se niega todo acceso por JWT.

create extension if not exists pgcrypto;

-- ── Configuración de cada comprobación (servicio + ambiente) ────────────────
create table if not exists public.dgii_monitor_checks (
  id                uuid primary key default gen_random_uuid(),
  service_key       text not null,               -- p. ej. 'ecf_semilla'
  environment       text not null,               -- 'testecf' | 'certecf' | 'ecf'
  name              text not null,
  description       text not null,
  endpoint_key      text not null,               -- clave en la allowlist del servidor (no URL arbitraria)
  method            text not null default 'GET',
  check_type        text not null default 'semilla',
  timeout_ms        int  not null default 10000,
  degraded_ms       int  not null default 3000,  -- umbral de lentitud → degradado
  interval_s        int  not null default 60,
  fail_threshold    int  not null default 3,     -- fallos seguidos para abrir incidente
  recover_threshold int  not null default 2,     -- aciertos seguidos para cerrarlo
  enabled           boolean not null default true,-- false = Pausado
  last_run_claim    timestamptz,                 -- single-flight entre instancias
  started_at        timestamptz not null default now(), -- puesta en marcha
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (service_key, environment)
);

-- ── Resultados individuales (compartidos) ───────────────────────────────────
create table if not exists public.dgii_monitor_results (
  id           bigserial primary key,
  check_id     uuid not null references public.dgii_monitor_checks(id) on delete cascade,
  ts           timestamptz not null default now(),  -- siempre en UTC
  ok           boolean not null,                    -- respuesta válida
  degraded     boolean not null default false,
  status       text not null,                       -- 'ok'|'degraded'|'down'|'invalid'
  http_code    int,
  response_ms  int,
  error_type   text,                                -- 'http'|'invalid'|'dns'|'tls'|'timeout'|'network'
  error_detail text,                                -- saneado y truncado
  source       text not null default 'auto'         -- 'auto'|'manual'
);
create index if not exists dgii_monitor_results_check_ts_idx
  on public.dgii_monitor_results (check_id, ts desc);

-- ── Incidentes (fallos consecutivos agrupados; compartidos) ─────────────────
create table if not exists public.dgii_monitor_incidents (
  id               uuid primary key default gen_random_uuid(),
  check_id         uuid not null references public.dgii_monitor_checks(id) on delete cascade,
  status           text not null default 'open',    -- 'open'|'resolved'
  first_failure_at timestamptz not null,
  confirmed_at     timestamptz not null,
  last_failure_at  timestamptz not null,
  resolved_at      timestamptz,
  fail_count       int not null default 0,
  error_type       text,
  error_detail     text,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists dgii_monitor_incidents_check_idx
  on public.dgii_monitor_incidents (check_id, created_at desc);
-- A lo sumo un incidente abierto por comprobación.
create unique index if not exists dgii_monitor_incidents_one_open
  on public.dgii_monitor_incidents (check_id) where status = 'open';

-- ── Resumen diario por comprobación (día en America/Santo_Domingo) ──────────
create table if not exists public.dgii_monitor_daily (
  check_id        uuid not null references public.dgii_monitor_checks(id) on delete cascade,
  day             date not null,                    -- día local RD
  checks_run      int not null default 0,
  checks_ok       int not null default 0,
  checks_degraded int not null default 0,
  avg_ms          int,
  worst_status    text,
  updated_at      timestamptz not null default now(),
  primary key (check_id, day)
);

-- ── Suscripciones a alertas (PRIVADAS por firma) ────────────────────────────
create table if not exists public.dgii_monitor_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.direct_tenants(id) on delete cascade,
  email       text not null,
  check_id    uuid references public.dgii_monitor_checks(id) on delete cascade, -- null = todas
  on_incident boolean not null default true,
  on_recovery boolean not null default true,
  on_stale    boolean not null default true,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index if not exists dgii_monitor_subs_unique
  on public.dgii_monitor_subscriptions (tenant_id, email, coalesce(check_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists dgii_monitor_subs_tenant_idx
  on public.dgii_monitor_subscriptions (tenant_id);

-- ── Registro de notificaciones (PRIVADO; evita duplicados) ──────────────────
create table if not exists public.dgii_monitor_notifications (
  id          bigserial primary key,
  tenant_id   uuid,
  email       text not null,
  incident_id uuid references public.dgii_monitor_incidents(id) on delete cascade,
  kind        text not null,                        -- 'incident'|'recovery'|'stale'
  status      text not null default 'pending',      -- 'pending'|'sent'|'failed'
  attempts    int not null default 0,
  error       text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);
-- Un solo aviso por cambio de estado y destinatario.
create unique index if not exists dgii_monitor_notif_dedup
  on public.dgii_monitor_notifications (incident_id, email, kind);
create index if not exists dgii_monitor_notif_status_idx
  on public.dgii_monitor_notifications (status, created_at);

-- ── Estado del propio proceso (heartbeat + reloj del scheduler) ─────────────
create table if not exists public.dgii_monitor_runner (
  id           int primary key default 1,
  last_cron_at timestamptz,
  last_run_at  timestamptz,
  updated_at   timestamptz not null default now()
);
insert into public.dgii_monitor_runner (id) values (1) on conflict (id) do nothing;

-- ── Ajustes globales del monitor (clave/valor) ──────────────────────────────
create table if not exists public.dgii_monitor_settings (
  key   text primary key,
  value jsonb not null
);
insert into public.dgii_monitor_settings (key, value) values
  ('retention_days', '14'::jsonb),
  ('manual_min_interval_s', '30'::jsonb),
  ('stale_after_s', '180'::jsonb)
on conflict (key) do nothing;

-- ── Comprobaciones por defecto: semilla de autenticación en los 3 ambientes ──
insert into public.dgii_monitor_checks (service_key, environment, name, description, endpoint_key)
values
  ('ecf_semilla', 'testecf',
   'Obtención de semilla de autenticación — Pruebas (TesteCF)',
   'Solicita la semilla de autenticación e-CF (GET de solo lectura, sin certificado). Comprueba solo este paso; no envía comprobantes ni valida el certificado.',
   'testecf'),
  ('ecf_semilla', 'certecf',
   'Obtención de semilla de autenticación — Certificación (CerteCF)',
   'Solicita la semilla de autenticación e-CF (GET de solo lectura, sin certificado). Comprueba solo este paso; no envía comprobantes ni valida el certificado.',
   'certecf'),
  ('ecf_semilla', 'ecf',
   'Obtención de semilla de autenticación — Producción (eCF)',
   'Solicita la semilla de autenticación e-CF (GET de solo lectura, sin certificado). Comprueba solo este paso; no envía comprobantes ni valida el certificado.',
   'ecf')
on conflict (service_key, environment) do nothing;

-- ── Retención configurable: borra resultados crudos antiguos ────────────────
create or replace function public.dgii_monitor_prune(p_days int)
returns bigint language plpgsql as $$
declare n bigint;
begin
  delete from public.dgii_monitor_results
   where ts < now() - make_interval(days => greatest(p_days, 1));
  get diagnostics n = row_count;
  return n;
end $$;

-- ── RLS: solo service role; se niega todo acceso por JWT ────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'dgii_monitor_checks','dgii_monitor_results','dgii_monitor_incidents',
    'dgii_monitor_daily','dgii_monitor_subscriptions','dgii_monitor_notifications',
    'dgii_monitor_runner','dgii_monitor_settings'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "deny_jwt" on public.%I', t);
    execute format('create policy "deny_jwt" on public.%I for all using (false)', t);
  end loop;
end $$;
