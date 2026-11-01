#!/usr/bin/env bash
set -euo pipefail
# Runs once on a new volume. No business, auth or queue schemas in stage 0.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 \
  --set runtime_user="$RUNTIME_DB_USER" --set runtime_password="$RUNTIME_DB_PASSWORD" \
  --set database_name="$POSTGRES_DB" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', :'runtime_user', :'runtime_password') \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'database_name', :'runtime_user') \gexec
SQL
