# Drive Core enterprise API reference

This reference documents the implemented .NET merchandise vertical slice and Next.js BFF. It does **not** describe the legacy Node/SQLite Hub Administration API or claim that planned domains already have endpoints.

## Base URLs and authentication

| Surface | Local address | Access |
|---|---|---|
| Browser BFF | `http://localhost:3000/api` | Existing HTTP-only application session cookie; no browser bearer token |
| .NET Gateway REST | `http://localhost:8090/api` | `Authorization: Bearer <OIDC access token>` |
| Gateway GraphQL | `http://localhost:8090/graphql` | Bearer token; not proxied by the browser BFF |
| Domain APIs | Container-private port 8080 | Bearer token; route paths omit Gateway's `/api` prefix |

There is no hosted enterprise API at the GitHub Pages URL.

OIDC access tokens must validate against configured issuer/audience (`drivecore-api`). Required claims: nonempty GUID `tenant_id`, nonblank `sub`, responsibility-based `roles`, and valid UUID `hub_ids` where assigned scope is needed. Tenant selection is not a request-body/query option.

Corporate Administrator and Product Owner have tenant-wide corporate privilege and bypass named-role/assigned-hub checks. Other users need both the named role and relevant hub assignment where indicated. Customers need an assigned shopping hub to create orders in this slice.

### Browser authentication routes

| Method | Route | Behavior |
|---|---|---|
| GET | `/auth/login` | Establish temporary state/nonce/PKCE flow and redirect to OIDC sign-in |
| GET | `/auth/callback` | Verify callback, establish server-held tokens/session and redirect home |
| POST | `/auth/logout` | Require exact application Origin, delete local Redis session and redirect home |

Logout ends the application session, not the provider's global SSO session. These are web routes, not Gateway endpoints.

## Common conventions

- JSON property names are camelCase; IDs are nonempty UUIDs and dates are ISO-8601 UTC timestamps.
- Money is integer minor units: `150000` means PHP 1,500.00. Supported currencies are `PHP` and `GBP`; an order cannot mix currencies.
- Text fields normally require 1-200 characters; SKU is limited to 60.
- Every state-changing REST request requires a nonempty UUID `Idempotency-Key`. Preserve it and the exact payload when retrying an uncertain result. A replay returns the stored original response; use GET for current state.
- Idempotency is scoped by service database, tenant, subject and key. Use a **distinct key for every logical command**, even across different routes.
- Commands with `version` require the current version of the resource being updated. A first stock position/branch-price record uses `0`. Hub, product, price, stock and order versions are independent.
- Successful REST reads and commands currently return **HTTP 200**, including creates; there is no `201 Location` contract.
- `Stored<T>` has `{ "id": "...", "data": { ... }, "version": 1 }`. Lists return JSON arrays of these records, not `{ items, total }`.
- Stock responses and national snapshots are direct objects/arrays, not `Stored<T>`.
- Request bodies are limited to 65,536 bytes. Browser mutations additionally require exact same Origin and `Content-Type: application/json`.
- Gateway uses an in-process per-tenant/subject token bucket: capacity 60, refill 30/second, no queued requests. It is not a distributed fleet quota.

## REST route summary

Paths below include Gateway/BFF `/api`. Corporate override applies to every named-role restriction.

| Method | Path | Permission/scope | Successful result |
|---|---|---|---|
| GET | `/api/me` | Signed actor | `{ tenant, subject, roles, hubs }` |
| GET | `/api/hubs?offset=0` | Corporate: tenant; others: assigned hubs | `Stored<Hub>[]`, up to 200 |
| GET | `/api/hubs/{hubId}` | Assigned hub | `Stored<Hub>` |
| POST | `/api/hubs` | Corporate | `Stored<Hub>` |
| PUT | `/api/hubs/{hubId}/status` | Hub Manager / Regional Manager + hub | `Stored<Hub>` |
| GET | `/api/products?offset=0` | Signed actor, tenant-wide | `Stored<ProductView>[]`, up to 100 |
| POST | `/api/products` | Inventory Controller | `Stored<Product>` |
| PUT | `/api/products/{productId}/price` | Inventory Controller / Hub Manager + hub | `Stored<BranchPrice>` |
| GET | `/api/stock/{hubId}` | Assigned hub | `StockPosition[]`, up to 200 |
| POST | `/api/stock/{hubId}/receive` | Stock Custodian / Inventory Controller / Hub Manager + hub | `StockPosition` |
| GET | `/api/availability/{productId}` | Signed actor, tenant-wide locator | `StockPosition[]`, up to 500 |
| GET | `/api/orders?offset=0` | Own orders; approved staff assigned hubs; corporate tenant | `Stored<Order>[]`, up to 100 |
| GET | `/api/orders/{orderId}` | Same order visibility rule | `Stored<Order>` |
| POST | `/api/orders` | Sales Clerk / Hub Manager / Customer + hub | `Stored<Order>` |
| POST | `/api/orders/{orderId}/settle` | Cashier / Hub Manager + hub | `Stored<Order>` |
| POST | `/api/orders/{orderId}/cancel` | Sales Clerk / Hub Manager / Customer + order visibility | `Stored<Order>` |
| GET | `/api/national` | Regional Manager / Hub Manager / Hub Owner; assigned scope | `NationalSnapshot` |

Approved staff order-read roles: Sales Clerk, Cashier, Hub Manager, Hub Supervisor, Regional Manager and Hub Owner. A customer-only token cannot view another customer's order merely because both use the same hub.

Pagination applies scope before limit, ordered by UUID. `offset` is nonnegative, maximum 1,000,000 for hubs and 10,000,000 for products/orders. Stock/availability have fixed caps and no offset. National reads at most 1,000 registry rows before noncorporate filtering. There are no server-side region/currency filters or full export endpoints; the console filters its returned snapshot.

## Request contracts

All fields shown are required by the documented contract. For mutating requests include `Idempotency-Key` and JSON content type.

### Register a hub

`POST /api/hubs`

```json
{
  "id": "10000000-0000-4000-8000-000000000001",
  "name": "Quezon City Hub",
  "region": "NCR",
  "kind": "Hub",
  "bays": 4,
  "latitude": 14.676,
  "longitude": 121.0437
}
```

`kind`: `Hub`, `Branch`, `Service Centre`, `Warehouse`. Bays: 0-100. Coordinates must be finite; latitude -90..90 and longitude -180..180. Initial status is `Active`. Response `data` contains `hubId` (rather than `id`) plus the input descriptive fields and `status`.

### Change hub status

`PUT /api/hubs/{hubId}/status`

```json
{ "status": "Suspended", "version": 1 }
```

Status: `Active`, `Suspended`, `Closed`. Registry/status propagation to other domains is asynchronous.

### Create product

`POST /api/products`

```json
{
  "id": "20000000-0000-4000-8000-000000000001",
  "sku": "BP-PH-001",
  "name": "Front brake pads",
  "category": "Brakes",
  "kind": "Part",
  "price": 150000,
  "cost": 100000,
  "currency": "PHP"
}
```

Kinds: `Part`, `Accessory`, `Service`. Price/cost: integers 0-1,000,000,000. SKU uniqueness is tenant-scoped and exact/case-sensitive in the current implementation. Products are initially active.

Product creation returns the submitted cost to the authorized writer. Catalogue read `ProductView` omits `cost`. Although the catalogue can store `Service`, the implemented order/reservation slice accepts only active physical parts/accessories.

### Set branch price

`PUT /api/products/{productId}/price`

```json
{ "hubId": "10000000-0000-4000-8000-000000000001", "price": 145000, "version": 0 }
```

Price: 0-1,000,000,000 minor units. The hub must be active in Catalog's registry projection. Currency is inherited from the product. Response `data`: `{ hubId, productId, price, currency }`; outer `id` is the derived branch-price record UUID, not the product UUID.

### Receive delivery

`POST /api/stock/{hubId}/receive`

```json
{
  "productId": "20000000-0000-4000-8000-000000000001",
  "quantity": 25,
  "safetyStock": 5,
  "version": 0,
  "reference": "DELIVERY-EXAMPLE-001"
}
```

Quantity: 1-1,000,000. Safety stock: 0-1,000,000. Inventory must have synchronized the active hub/physical product first. A supplier reference is unique per tenant/hub/product; repeating the same reference with a new command key returns a conflict rather than receiving twice.

### Create merchandise order

`POST /api/orders`

```json
{
  "id": "30000000-0000-4000-8000-000000000001",
  "hubId": "10000000-0000-4000-8000-000000000001",
  "lines": [
    { "productId": "20000000-0000-4000-8000-000000000001", "quantity": 2 }
  ]
}
```

Supply 1-50 unique product lines, each quantity 1-1,000. Orders asks Catalog for authoritative prices and sets `customerSubject` to the authenticated caller's subject. This endpoint has no separate customer-subject input for staff selling on behalf of someone else.

The response initially has `PendingReservation`. Poll GET for `AwaitingSettlement`; do not infer a stock hold from successful order creation alone.

### Record external settlement

`POST /api/orders/{orderId}/settle`

```json
{
  "version": 2,
  "amount": 300000,
  "currency": "PHP",
  "method": "Cash",
  "reference": "EXTERNALLY-VERIFIED-EXAMPLE-001",
  "verifiedExternal": true
}
```

Read the current version, total and currency first; do not assume the example version or amount. Methods: `Cash`, `Debit Card`, `Credit Card`, `E-Wallet`, `Bank Transfer`. Total/currency must exactly match the quote. Only `AwaitingSettlement` can be settled.

**This endpoint does not charge or verify a payment with a provider.** It trusts the authorized operator's external verification assertion. It stores the settlement reference on the order and audits the action; it is not a full payment ledger.

Response is `CommittingInventory`, not necessarily `Completed`. A failed/expired hold after settlement produces `SettlementReconciliationRequired`, requiring external refund/reconciliation.

### Cancel an unpaid order

`POST /api/orders/{orderId}/cancel`

```json
{ "version": 2 }
```

Only `PendingReservation` or `AwaitingSettlement` can be cancelled. The response is `Cancelled`; inventory release is asynchronous. This is not a refund endpoint.

## Response models

| Model | Fields |
|---|---|
| `Hub` | `hubId`, `name`, `region`, `kind`, `bays`, `latitude`, `longitude`, `status` |
| `ProductView` | `id`, `sku`, `name`, `category`, `kind`, `price`, `currency`, `active` |
| `Product` | ProductView plus `cost` (authorized create response only) |
| `StockPosition` | `tenantId`, `hubId`, `productId`, `onHand`, `reserved`, `quarantine`, `safetyStock`, `version`, computed `available` |
| `Order` | `id`, `hubId`, `customerSubject`, `lines`, `total`, `currency`, `status`, `created`, `reservationDeadline`, nullable `failure`, `settlementReference`, `completedAt` |
| Quoted order line | `productId`, `name`, `quantity`, `unitPrice` (no unit cost) |

`available = onHand - reserved`. Quarantine is a separate recorded balance, not an additional subtraction from the current on-hand formula. Receiving/reservation operations do not provide a damaged-goods/quarantine workflow.

Order statuses: `PendingReservation`, `AwaitingSettlement`, `CommittingInventory`, `Completed`, `Rejected`, `Cancelled`, `SettlementReconciliationRequired`. Pending reservation deadline is five minutes; a successful Inventory hold lasts up to fifteen minutes. Expiry workers run about every fifteen seconds. State changes and projections may lag broker processing.

### National snapshot

```json
{
  "generatedAt": "2026-10-08T13:00:00Z",
  "consistency": "Eventual; last-event timestamps show projection freshness",
  "coverage": "Hub registry, physical inventory and completed merchandise sales only. Service, attendance, satisfaction and AI not yet connected.",
  "hubs": [],
  "deadLetters": 0,
  "pendingInbox": 0,
  "pendingOutbox": 0
}
```

Each hub row contains `id`, `name`, `region`, `kind`, `status`, `bays`, `latitude`, `longitude`, `availableUnits`, `lowStockPositions`, `stockPositions`, `completedOrders`, `revenue`, nullable `lastEvent`.

Revenue entries: `{ currency, today, week, month, year }` in minor units. UTC periods use Monday-based weeks. `completedOrders` is lifetime count; revenue periods are date-limited. Low stock means available quantity is at or below safety stock.

Backlog fields describe only the Operations service's own database and are populated for corporate callers; noncorporate callers receive zeroes. They are not fleet-wide health metrics or proof that no other service has failed messages.

## Internal quote API

`POST /quotes` on Catalog's private service URL, with bearer authentication:

```json
{
  "hubId": "10000000-0000-4000-8000-000000000001",
  "lines": [{ "productId": "20000000-0000-4000-8000-000000000001", "quantity": 2 }]
}
```

Response: `{ "lines": [{ "productId": "...", "name": "...", "quantity": 2, "unitPrice": 150000 }], "total": 300000, "currency": "PHP" }`.

This is a read/validation operation, not a stock reservation; it does not require an idempotency key. It is **not mapped at `/api/quotes`** by Gateway or BFF. Orders invokes it server-to-server.

## GraphQL

Send a bearer-authenticated POST with JSON `{ "query": "..." }` directly to Gateway `/graphql`:

```graphql
query NationalOverview {
  national {
    generatedAt
    consistency
    coverage
    hubs {
      id
      name
      region
      availableUnits
      lowStockPositions
      completedOrders
      revenue { currency today week month year }
      lastEvent
    }
  }
}
```

Only the `national` business query is implemented; there are no business mutations or catalogue/order GraphQL queries. The same national authorization applies. Execution depth is limited to 5, execution timeout to 10 seconds, field cost to 300 and type cost to 5,000; `national` has cost 100. GraphQL uses its own `data`/`errors` response envelope and may return HTTP 200 with errors. Do not treat HTTP status alone as business success.

## Errors and retry rules

Handled domain rule errors typically return:

```json
{
  "type": "about:blank",
  "title": "Concurrent change: reload the record before retrying.",
  "status": 409,
  "traceId": "request-trace-reference"
}
```

Web/BFF failures contain `title`, `status`, `traceId` but need not include `type`. Authentication challenges, routing misses, malformed-body framework responses, request-size rejection and rate limits may have a different or empty body. Clients must handle non-JSON errors rather than assuming one universal schema.

| Status | Typical cause | Client action |
|---|---|---|
| 400 | Invalid fields, command key or supported value | Correct request |
| 401 | Missing/expired JWT or application session | Renew identity/sign in |
| 403 | Role/hub denied, invalid claims, cross-origin web mutation | Correct assigned permissions/origin; do not retry blindly |
| 404 | Missing resource or unmapped route | Check ID and supported route |
| 409 | Stale version, duplicate record/delivery/SKU, unavailable projection/quote or illegal transition | Read current state and resolve conflict |
| 413 / 415 | Oversized request / non-JSON BFF mutation | Fix request format/size |
| 429 | Gateway bucket exhausted | Back off; preserve command key |
| 500 / 503 | Domain failure / dependency or identity unavailable | Investigate trace; retry uncertain commands with identical key/body |

A `409` because a registry/catalogue projection is not yet ready can be retried after a bounded delay, without changing key/body. A stale-version correction changes the payload and therefore needs a new logical command key after inspecting the authoritative state. Retrying settlement must never charge the external payment again.

## Health and monitoring

| Surface | Route | Behavior |
|---|---|---|
| .NET services/Gateway | GET `/health/live` | Anonymous process liveness, 200 |
| .NET services/Gateway | GET `/health/ready` | Dependency readiness, 200 or 503 |
| .NET services/Gateway | GET `/metrics` | Prometheus text endpoint; private monitoring only |
| Next.js web | GET `/health` | Web liveness |
| Next.js web | GET `/health/ready` | Cache, identity discovery and Gateway readiness |

Health/metrics are outside `/api` and not proxyable through BFF's allowlist. Production ingress exposes only the web application; keep internal probes/metrics private.

See [usage examples](EXAMPLES.md) for request execution and [architecture](ARCHITECTURE.md) for event envelopes, ownership and failure recovery.
