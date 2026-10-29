-- Licencias por usuario sin límite: la cantidad de usuarios que paga el cliente
-- (PayPal «quantity») no tiene máximo. Antes direct_licenses.max_users solo admitía de 1 a 500.
do $$ declare c text; begin
  for c in select conname from pg_constraint
    where conrelid = 'public.direct_licenses'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%max_users%'
  loop
    execute format('alter table public.direct_licenses drop constraint %I', c);
  end loop;
end $$;
alter table public.direct_licenses add constraint direct_licenses_max_users_chk check (max_users is null or max_users >= 1);
