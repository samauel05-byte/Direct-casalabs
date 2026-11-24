-- Quien opera Cobros vive dentro de la firma que Cobros puede suspender por falta de pago (Save). Esta marca deja entrar a una persona
-- aunque la licencia de su firma esté suspendida o vencida (igual que el administrador de la plataforma). Por defecto nadie la tiene;
-- se concede a Camila (opera Cobros). Para quitarla: update direct_profiles set keeps_access_when_suspended = false where id = '...';
alter table public.direct_profiles add column if not exists keeps_access_when_suspended boolean not null default false;
update public.direct_profiles set keeps_access_when_suspended = true
 where id in (select id from auth.users where email = 'camila@direct.local');
