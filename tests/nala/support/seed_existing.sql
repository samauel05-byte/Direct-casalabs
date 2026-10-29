-- Datos que existían antes de NALA fiscal (dos empresas operadoras).
insert into auth.users (id, email, encrypted_password) values
  ('00000000-0000-0000-0000-00000000a001', 'admin@direct.local', 'Admin#2026'),
  ('00000000-0000-0000-0000-00000000a002', 'oficial@direct.local', 'Oficial#2026'),
  ('00000000-0000-0000-0000-00000000a003', 'lector@direct.local', 'Lector#2026'),
  ('00000000-0000-0000-0000-00000000a004', 'sinnala@direct.local', 'SinNala#2026'),
  ('00000000-0000-0000-0000-00000000b001', 'otraadmin@direct.local', 'Otra#2026');
insert into public.direct_tenants (id, name, slug) values ('00000000-0000-0000-0000-0000000000e2', 'Contadores del Este', 'contadores-del-este')
  on conflict do nothing;
insert into public.direct_profiles (id, tenant_id, role, access_direct, access_cami, access_nala, access_ir2, access_estimacion, access_clientes) values
  ('00000000-0000-0000-0000-00000000a001', (select id from direct_tenants where slug = 'save'), 'admin', true, true, true, true, true, true),
  ('00000000-0000-0000-0000-00000000a002', (select id from direct_tenants where slug = 'save'), 'user', true, false, true, false, false, true),
  ('00000000-0000-0000-0000-00000000a003', (select id from direct_tenants where slug = 'save'), 'user', true, false, true, false, false, true),
  ('00000000-0000-0000-0000-00000000a004', (select id from direct_tenants where slug = 'save'), 'user', true, false, false, false, false, true),
  ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000e2', 'admin', true, true, true, true, true, true);
insert into public.direct_clients (id, tenant_id, client_key, legal_name, rnc, created_by, source) values
  ('00000000-0000-0000-0000-0000000c0001', (select id from direct_tenants where slug = 'save'), '101010632', 'Cliente Uno SRL', '101010632', '00000000-0000-0000-0000-00000000a001', 'manual'),
  ('00000000-0000-0000-0000-0000000c0002', (select id from direct_tenants where slug = 'save'), '130000001', 'Cliente Dos SA', '130000001', '00000000-0000-0000-0000-00000000a001', 'excel'),
  ('00000000-0000-0000-0000-0000000c0003', (select id from direct_tenants where slug = 'save'), 'sin-rnc-comercial', 'Comercial Sin RNC', null, '00000000-0000-0000-0000-00000000a001', 'manual'),
  ('00000000-0000-0000-0000-0000000c00e1', '00000000-0000-0000-0000-0000000000e2', '101010632', 'Cliente Uno SRL (del Este)', '101010632', '00000000-0000-0000-0000-00000000b001', 'manual');
insert into public.direct_credentials (tenant_id, id, institution, category, iv, ct, updated_at)
  values ((select id from direct_tenants where slug = 'save'), 'cred-1', 'dgii', 'acceso', 'iv', 'ct', 1);
insert into public.direct_config (tenant_id, key, value) values ((select id from direct_tenants where slug = 'save'), 'vaultSalt', 'salt') on conflict do nothing;
