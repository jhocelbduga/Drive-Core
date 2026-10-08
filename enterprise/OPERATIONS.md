# Runtime, deployment and acceptance runbook

## Azure production baseline (not provisioned)

Use Azure Front Door/WAF, an AKS cluster with at least three worker nodes spread across zones, Azure Container Registry, externally provisioned OIDC, Azure Database for PostgreSQL flexible servers/HA, managed Redis-compatible cache, a supported managed RabbitMQ cluster, Key Vault-backed external secrets and Azure Monitor/managed Prometheus/Grafana. Prefer private endpoints for stateful services.

The chosen transport is RabbitMQ. Kafka and Azure Service Bus are **alternative adapters**, not simultaneously deployed or interchangeable without changes. The implemented storage is PostgreSQL; SQL Server/MongoDB adapters are not included.

No Azure subscription, paid resource or public backend was created. GitHub Pages cannot host this BFF, JWT APIs, databases or broker. The existing Pages demo remains the only deployed public site from prior work.

## Container images

From the enterprise directory:

```powershell
foreach ($service in @('Hubs','Catalog','Inventory','Orders','Operations','Gateway')) {
  docker build --build-arg "SERVICE=$service" -t "YOUR_REGISTRY/drivecore-$($service.ToLowerInvariant()):RELEASE_SHA" .
  if ($LASTEXITCODE -ne 0) { throw 'Image build failed.' }
}
docker build -t YOUR_REGISTRY/drivecore-web:RELEASE_SHA .\web
```

Pin and scan base-image digests and application dependency releases before promotion. Current Dockerfiles use maintainable major-version base tags and have not been container-built here. Separate build artifacts per service prevent shipping SDKs/source or local secrets.

## Kubernetes rendering and rollout

```powershell
.\infra\Render-Kubernetes.ps1 `
  -Registry YOUR_REGISTRY `
  -ImageTag RELEASE_SHA `
  -AppHost operations.example.com `
  -OidcAuthority https://identity.example.com/realms/drivecore `
  -OidcClientId drivecore-web `
  -OtlpEndpoint http://collector.monitoring:4317
```

The renderer generates a `v1/List` in ignored `.local\kubernetes.json`. It creates **no resources**. Its baseline includes deployments/services, startup/liveness/readiness probes, bounded resources, non-root/read-only containers, HPA, PodDisruptionBudgets, zone/host spreading, migration jobs, TLS ingress and default-deny NetworkPolicies.

Supply these namespace `drivecore` Secrets externally; the renderer never embeds values:

| Secret | Required keys |
|---|---|
| `drivecore-hubs`, `drivecore-catalog`, `drivecore-inventory`, `drivecore-orders`, `drivecore-operations` | `database-connection`, `broker-uri` |
| `drivecore-web` | `oidc-client-secret`, `session-password`, `redis-url` |
| `drivecore-tls` | ingress TLS certificate/private key |

Production connections must use validated TLS: PostgreSQL `SSL Mode=VerifyFull` with trusted root, RabbitMQ `amqps`, Redis `rediss` and HTTPS OIDC. Use per-domain broker credentials/ACLs. Provision OIDC redirect URI `https://operations.example.com/auth/callback`, audience and administrator-controlled claims. Do not use local test admin credentials or `ALLOW_LOCAL_HTTP` in production. Configure provider MFA/federation/enrollment separately.

Review registry pull access, private DNS, provider/cache ports, external secret delivery and cluster ingress class. AKS workload identity/Key Vault CSI or External Secrets must populate the named secret contracts; installation is not included. The baseline permits egress on 443/5432/5671/6380 and OTLP to the `monitoring` namespace; tighten external destinations to private endpoint CIDRs/namespaces for your network. Metrics are not publicly ingressed. Internal domain HTTP assumes a trusted isolated namespace; use a service mesh/mTLS where required.

**Do not apply the whole list blindly.** First apply the Namespace and network/security resources, then supply external secrets. Run the five migration Jobs and wait for successful completion, then apply Deployments, Services, HPA/PDB and Ingress. This ordering is manual; there is no GitOps sync-wave controller here. Migration labels deliberately do not match traffic Service selectors. Production startup does not run migrations.

Example of extracting a phase, after review:

```powershell
$manifest = Get-Content .\.local\kubernetes.json -Raw | ConvertFrom-Json
$namespace = $manifest.items | Where-Object { $_.kind -eq 'Namespace' }
$namespace | ConvertTo-Json -Depth 40 | kubectl apply -f -
# Provision external secrets before the following phase.
$jobs = @($manifest.items | Where-Object { $_.kind -eq 'Job' })
@{apiVersion='v1';kind='List';items=$jobs} | ConvertTo-Json -Depth 40 | kubectl apply -f -
foreach ($job in $jobs) {
  kubectl wait --namespace drivecore --for=condition=complete "job/$($job.metadata.name)" --timeout=300s
  if ($LASTEXITCODE -ne 0) { throw 'Migration failed. Do not roll out application pods.' }
}
```

Apply reviewed remaining resources and use `kubectl rollout status` per Deployment. Validate readiness, signed tenant/hub boundaries, event lag and actual stock/order reconciliation before sending traffic. Rolling back images is not a schema rollback; migrations currently only create additive baseline tables. Adopt numbered expand/contract migrations before evolving populated schemas.

## Health and observability

- .NET `/health/live`: process liveness.
- .NET `/health/ready`: database/broker connection status; Gateway additionally checks the five domains.
- Web `/health`: web liveness. `/health/ready`: session cache, identity discovery and Gateway readiness.
- `/metrics`: anonymous service endpoint intended for private monitoring only.
- Counters include `drivecore.outbox.sent` and `drivecore.inbox.failures`. The UI's backlog counts apply only to Operations, not the entire fleet.

Configure alerts for failed inbox rows, poison queue growth, undelivered outbox age, projection freshness, reservation sweep errors, reconciliation-required orders, HTTP errors/p95 latency, DB pool contention and broker depth. The template is not a complete Grafana dashboard/alerting installation.

Run production RabbitMQ across at least three supported nodes with quorum queues and tested recovery. Configure an operator policy for at-least-once dead lettering (`dead-letter-strategy=at-least-once`, `overflow=reject-publish`) before relying on loss-resistant poison routing. Without that policy, RabbitMQ's default dead-letter transfer semantics can lose a rejected message if its target is unavailable. The single-node local stack is not HA.

## Failed messages and recovery

1. Stop/limit affected writes if stock consistency is at risk; capture tenant/event/order IDs and trace references, not customer payload dumps.
2. Inspect the owning service database's `inbox` where `processed IS NULL AND attempts >= 10`, its `error` type, and domain versions. Fix the underlying handler/data/contract cause first.
3. Under an authorized, audited maintenance change, replay **one known event** by setting `attempts=0`, `next_attempt=now()`, `error=NULL`, filtered by ID and tenant JSON claim. Do not clear whole inboxes or change already processed rows.
4. For malformed/unsupported broker envelopes, inspect `<service>.poison` through a restricted broker admin account. Correct/version-migrate an envelope before controlled republish. Do not loop raw poison messages back onto the live queue.
5. If an outbox stops advancing, inspect broker connectivity, routing and publisher-confirm errors. Do not mark undelivered rows successful manually; they may represent unpaid stock/order transitions.
6. Compare `orders`, Inventory reservations, stock ledger and external payment references. A failed settlement is not an authorization to double-charge or regenerate a new order.
7. Reconciliation-required orders need an external refund/reconciliation and an audited closeout process. **Closeout UI/API is not in this slice**; do not rewrite `Completed` into the database to make dashboards green.

Broker/inbox payloads can contain identity-linked business data. Restrict access, encrypt backups and adopt retention/redaction policy before production. Audit/dead-letter replay tooling and fleet-wide event monitoring remain roadmap items.

## Session operations

Redis holds encrypted token records with an eight-hour absolute deadline; the cookie holds only a random session ID and temporary encrypted sign-in state/PKCE/nonce. Refresh locks prevent concurrent rotation; atomic `SET XX` prevents a refresh from resurrecting a signed-out session. An invalid provider refresh invalidates the local session.

Local sign-out deletes the application's Redis session, not the provider's global SSO session; a subsequent sign-in may use existing SSO. Organization-wide sign-out/revocation is a provider policy/integration extension. Rotate cookie encryption keys with an overlap strategy before production, invalidate sessions on privilege changes, and use a highly available private Redis with backups/transport TLS.

## Measurable acceptance gates

The following have **not been measured here**:

| Gate | Test |
|---|---|
| 100+ hubs | Register >=120 scoped facilities; verify pagination, exact national counts and region/tenant/hub isolation. |
| Million-record visibility | Seed >=1,000,000 stock positions and representative ledger history; measure locator/index plans and national latency. |
| 10,000 concurrent users | Execute the provided k6 workload in isolated staging with 10,000 distinct authorized identities. |
| Read latency | p95 <500ms, p99 <1s, HTTP failure rate <0.1% for specified catalogue/national reads; not all business commands. |
| Inventory correctness | Concurrent mixed reservation/receive/release/commit writes; zero negative/over-reserved balances and exact ledger reconciliation. |
| Event freshness | Agree a workload-specific bound (initial target p95 <5s), then measure backlog/lag under burst/restart/duplicate/reordering. The current polling/serialization baseline may require scaling changes. |
| Availability | 99.9% monthly successful-request SLI plus multi-zone failure drills; Kubernetes replicas alone do not establish the SLO. |
| Disaster recovery | Restore database/broker/identity/session state to secondary region; verify RPO <=5m and RTO <=60m through a real timed drill. |

`tests/load.js` ramps to 10,000 VUs for 20 minutes, with 4-6 second user think time. It is **not** a claim of 10,000 simultaneous in-flight requests. It expects `BASE_URL` and `TOKEN_FILE`, a private JSON array of 10,000 distinct test-user bearer tokens. Users need authorized catalogue/national scope and tokens valid for the entire run, or a separate controlled refresh harness. Never use production customer tokens or commit this file. Ensure hub/stock datasets are populated before running.

```powershell
$env:BASE_URL='https://STAGING_GATEWAY'
$env:TOKEN_FILE='C:\PRIVATE_TEST_DATA\load-tokens.json'
k6 run .\tests\load.js
```

The workload is read-only. Payment/stock transaction load, browser SSO/session throughput, offline POS and recovery drills require additional scenario harnesses. Record exact environment, dataset, achieved request rate, error classifications and invariant checks; do not report a passing proxy metric as fulfillment of all capacity requirements.
