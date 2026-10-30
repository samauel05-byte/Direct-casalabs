-- Nómina · Ajustes por empresa: la FK apuntaba a direct_clients, pero las empresas de Nómina viven en
-- nomina_companies (migración 202610170001). Guardar Ajustes (tipo de período, tasas) fallaba con
-- «El registro está relacionado con otros datos y no puede modificarse así» (violación de FK 23503).
-- Se reapunta la FK a nomina_companies; limpia primero cualquier fila huérfana (la tabla estaba vacía).
delete from public.nomina_settings s
 where not exists (select 1 from public.nomina_companies c where c.tenant_id = s.tenant_id and c.id = s.client_id);

alter table public.nomina_settings drop constraint if exists nomina_settings_tenant_id_client_id_fkey;
alter table public.nomina_settings drop constraint if exists nomina_settings_company_fk;
alter table public.nomina_settings
  add constraint nomina_settings_company_fk
  foreign key (tenant_id, client_id) references public.nomina_companies (tenant_id, id) on delete cascade;
