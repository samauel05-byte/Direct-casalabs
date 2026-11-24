-- Cobros: avisos elegidos en un calendario. remind_dates = días exactos en que se avisa; remind_per_day = correos por día (1 a 3,
-- en las 3 corridas del cron: 8:00, 13:00 y 18:00 hora de RD); remind_overdue = seguir avisando cada 3 días si se atrasa.
-- last_reminder_day / reminders_today cuentan los avisos ya enviados hoy. Sin remind_dates se usa remind_days (antiguo).
alter table public.cobros_invoices add column if not exists remind_dates date[];
alter table public.cobros_invoices add column if not exists remind_per_day smallint not null default 1 check (remind_per_day between 1 and 3);
alter table public.cobros_invoices add column if not exists remind_overdue boolean not null default true;
alter table public.cobros_invoices add column if not exists last_reminder_day date;
alter table public.cobros_invoices add column if not exists reminders_today smallint not null default 0;
