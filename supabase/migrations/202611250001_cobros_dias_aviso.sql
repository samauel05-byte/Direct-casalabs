-- Cobros: días de anticipación del aviso, elegidos por cobro (null = por defecto 3 y 1 días antes).
alter table public.cobros_invoices add column if not exists remind_days integer[];
