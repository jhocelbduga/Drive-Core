# Drive Core usage examples

These examples distinguish browser demos, authenticated legacy staff operations and the enterprise merchandise slice. Example records are fictional. Never enter production customer data or real payment credentials into demos.

## 1. Public member and owner demos

Open the [live storefront](https://jhocelbduga.github.io/Drive-Core/), or serve the repository root locally:

```powershell
python -m http.server 8765 --bind 127.0.0.1
```

### Member garage and ordering

1. Open `userMemberPage.html` on that origin.
2. Add a fictional vehicle, edit its details, add a manual OBD record and schedule maintenance.
3. Add a product to the shared cart.
4. Open `CartItem.html`, change quantity, proceed to `rfqForm.html`, then `salesInvoice.html`.
5. Open `bookingservice.html` and choose DIY delivery, home installation, hub installation or towing.

These records use local browser storage. RFQs, purchase orders and service bookings do not contact suppliers, charge payments or dispatch technicians/towing. Account forms do not authenticate members.

### Owner analytics

Open `ownerDashboard.html`, switch a demo role/branch/period, toggle dark mode and inspect inventory/finance/service charts. Export CSV, Excel or print-to-PDF.

This dashboard uses seeded data, client-side filters and simulated refreshes. Its insights/forecasts are rules, not trained AI. These exports are **not** enterprise report-service endpoints.

## 2. Authenticated legacy Hub Administration

From the repository root, follow the [root README](../README.md#hub-administration-application) to provision a bootstrap administrator without putting passwords into shell history, then run `npm start` with the same persistent SQLite database.

Open `http://127.0.0.1:8787/hubAdministration.html`.

- Provision employees with appropriate branch assignment and explicit grants.
- Use a custodian account to receive inventory and a sales account to create a customer order.
- Use an authorized cashier to record externally verified settlement; inspect the digital receipt.
- Use independent approvers/QA staff for protected service workflows.
- Confirm branch-restricted users cannot view/mutate other branches.

There are no default live staff credentials. This backend is separate from enterprise OIDC/PostgreSQL and is not running on GitHub Pages.

## 3. Enterprise UI walkthrough

From the enterprise directory:

```powershell
.\infra\Initialize-Local.ps1
docker compose up -d --build
```

After Keycloak responds at `http://localhost:8080/realms/drivecore/.well-known/openid-configuration`:

```powershell
.\infra\Provision-Identity.ps1
Set-Location web
npm ci
npm run dev
```

The scripts create ignored local secrets; do not regenerate them against existing database volumes. Full application-stack/OIDC startup remains an acceptance gate; only dependency-backed integration tests have been verified in CI.

Open `http://localhost:3000`, sign in as `drivecore-admin` using the private `LOCAL_STAFF_PASSWORD` in `.env`, then:

| Console section | Example action | Expected result |
|---|---|---|
| Hubs | Register Quezon City Hub, NCR, 4 bays, coordinates 14.676 / 121.0437 | Hub UUID and version 1 |
| Catalogue | Create fictional brake pads, Part, PHP, price 150000, cost 100000 | Product UUID/version; PHP 1,500.00 base price |
| Inventory | Receive 25 units, safety threshold 5, stock version 0, unique delivery reference | 25 on-hand/available units |
| Orders | Create 2-unit order at that hub | PendingReservation, then AwaitingSettlement after refresh |
| Orders | Record a genuinely verified **test** external settlement matching quoted total/currency/version | CommittingInventory, then Completed |
| Executive overview | Refresh after event processing | Merchandise revenue and inventory projection updated |

Wait for asynchronous hub/product synchronization before receiving/ordering. Retain each returned ID and version. Use current order totals, not guessed values; branch pricing may change the quote. The UI currently creates one-line orders; the API supports up to 50 unique lines.

For an unpaid order, use Cancel with its latest version. Cancellation releases stock asynchronously. For a paid order marked reconciliation-required, follow the [operations runbook](OPERATIONS.md#failed-messages-and-recovery); do not manually mark it completed.

## 4. Browser BFF API examples (no bearer token exposure)

Run these snippets in the developer console **on your signed-in local enterprise web origin**, with the authorized local corporate test user. They operate on the real local backend; they are not static-site snippets and must not be used on production unintentionally.

### Request helpers

```javascript
async function read(path) {
  const response = await fetch(`/api/${path}`, { cache: "no-store" });
  const text = await response.text();
  let result;
  try { result = text ? JSON.parse(text) : null; }
  catch { throw new Error(`HTTP ${response.status}: non-JSON response`); }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${result?.title ?? "Request failed"}`);
  return result;
}

function command(path, payload, method = "POST") {
  const key = crypto.randomUUID();
  const body = JSON.stringify(payload);
  return async function send() {
    const response = await fetch(`/api/${path}`, {
      method,
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body
    });
    const text = await response.text();
    let result;
    try { result = text ? JSON.parse(text) : null; }
    catch { throw new Error(`HTTP ${response.status}: non-JSON response`); }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${result?.title ?? "Command failed"}`);
    return result;
  };
}

async function waitForOrder(id, allowed, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const order = await read(`orders/${id}`);
    if (allowed.includes(order.data.status)) return order;
    if (["Rejected", "Cancelled", "SettlementReconciliationRequired"].includes(order.data.status))
      throw new Error(`Order ${order.data.status}: ${order.data.failure ?? "Review its state"}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("Timed out waiting for order state. Inspect GET; do not recreate the order or charge again.");
}
```

The command helper creates one immutable body/key per returned function. Calling the **same function** again safely retries an uncertain outcome; calling `command(...)` again creates a new logical command. A same-origin browser fetch supplies the session cookie and Origin automatically. No token is read from the browser.

### Create a facility and product

```javascript
const hubId = crypto.randomUUID();
const productId = crypto.randomUUID();
const orderId = crypto.randomUUID();

const registerHub = command("hubs", {
  id: hubId, name: "Example QC Hub", region: "NCR", kind: "Hub",
  bays: 4, latitude: 14.676, longitude: 121.0437
});
const hub = await registerHub();

const createProduct = command("products", {
  id: productId, sku: `EXAMPLE-${productId}`, name: "Example front brake pads",
  category: "Brakes", kind: "Part", price: 150000, cost: 100000, currency: "PHP"
});
const product = await createProduct();
```

### Receive stock after synchronization

```javascript
const receiveDelivery = command(`stock/${hubId}/receive`, {
  productId, quantity: 25, safetyStock: 5, version: 0,
  reference: `EXAMPLE-DELIVERY-${crypto.randomUUID()}`
});
const stock = await receiveDelivery();
const available = await read(`availability/${productId}`);
```

If Inventory responds 409 because registry/catalogue events have not arrived, wait briefly and retry `receiveDelivery()` with the same key/body. Do not retry forever: after a bounded number of attempts inspect dependency health and event failures. For an existing stock position use its returned version rather than `0`.

### Place and inspect an order

```javascript
const placeOrder = command("orders", {
  id: orderId, hubId, lines: [{ productId, quantity: 2 }]
});
const created = await placeOrder();
const reserved = await waitForOrder(orderId, ["AwaitingSettlement"]);
console.log({ status: reserved.data.status, totalMinorUnits: reserved.data.total, currency: reserved.data.currency });
```

The caller is the order's customer subject in this slice; there is no on-behalf-of customer field.

### Record test settlement, then wait for completion

**Only execute after an authorized operator has actually verified the test settlement externally.** The endpoint records that assertion; it does not verify or charge a provider.

```javascript
const current = await read(`orders/${orderId}`);
if (current.data.status !== "AwaitingSettlement") throw new Error("Order is not ready for settlement.");
const recordSettlement = command(`orders/${orderId}/settle`, {
  version: current.version,
  amount: current.data.total,
  currency: current.data.currency,
  method: "Cash",
  reference: `VERIFIED-TEST-${crypto.randomUUID()}`,
  verifiedExternal: true
});
const committing = await recordSettlement();
const completed = await waitForOrder(orderId, ["Completed"]);
const national = await read("national");
```

Completion may precede the national projection update. Re-read the snapshot after event processing. If the settlement request's response is lost, retry `recordSettlement()`; do **not** collect money again.

### Alternative: cancel instead of settling

Use this alternative for a **different unpaid order**, not one already settled by the previous snippet:

```javascript
const unpaid = await read(`orders/${UNPAID_ORDER_ID}`);
const cancelOrder = command(`orders/${unpaid.id}/cancel`, { version: unpaid.version });
const cancelled = await cancelOrder();
```

Replace `UNPAID_ORDER_ID` with a known unpaid order UUID. Inspect current state before a conflict retry.

### Read further pages

```javascript
const firstProducts = await read("products?offset=0");
const nextProducts = await read("products?offset=100");
const firstHubs = await read("hubs?offset=0");
const nextHubs = await read("hubs?offset=200");
```

Arrays have no total-count wrapper. An empty/short page ends that scan; concurrent modifications can affect offset pagination. Locator caps are not paginated exports.

## 5. Direct Gateway API from PowerShell

Use a **separate authorized OIDC API client** to obtain a short-lived access token with the required audience/claims. Do not change the web client to password grant or scrape browser tokens; the BFF intentionally keeps tokens server-side.

The following prompts locally instead of embedding a token in source/history:

```powershell
$base = 'http://localhost:8090'
$credential = Get-Credential -UserName 'oidc-token' -Message 'Paste an authorized test access token into the password field'
$headers = @{ Authorization = "Bearer $($credential.GetNetworkCredential().Password)" }
try {
  $actor = Invoke-RestMethod -Uri "$base/api/me" -Headers $headers
  $snapshot = Invoke-RestMethod -Uri "$base/api/national" -Headers $headers
  $actor.roles
  $snapshot.hubs | Select-Object name, region, availableUnits, lowStockPositions

  $query = @{
    query = 'query { national { generatedAt hubs { id name revenue { currency today month } } } }'
  } | ConvertTo-Json -Compress
  $graph = Invoke-RestMethod -Method Post -Uri "$base/graphql" -Headers $headers -ContentType 'application/json' -Body $query
  if ($graph.errors) { throw 'GraphQL returned errors; inspect the authorized response.' }
  $graph.data.national
} finally {
  $headers.Clear()
  $credential = $null
}
```

Use HTTPS for nonlocal requests. Tokens still exist in process memory while executing; do not log headers, commit tokens or copy them into chat. The local web account/client is configured for browser authorization-code flow, not this standalone client.

## 6. Validation commands

From the enterprise directory:

```powershell
dotnet build DriveCore.slnx --configuration Release
dotnet test tests\Domain.Tests\Domain.Tests.csproj --configuration Release
.\infra\Test-Integration.ps1
Set-Location web
npm test
npm run build
```

Integration tests require the initialized real dependencies and dedicated test database. The runner creates/deletes an isolated test broker vhost. It fails, not silently skips, when dependencies are missing. Run `npm test` separately from the repository root for legacy regressions.

The deployment CI has passed 17 domain, 5 web, 7 real integration and 52 legacy tests. That is not proof of full OIDC startup, payment integration, 10,000-user capacity or disaster-recovery targets.

See [API contracts](API.md) for fields/statuses and [deployment operations](OPERATIONS.md) for container, Azure/Kubernetes and acceptance examples.
