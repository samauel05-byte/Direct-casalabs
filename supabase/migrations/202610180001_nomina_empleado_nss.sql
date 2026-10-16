-- NSS (número de seguridad social) del empleado, para el recibo de nómina en
-- formato de declaración TSS. Opcional; longitud máxima 20.
alter table public.nomina_employees
  add column if not exists nss text
  check (nss is null or char_length(nss) <= 20);
