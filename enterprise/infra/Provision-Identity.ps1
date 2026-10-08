$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$values = @{}
Get-Content (Join-Path $root '.env') | ForEach-Object {
  if ($_ -match '^([A-Z_]+)=(.*)$') { $values[$Matches[1]] = $Matches[2] }
}
foreach ($name in @('KEYCLOAK_ADMIN_PASSWORD','OIDC_CLIENT_SECRET','LOCAL_STAFF_PASSWORD','LOCAL_TENANT_ID')) {
  if (-not $values[$name]) { throw "Configuration $name is required." }
}
$base = 'http://localhost:8080'
$token = Invoke-RestMethod -Method Post -Uri "$base/realms/master/protocol/openid-connect/token" -Body @{
  grant_type='password'; client_id='admin-cli'; username='local-admin'; password=$values['KEYCLOAK_ADMIN_PASSWORD']
}
$headers = @{ Authorization="Bearer $($token.access_token)" }
function Api($method, $path, $body) {
  $arguments = @{ Method=$method; Uri="$base/admin/realms/drivecore/$path"; Headers=$headers; ContentType='application/json' }
  if ($null -ne $body) { $arguments.Body = ConvertTo-Json -InputObject $body -Depth 30 -Compress }
  Invoke-RestMethod @arguments
}
$clients = @(Api 'Get' 'clients?clientId=drivecore-web' $null)
if ($clients.Count -ne 1) { throw 'Expected exactly one imported drivecore-web client.' }
$client = Api 'Get' "clients/$($clients[0].id)" $null
$client | Add-Member -NotePropertyName secret -NotePropertyValue $values['OIDC_CLIENT_SECRET'] -Force
Api 'Put' "clients/$($client.id)" $client | Out-Null
$profile = Api 'Get' 'users/profile' $null
$profile.attributes = @($profile.attributes | Where-Object { $_.name -notin @('tenant_id','hub_ids') }) + @(
  @{name='tenant_id'; displayName='Tenant'; permissions=@{view=@('admin');edit=@('admin')};multivalued=$false},
  @{name='hub_ids'; displayName='Assigned hubs'; permissions=@{view=@('admin');edit=@('admin')};multivalued=$true}
)
Api 'Put' 'users/profile' $profile | Out-Null
$users = @(Api 'Get' 'users?username=drivecore-admin&exact=true' $null)
if ($users.Count -eq 0) {
  Api 'Post' 'users' @{
    username='drivecore-admin'; enabled=$true; email='admin@drivecore.local'; emailVerified=$true;
    firstName='Local';lastName='Administrator';attributes=@{tenant_id=@($values['LOCAL_TENANT_ID'])};
    credentials=@(@{type='password';value=$values['LOCAL_STAFF_PASSWORD'];temporary=$false})
  } | Out-Null
  $users = @(Api 'Get' 'users?username=drivecore-admin&exact=true' $null)
}
if ($users.Count -ne 1) { throw 'Expected exactly one local administrator.' }
$role = Api 'Get' 'roles/Corporate%20Administrator' $null
Api 'Post' "users/$($users[0].id)/role-mappings/realm" @($role) | Out-Null
Write-Output 'Provisioned localhost-only SSO. Username: drivecore-admin. Read LOCAL_STAFF_PASSWORD from the ignored .env file; never paste it into chat.'
