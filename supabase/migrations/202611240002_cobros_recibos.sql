-- Cobros: comprobante de pago automático al cobrar. receipt_sent_at evita enviarlo dos veces; el log admite el tipo 'receipt'.
alter table public.cobros_invoices add column if not exists receipt_sent_at timestamptz;
alter table public.cobros_log drop constraint if exists cobros_log_kind_check;
alter table public.cobros_log add constraint cobros_log_kind_check check (kind in ('reminder','invoice','promo','receipt'));
