#!/bin/bash
set -euo pipefail
for domain in hubs catalog inventory orders operations; do
  variable="DB_${domain^^}_PASSWORD"
  password="${!variable}"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --set=role="drivecore_$domain" --set=password="$password" --set=db="drivecore_$domain" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :'password') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'role') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SQL
done
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE DATABASE drivecore_tests;
REVOKE ALL ON DATABASE drivecore_tests FROM PUBLIC;
SQL
