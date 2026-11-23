-- Cobros: enlace de pago generado con PayPal (API de Facturas). PayPal no admite DOP: una factura en RD$ se cobra
-- en US$ con la tasa indicada al generar el enlace (se guarda para auditoría).
alter table public.cobros_invoices add column if not exists paypal_invoice_id text;
alter table public.cobros_invoices add column if not exists paypal_usd_amount numeric(14,2);
alter table public.cobros_invoices add column if not exists paypal_rate numeric(12,4);
