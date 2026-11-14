-- Intereses moratorios: módulo restringido. Solo ve la tarjeta quien tenga access_mora (Marcela, Camila y root al crearse).
alter table public.direct_profiles add column if not exists access_mora boolean not null default false;
update public.direct_profiles set access_mora = true
 where id in (select id from auth.users where email in ('marcela@direct.local','camila@direct.local','root@direct.local'));
