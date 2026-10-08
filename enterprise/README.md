# Drive Core enterprise foundation

This is an **independent production-oriented foundation and merchandise vertical slice**, not a completed implementation of all 18 domains or a certified enterprise deployment. The existing HTML storefront, member demo, owner demo and Node/SQLite Hub Administration remain unchanged.

## Documentation

- [Architecture diagram and description](ARCHITECTURE.md): topology, trust boundaries, data ownership, event flows and roadmap.
- [API reference](API.md): implemented REST/GraphQL contracts, role/scope requirements, versions and error handling.
- [Usage examples](EXAMPLES.md): browser workflows and authenticated merchandise API walkthrough.
- [Operations runbook](OPERATIONS.md): infrastructure, rollout, monitoring, recovery and unverified acceptance gates.

## Implemented scope

- .NET 10 LTS services: Hubs, Catalog, Inventory, Orders, Operations and an authenticated REST/GraphQL Gateway.
- PostgreSQL database/user ownership per domain; JSONB aggregates, optimistic versions, stock constraints, transaction/audit records.
- Tenant and assigned-hub authorization from externally signed OIDC claims.
- Durable RabbitMQ outbox/inbox messaging, duplicate handling, delayed bounded retries, poison queues and explicit settlement reconciliation.
- Supplier receiving, nationwide tenant inventory locator, authoritative merchandise quotes, all-or-nothing reservations, unpaid cancellation, reservation expiry and externally verified settlement recording.
- A Next.js/React/TypeScript console with server-side OIDC authorization-code/PKCE sign-in, encrypted opaque cookies, encrypted Redis token records and distributed refresh locks. Tokens and client secrets are never returned to browser JavaScript.
- Real API-fed facility registry, product master, stock lookup, order lifecycle and national merchandise/inventory dashboard. Region/currency filters, revenue rankings, geographic coordinate view, role-gated commands, dark/light themes and mobile/tablet layouts.
- Container build files, a local Compose stack, OpenTelemetry/Prometheus configuration, a Kubernetes manifest renderer and separate CI validation.

**Not implemented:** payment charging/refunds, taxation/shipping, services/booking/queue/attendance, procurement, complete customer CRM, finance/commissions, report exports, trained AI, offline POS or automatic migration of legacy records. The dashboard explicitly labels its coverage; there are no fabricated analytics.

## Requirements

- .NET SDK 10.0.x (the solution uses `global.json` feature roll-forward).
- Node.js 24+, npm.
- Docker Desktop with Linux containers and Compose for the integration stack.
- PowerShell for the local configuration/provisioning scripts.

## Local stack

From this directory:

```powershell
.\infra\Initialize-Local.ps1
docker compose up -d --build
```

The initializer creates ignored `.env` and `web\.env.local` files with independently generated cryptographic secrets. It refuses to overwrite them. Do not commit, paste into chat or expose these files. Use hex secrets if manually configuring the example: local connection URI interpolation requires URI-safe values.

Wait until `http://localhost:8080/realms/drivecore/.well-known/openid-configuration` responds, then:

```powershell
.\infra\Provision-Identity.ps1
Set-Location web
npm ci
npm run dev
```

Open `http://localhost:3000`. Sign in as `drivecore-admin` using `LOCAL_STAFF_PASSWORD` from your private `.env` file. Provisioning updates the confidential client secret and locks tenant/hub attributes to administrator-only editing. It does not enable customer registration or password-grant access for the web client.

Alternatively, after provisioning, run `docker compose --profile web up -d --build web` and do not run the native web process on port 3000.

Local ports are loopback-only:

| Endpoint | Address |
|---|---|
| Web console | http://localhost:3000 |
| Keycloak/local SSO | http://localhost:8080 |
| Authenticated gateway | http://localhost:8090 |
| RabbitMQ management | http://localhost:15673 |
| Prometheus | http://localhost:9090 |
| PostgreSQL | localhost:5433 |
| Redis | localhost:6380 |

Local HTTP, Keycloak `start-dev`, automatic startup migrations, shared local broker credentials and single-instance dependencies are **development-only**. Do not expose these ports publicly. Production OIDC must use HTTPS; domain services validate `drivecore-api` audience. Keycloak's dynamic backchannel supports container metadata/JWKS access while keeping the browser issuer `localhost`. The optional containerized web app rewrites only server-side OIDC backchannel requests to Keycloak; the public issuer remains unchanged.

PostgreSQL initialization runs only on a fresh volume. Do not regenerate passwords while retaining old volumes. `docker compose down` stops this project without deleting its persistent volumes.

## Working merchandise flow

1. Sign in with a corporate role. Register a hub; retain its returned UUID/version.
2. Create a physical product; retain its UUID. Prices/costs use integer **minor units**, e.g. `150000` means PHP 1,500.00.
3. Allow registry/catalogue events to reach Inventory. Receive a delivery using a unique reference. For a new stock position use version `0`; subsequent commands use the returned current version.
4. Optionally set a hub-specific selling price. Its version is independent of the product version and starts at `0`.
5. Create a merchandise order. The UI supports one line; the API supports 1-50 unique lines. The quote is generated by Catalog, not accepted from the browser.
6. Refresh Orders until `AwaitingSettlement`. Inventory holds all lines or none for up to 15 minutes.
7. A cashier/manager verifies payment in the **external** system, then records the exact amount/currency and reference. No card or wallet is charged here.
8. Wait for inventory commitment. Only `Completed` orders contribute national revenue.
9. Unpaid orders may be cancelled; held stock is released asynchronously. An expired/unavailable commit after an external settlement becomes `SettlementReconciliationRequired`, never falsely completed. Reconcile/refund externally and follow the runbook.

The UI retains the same idempotency key and generated resource ID when retrying an unchanged failed submission. Editing a form starts a new command. Keep keys when retrying API requests with uncertain outcomes. Reuse with a different payload fails with HTTP 409.

## Authorization

All domain endpoints and Gateway REST/GraphQL require a validated JWT. `tenant_id` must be a nonempty GUID, `sub` must exist, `roles` supplies responsibility-based roles, and `hub_ids` lists assigned UUIDs. Users cannot select another tenant from the UI.

- Corporate Administrator/Product Owner: tenant-wide scope and explicit corporate privilege.
- Hub registration: corporate only.
- Product/price commands: Inventory Controller, or Hub Manager for branch price; corporate bypass applies.
- Receiving: Stock Custodian/Inventory Controller/Hub Manager at an assigned hub.
- Order creation/cancellation: Sales Clerk/Hub Manager/Customer. Customers see only their own orders; approved staff roles see assigned hubs.
- Settlement: Cashier/Hub Manager at an assigned hub.
- National analytics: Regional Manager/Hub Manager/Hub Owner plus corporate; noncorporate users see only assigned hubs.
- Locator: signed users can view availability across **their tenant**, as required for nationwide stock lookup. Hub-specific stock commands remain assignment-gated.

This slice requires customers to have an explicitly assigned shopping hub. Arbitrary public hub browsing and customer onboarding are a future domain extension. Regional visibility is supplied through assigned hub claims, not inferred from a role name. Service roles are recognized by identity but do not receive unimplemented workflows.

Catalogue reads and order lines do not reveal supplier unit cost. Role-gated creation can return its submitted cost. Financial valuations are not exposed in this slice.

## Validation

```powershell
dotnet build DriveCore.slnx --configuration Release
dotnet test tests\Domain.Tests\Domain.Tests.csproj --configuration Release
Set-Location web
npm ci
npm test
npm run build
Set-Location ..
.\infra\Test-Integration.ps1
```

The integration command requires running local PostgreSQL/RabbitMQ and the dedicated `drivecore_tests` database. It **fails**, rather than silently skipping, if dependencies are absent. Tests use a generated schema that is removed afterwards; they refuse to target any other database. The runner creates and removes its own generated RabbitMQ vhost so test events cannot pollute the application queues. Broker tests refuse an application/default vhost. They cover durable concurrent idempotency, tenant boundaries, exact no-oversell balances, cancellation-before-create, repeat commits, expired reservations, stale/duplicate projections, scoped pagination and real durable broker delivery.

The separate `enterprise.yml` workflow starts real dependencies for CI tests. On October 8, 2026, [GitHub Actions run 37781218675](https://github.com/jhocelbduga/Drive-Core/actions/runs/37781218675) passed the service/domain builds, web build/tests, all seven real PostgreSQL/RabbitMQ integration tests and all 52 legacy tests.

### Validation performed in this environment

- All .NET projects, including integration-test source, compile with warnings treated as errors.
- 17 domain tests and 5 web policy/model tests passed.
- All 7 dependency-backed integration tests passed on GitHub's Linux runner with real PostgreSQL/RabbitMQ and isolated test data.
- Next.js production build passed.
- Kubernetes renderer and local PowerShell scripts were syntax checked; generated object relationships checked locally.
- Runtime/CI YAML parsed successfully; independent domain database settings checked.
- Four actual web HTTP checks confirmed liveness and 401/404/403 handling for unauthenticated, unmapped and cross-origin requests.
- npm production dependency audit and direct/transitive .NET package audit reported no known vulnerabilities.
- All 52 existing legacy tests passed.
- Six logged-out viewport/theme checks and 30 operational-view viewport/theme checks passed without horizontal overflow. Operational UI tests used temporary browser-only fixtures with 120 facilities; they did not authenticate against OIDC or prove backend capacity. Fixtures were removed after validation.

Docker Desktop is unavailable locally. CI verified the PostgreSQL/RabbitMQ Compose dependencies and real integration tests; **application container builds/full stack startup, full OIDC browser login, Kubernetes server-side admission and Azure deployment remain unverified.** No 10,000-user, million-record, 99.9% availability or disaster-recovery achievement is claimed.

All enterprise source was published to GitHub, and the existing static site was redeployed to [GitHub Pages](https://jhocelbduga.github.io/Drive-Core/). At the user's request, no paid hosting was created and the enterprise runtime itself remains undeployed.

See [architecture](ARCHITECTURE.md) for all 18 bounded contexts, consistency and scaling decisions, and [operations](OPERATIONS.md) for deployment, event recovery and acceptance gates.
