-- NALA: permitir el tipo de trabajo 'revalidate' (re-evaluar un lote sin re-escanear).
alter table nala_jobs drop constraint if exists nala_jobs_kind_check;
alter table nala_jobs add constraint nala_jobs_kind_check
  check (kind = any (array['prepare'::text, 'extract'::text, 'revalidate'::text]));
