$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$path = Join-Path $root '.env'
if (Test-Path $path) { throw 'Local secrets already exist. Preserve them; do not regenerate against existing database volumes.' }
$values = @{}
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  foreach ($name in @('POSTGRES_PASSWORD','DB_HUBS_PASSWORD','DB_CATALOG_PASSWORD','DB_INVENTORY_PASSWORD','DB_ORDERS_PASSWORD','DB_OPERATIONS_PASSWORD','RABBITMQ_PASSWORD','REDIS_PASSWORD','KEYCLOAK_ADMIN_PASSWORD','OIDC_CLIENT_SECRET','SESSION_PASSWORD','LOCAL_STAFF_PASSWORD')) {
    $bytes = New-Object byte[] 32
    $rng.GetBytes($bytes)
    $values[$name] = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
  }
} finally { $rng.Dispose() }
$values['LOCAL_TENANT_ID'] = [Guid]::NewGuid().ToString()
$lines = $values.Keys | Sort-Object | ForEach-Object { "$_=$($values[$_])" }
Set-Content -Path $path -Value $lines -Encoding ascii
$web = @(
  'APP_URL=http://localhost:3000',
  'ALLOW_LOCAL_HTTP=true',
  'OIDC_ISSUER=http://localhost:8080/realms/drivecore',
  'OIDC_CLIENT_ID=drivecore-web',
  "OIDC_CLIENT_SECRET=$($values['OIDC_CLIENT_SECRET'])",
  "SESSION_PASSWORD=$($values['SESSION_PASSWORD'])",
  "REDIS_URL=redis://:$($values['REDIS_PASSWORD'])@localhost:6380",
  'GATEWAY_URL=http://localhost:8090'
)
Set-Content -Path (Join-Path $root 'web\.env.local') -Value $web -Encoding ascii
Write-Output 'Generated ignored local configuration. Keep .env and web\.env.local private. No secrets printed.'
