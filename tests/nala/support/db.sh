#!/usr/bin/env bash
# Recreates the local test database with the same migration history as
# production (base schema + supabase/migrations in order) and seeds data that
# must survive the NALA migration untouched.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DB="${NALA_TEST_DB:-nala_test}"
PSQL=(sudo -u postgres psql -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -c "alter user postgres password 'postgres'" >/dev/null
"${PSQL[@]}" -c "drop database if exists ${DB} with (force)" -c "create database ${DB}"
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/nala/support/bootstrap.sql"
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase-migration.sql"
# Las migraciones se aplican en orden. Justo antes de la de NALA se siembran los
# datos que ya existían (deben sobrevivir a esa migración) y ésta se aplica dos
# veces para comprobar que es idempotente.
for f in "$ROOT"/supabase/migrations/*.sql; do
  case "$f" in
    *nala_fiscal_pipeline*)
      "${PSQL[@]}" -d "$DB" -f "$ROOT/tests/nala/support/seed_existing.sql"
      "${PSQL[@]}" -d "$DB" -f "$f"
      "${PSQL[@]}" -d "$DB" -f "$f";;
    *) "${PSQL[@]}" -d "$DB" -f "$f";;
  esac
done
"${PSQL[@]}" -d "$DB" -c "grant all on all tables in schema public to service_role; grant all on all sequences in schema public to service_role; grant execute on all functions in schema public to service_role;"
echo "db ${DB} listo"
