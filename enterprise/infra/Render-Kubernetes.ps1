param(
  [Parameter(Mandatory=$true)][string]$Registry,
  [Parameter(Mandatory=$true)][string]$ImageTag,
  [Parameter(Mandatory=$true)][string]$AppHost,
  [Parameter(Mandatory=$true)][string]$OidcAuthority,
  [Parameter(Mandatory=$true)][string]$OidcClientId,
  [Parameter(Mandatory=$true)][string]$OtlpEndpoint
)
$ErrorActionPreference = 'Stop'
if ($ImageTag -eq 'latest' -or $ImageTag -notmatch '^[a-zA-Z0-9_.-]+$') { throw 'Use an immutable release tag, not latest.' }
$release = ($ImageTag.ToLowerInvariant() -replace '[^a-z0-9-]', '-').Trim('-')
if (-not $release -or $release.Length -gt 32) { throw 'Use a release tag that normalizes to 1-32 DNS-safe characters.' }
if ($AppHost -notmatch '^[a-z0-9][a-z0-9.-]+$') { throw 'AppHost must be a DNS hostname.' }
if (([Uri]$OidcAuthority).Scheme -ne 'https') { throw 'Production OIDC must use HTTPS.' }
$namespace = 'drivecore'
$items = New-Object 'System.Collections.Generic.List[object]'
function Resource($kind, $name, $spec, $api='v1') {
  $value = @{apiVersion=$api;kind=$kind;metadata=@{name=$name;namespace=$namespace};spec=$spec}
  return $value
}
function Env($name, $value) { return @{name=$name;value=$value} }
function SecretEnv($name, $secret, $key) { return @{name=$name;valueFrom=@{secretKeyRef=@{name=$secret;key=$key}}} }
$items.Add(@{apiVersion='v1';kind='Namespace';metadata=@{name=$namespace;labels=@{'pod-security.kubernetes.io/enforce'='restricted'}}})
$items.Add(@{apiVersion='v1';kind='ServiceAccount';metadata=@{name='drivecore';namespace=$namespace};automountServiceAccountToken=$false})
$domains = @('hubs','catalog','inventory','orders','operations','gateway','web')
foreach ($domain in $domains) {
  $web = $domain -eq 'web'
  $gateway = $domain -eq 'gateway'
  $port = if ($web) {3000} else {8080}
  $labels = @{app="drivecore-$domain";'app.kubernetes.io/part-of'='drivecore'}
  $envs = New-Object 'System.Collections.Generic.List[object]'
  if ($web) {
    $envs.Add((Env 'APP_URL' "https://$AppHost"))
    $envs.Add((Env 'OIDC_ISSUER' $OidcAuthority))
    $envs.Add((Env 'OIDC_CLIENT_ID' $OidcClientId))
    $envs.Add((Env 'GATEWAY_URL' 'http://drivecore-gateway:8080'))
    $envs.Add((SecretEnv 'OIDC_CLIENT_SECRET' 'drivecore-web' 'oidc-client-secret'))
    $envs.Add((SecretEnv 'SESSION_PASSWORD' 'drivecore-web' 'session-password'))
    $envs.Add((SecretEnv 'REDIS_URL' 'drivecore-web' 'redis-url'))
  } else {
    $envs.Add((Env 'ASPNETCORE_ENVIRONMENT' 'Production'))
    $envs.Add((Env 'Identity__Authority' $OidcAuthority))
    $envs.Add((Env 'Identity__Audience' 'drivecore-api'))
    $envs.Add((Env 'OTEL_EXPORTER_OTLP_ENDPOINT' $OtlpEndpoint))
    if (-not $gateway) {
      $envs.Add((SecretEnv 'Database__Connection' "drivecore-$domain" 'database-connection'))
      $envs.Add((SecretEnv 'Messaging__Uri' "drivecore-$domain" 'broker-uri'))
    }
    if ($domain -eq 'orders') { $envs.Add((Env 'Domains__Catalog' 'http://drivecore-catalog:8080')) }
    if ($gateway) {
      foreach ($name in @('Hubs','Catalog','Inventory','Orders','Operations')) { $envs.Add((Env "Gateway__$name" "http://drivecore-$($name.ToLowerInvariant()):8080")) }
    }
  }
  $image = "$Registry/drivecore-${domain}:$ImageTag"
  $container = @{
    name=$domain;image=$image;imagePullPolicy='IfNotPresent';env=@($envs.ToArray());
    ports=@(@{name='http';containerPort=$port});
    resources=@{requests=@{cpu='250m';memory='512Mi'};limits=@{cpu='2';memory='1Gi'}};
    securityContext=@{allowPrivilegeEscalation=$false;readOnlyRootFilesystem=$true;capabilities=@{drop=@('ALL')}};
    startupProbe=@{httpGet=@{path=$(if($web){'/health'}else{'/health/live'});port='http'};periodSeconds=5;failureThreshold=60};
    livenessProbe=@{httpGet=@{path=$(if($web){'/health'}else{'/health/live'});port='http'};periodSeconds=15;failureThreshold=3};
    readinessProbe=@{httpGet=@{path='/health/ready';port='http'};periodSeconds=10;timeoutSeconds=15;failureThreshold=3};
    volumeMounts=@(@{name='tmp';mountPath='/tmp'})
  }
  if ($web) { $container.volumeMounts += @{name='next-cache';mountPath='/app/.next/cache'} }
  $pod = @{
    serviceAccountName='drivecore';automountServiceAccountToken=$false;
    securityContext=@{runAsNonRoot=$true;runAsUser=$(if($web){1000}else{1654});runAsGroup=$(if($web){1000}else{1654});fsGroup=$(if($web){1000}else{1654});seccompProfile=@{type='RuntimeDefault'}};
    containers=@($container);terminationGracePeriodSeconds=45;
    volumes=@(@{name='tmp';emptyDir=@{}});topologySpreadConstraints=@(
      @{maxSkew=1;topologyKey='topology.kubernetes.io/zone';whenUnsatisfiable='ScheduleAnyway';labelSelector=@{matchLabels=$labels}},
      @{maxSkew=1;topologyKey='kubernetes.io/hostname';whenUnsatisfiable='DoNotSchedule';labelSelector=@{matchLabels=$labels}}
    )
  }
  if ($web) { $pod.volumes += @{name='next-cache';emptyDir=@{}} }
  $replicas = if ($web -or $gateway) {3} else {2}
  $items.Add((Resource 'Deployment' "drivecore-$domain" @{
    replicas=$replicas;selector=@{matchLabels=$labels};strategy=@{type='RollingUpdate';rollingUpdate=@{maxUnavailable=0;maxSurge=1}};
    template=@{metadata=@{labels=$labels};spec=$pod}
  } 'apps/v1'))
  $items.Add((Resource 'Service' "drivecore-$domain" @{selector=$labels;ports=@(@{name='http';port=$port;targetPort='http'})}))
  $items.Add((Resource 'HorizontalPodAutoscaler' "drivecore-$domain" @{
    scaleTargetRef=@{apiVersion='apps/v1';kind='Deployment';name="drivecore-$domain"};minReplicas=$replicas;maxReplicas=20;
    metrics=@(@{type='Resource';resource=@{name='cpu';target=@{type='Utilization';averageUtilization=65}}})
  } 'autoscaling/v2'))
  $items.Add((Resource 'PodDisruptionBudget' "drivecore-$domain" @{minAvailable=($replicas-1);selector=@{matchLabels=$labels}} 'policy/v1'))
  if (-not $web -and -not $gateway) {
    $migration = $container.Clone()
    $migration.name='migration';$migration.Remove('ports');$migration.Remove('startupProbe');$migration.Remove('livenessProbe');$migration.Remove('readinessProbe')
    $migration.command=@('dotnet',"$((Get-Culture).TextInfo.ToTitleCase($domain)).dll",'--migrate')
    $jobPod=$pod.Clone();$jobPod.Remove('topologySpreadConstraints');$jobPod.containers=@($migration);$jobPod.restartPolicy='Never'
    $jobLabels=@{app="drivecore-$domain-migration";'app.kubernetes.io/part-of'='drivecore'}
    $items.Add((Resource 'Job' "drivecore-$domain-migrate-$release" @{
      backoffLimit=2;activeDeadlineSeconds=300;ttlSecondsAfterFinished=86400;template=@{metadata=@{labels=$jobLabels};spec=$jobPod}
    } 'batch/v1'))
  }
}
$items.Add((Resource 'NetworkPolicy' 'default-deny' @{podSelector=@{};policyTypes=@('Ingress','Egress')} 'networking.k8s.io/v1'))
$items.Add((Resource 'NetworkPolicy' 'platform-traffic' @{
  podSelector=@{matchLabels=@{'app.kubernetes.io/part-of'='drivecore'}};policyTypes=@('Ingress','Egress');
  ingress=@(
    @{from=@(@{podSelector=@{}})},
    @{from=@(@{namespaceSelector=@{matchLabels=@{'kubernetes.io/metadata.name'='monitoring'}}});ports=@(@{protocol='TCP';port=8080})}
  );
  egress=@(
    @{to=@(@{podSelector=@{}})},
    @{to=@(@{namespaceSelector=@{matchLabels=@{'kubernetes.io/metadata.name'='kube-system'}}});ports=@(@{protocol='UDP';port=53},@{protocol='TCP';port=53})},
    @{ports=@(@{protocol='TCP';port=443},@{protocol='TCP';port=5432},@{protocol='TCP';port=5671},@{protocol='TCP';port=6380})},
    @{to=@(@{namespaceSelector=@{matchLabels=@{'kubernetes.io/metadata.name'='monitoring'}}});ports=@(@{protocol='TCP';port=4317},@{protocol='TCP';port=4318})}
  )
} 'networking.k8s.io/v1'))
$items.Add((Resource 'NetworkPolicy' 'web-ingress' @{
  podSelector=@{matchLabels=@{app='drivecore-web'}};policyTypes=@('Ingress');
  ingress=@(@{from=@(@{namespaceSelector=@{matchLabels=@{'kubernetes.io/metadata.name'='ingress-nginx'}}});ports=@(@{protocol='TCP';port=3000})})
} 'networking.k8s.io/v1'))
$ingress = Resource 'Ingress' 'drivecore' @{
  ingressClassName='nginx';tls=@(@{hosts=@($AppHost);secretName='drivecore-tls'});
  rules=@(@{host=$AppHost;http=@{paths=@(@{path='/';pathType='Prefix';backend=@{service=@{name='drivecore-web';port=@{number=3000}}}})}})
} 'networking.k8s.io/v1'
$ingress.metadata.annotations=@{'nginx.ingress.kubernetes.io/ssl-redirect'='true';'nginx.ingress.kubernetes.io/proxy-body-size'='128k'}
$items.Add($ingress)
$folder = Join-Path (Split-Path $PSScriptRoot -Parent) '.local'
New-Item -ItemType Directory -Path $folder -Force | Out-Null
$output = Join-Path $folder 'kubernetes.json'
@{apiVersion='v1';kind='List';items=@($items.ToArray())} | ConvertTo-Json -Depth 40 | Set-Content -Path $output -Encoding ascii
Write-Output 'Rendered .local\kubernetes.json. Review secret references, networking and migration ordering before applying. No cloud resources were created.'
