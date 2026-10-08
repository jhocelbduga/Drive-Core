#!/bin/sh
set -eu
if [ "${MIGRATE_ON_START:-false}" = "true" ]; then
  dotnet "${SERVICE}.dll" --migrate
fi
exec dotnet "${SERVICE}.dll"
