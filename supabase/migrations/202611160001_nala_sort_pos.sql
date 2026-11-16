-- NALA: posición manual de una factura dentro de su página (para dejar las listas de NCF en el orden del papel).
alter table public.nala_invoices add column if not exists sort_pos integer;
