$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$values = @{}
Get-Content (Join-Path $root '.env') | ForEach-Object {
  if ($_ -match '^([A-Z_]+)=(.*)$') { $values[$Matches[1]] = $Matches[2] }
}
if (-not $values['POSTGRES_PASSWORD'] -or -not $values['RABBITMQ_PASSWORD']) { throw 'Initialize the local stack first.' }
$vhost = 'drivecore-tests-' + [Guid]::NewGuid().ToString('N')
$authorization = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("drivecore:$($values['RABBITMQ_PASSWORD'])"))
$headers = @{ Authorization="Basic $authorization" }
Invoke-RestMethod -Method Put -Uri "http://localhost:15673/api/vhosts/$vhost" -Headers $headers -ContentType 'application/json' -Body '{}' | Out-Null
$entered = $false
try {
  Invoke-RestMethod -Method Put -Uri "http://localhost:15673/api/permissions/$vhost/drivecore" -Headers $headers `
    -ContentType 'application/json' -Body '{"configure":".*","write":".*","read":".*"}' | Out-Null
  $env:DRIVECORE_TEST_DATABASE = "Host=localhost;Port=5433;Database=drivecore_tests;Username=postgres;Password=$($values['POSTGRES_PASSWORD'])"
  $env:DRIVECORE_TEST_BROKER = "amqp://drivecore:$($values['RABBITMQ_PASSWORD'])@localhost:5673/$vhost"
  Push-Location $root
  $entered = $true
  dotnet test tests\Integration.Tests\Integration.Tests.csproj --configuration Release
  if ($LASTEXITCODE -ne 0) { throw 'Integration tests failed.' }
} finally {
  if ($entered) { Pop-Location }
  Remove-Item Env:\DRIVECORE_TEST_DATABASE -ErrorAction SilentlyContinue
  Remove-Item Env:\DRIVECORE_TEST_BROKER -ErrorAction SilentlyContinue
  Invoke-RestMethod -Method Delete -Uri "http://localhost:15673/api/vhosts/$vhost" -Headers $headers | Out-Null
}
