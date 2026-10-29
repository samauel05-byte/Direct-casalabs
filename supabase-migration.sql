-- Run this in the Supabase SQL editor for your project

-- 0. Firmas (tenants). direct_config e ir2_resumen la referencian, así que
--    existe antes que ellas; supabase/migrations/202609120001_multi_tenant_clients.sql
--    la define igual (create if not exists) y agrega la firma inicial.
CREATE TABLE IF NOT EXISTS direct_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 120),
  slug text NOT NULL UNIQUE CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9-]{2,80}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 1. Profiles table (linked to auth.users)
CREATE TABLE IF NOT EXISTS direct_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'user',
  access_direct BOOLEAN NOT NULL DEFAULT true,
  access_cami BOOLEAN NOT NULL DEFAULT false,
  access_nala BOOLEAN NOT NULL DEFAULT false,
  portals_direct TEXT[] NOT NULL DEFAULT '{dgii,tss,trabajo,sirla}',
  user_key_salt TEXT,
  vault_key_iv TEXT,
  vault_key_ct TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Credentials table (encrypted, global)
CREATE TABLE IF NOT EXISTS direct_credentials (
  id TEXT PRIMARY KEY,
  institution TEXT NOT NULL,
  category TEXT NOT NULL,
  iv TEXT NOT NULL,
  ct TEXT NOT NULL,
  updated_at BIGINT NOT NULL DEFAULT 0
);

-- 3. Config table (aislada por tenant: config de portales y verificador de
--    bóveda por firma; ver supabase/migrations/202610080002_direct_config_tenant.sql)
CREATE TABLE IF NOT EXISTS direct_config (
  tenant_id UUID NOT NULL REFERENCES direct_tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

-- 4. Enable RLS (server uses service role key so these are bypassed server-side)
ALTER TABLE direct_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE direct_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE direct_config ENABLE ROW LEVEL SECURITY;

-- 5. Deny all JWT-based access (server only uses service role)
CREATE POLICY "deny_jwt" ON direct_profiles FOR ALL USING (false);
CREATE POLICY "deny_jwt" ON direct_credentials FOR ALL USING (false);
CREATE POLICY "deny_jwt" ON direct_config FOR ALL USING (false);

-- 6. IR-2 / DGII modules table (tipo distinguishes ir2 from other DGII modules)
-- tenant_id aísla por firma: la clave única incluye tenant_id para que dos
-- firmas puedan usar el mismo RNC sin verse entre sí (ver migración
-- supabase/migrations/202610080001_ir2_resumen_tenant.sql).
CREATE TABLE IF NOT EXISTS ir2_resumen (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES direct_tenants(id) ON DELETE CASCADE,
  rnc         TEXT NOT NULL,
  anio        INTEGER NOT NULL,
  nombre      TEXT NOT NULL DEFAULT '',
  tipo        TEXT NOT NULL DEFAULT 'ir2',
  data        JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, rnc, anio, tipo)
);
CREATE INDEX IF NOT EXISTS ir2_resumen_tenant_idx ON ir2_resumen (tenant_id);
ALTER TABLE ir2_resumen ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny_jwt" ON ir2_resumen FOR ALL USING (false);

-- Migration: add tipo column to existing ir2_resumen table (run if table already exists)
-- ALTER TABLE ir2_resumen ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'ir2';
-- UPDATE ir2_resumen SET tipo = 'ir2' WHERE tipo IS NULL OR tipo = '';
-- ALTER TABLE ir2_resumen DROP CONSTRAINT IF EXISTS ir2_resumen_rnc_anio_key;
-- ALTER TABLE ir2_resumen ADD CONSTRAINT ir2_resumen_rnc_anio_tipo_key UNIQUE (rnc, anio, tipo);
