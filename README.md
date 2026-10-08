# DriveCore

A responsive automotive storefront and member garage built with HTML, CSS and vanilla JavaScript.

## Pages

- [Storefront](index.html): categories, product search and a shared saved cart.
- [Member garage](userMemberPage.html): multiple cars, editable details, manual OBD logs, preventive maintenance schedules and alerts.
- [Cart](CartItem.html): quantities and item subtotals.
- [Request a quotation](rfqForm.html): local RFQ snapshots.
- [Purchase order](salesInvoice.html): demo order confirmation and printable summary.
- [Service booking](bookingservice.html): DIY delivery, home installation, hub installation and planned towing requests.
- [Account forms](SignInForm.html): sign-in, registration and password-reset UI.
- [Owner dashboard](ownerDashboard.html): executive KPIs, business intelligence, inventory, sales, service operations, branch comparison, finance and exports.
- [Hub administration](hubAdministration.html): authenticated, backend-backed staff operations (requires the Node server below).

## Run locally

Serve this directory with a static HTTP server, for example:

```shell
python -m http.server 8765 --bind 127.0.0.1
```

Open `http://127.0.0.1:8765/`. Use a web server rather than opening files directly to keep browser storage consistent across pages.

## Tests

Requires Node.js 24 or newer for the SQLite backend; no npm dependencies are needed.

```shell
npm test
```

## Deployment

The GitHub Actions workflow validates JavaScript, runs persistence and dashboard analytics/export tests and deploys the static site to GitHub Pages on pushes to `main`. In repository settings, select **GitHub Actions** as the Pages source.

## Demo limitations

This is a public front-end demo, not a production shop or authenticated member service. Vehicle records, cart items, RFQs, orders and bookings are saved in local browser storage under `drivecore-member-v1`. Data is not shared between devices, origins or users.

The **Hub Administration application is separate**: staff accounts and operational records use authenticated server requests and persistent SQLite storage, not member localStorage. The demo limitations in this section apply to the storefront/member/owner demo, not its staff authorization.

Do not enter sensitive or real customer information. Account authentication, live OBD connections, vehicle fitment validation, supplier quotations, payments, taxes, delivery charges and confirmed service appointments are not implemented. PMS alerts are displayed in the app, not delivered as background notifications. The store finder sends the entered location to Google Maps. Towing requests do not dispatch recovery services.

## Owner monitoring dashboard

Open [ownerDashboard.html](ownerDashboard.html) or select **Owner dashboard** from the storefront. The dashboard runs without external chart, AI or mapping services.

- **Views:** executive, business intelligence, rule-based insights, inventory, sales analytics, service operations, multi-branch monitoring, financial health and reports.
- **Demo scopes:** Product Owner sees all four branches; Hub Owner sees the two London branches; Branch Owner sees North London; Service Provider sees only Alex's North London service records. These are client-side filters, not secure access control. The sample data remains publicly accessible.
- **Filters:** scope, branch and reporting period. Named today/week/month/year KPIs retain their own periods. Chart tooltips support pointer and keyboard focus, with accessible source tables. Branch bars and coordinate-map markers support drill-down.
- **Refresh:** manual simulation or optional 30-second updates. Simulation completes a pending service order and creates a new sample service request. Updates pause while the tab is hidden or dashboard content is focused. Reload/reset restores seeded data. Theme preferences persist locally.
- **Insights:** summaries and recommendations use explicit business rules. Revenue projections use a trailing seven-day average and a capped trend; the shaded +/-25% range is illustrative, not a statistical confidence interval. Stock cover and the seven-day bestseller watch use trailing 30-day unit demand, aggregated across scoped branches for product rankings.
- **Exports:** downloadable CSV (with formula-injection protection), genuine `.xlsx` workbooks and browser print-to-PDF. PDF export opens the print dialog; select **Save as PDF**. Reports include role, scope, dates and metric definitions.
- **Accounting:** integer-penny calculations; GBP excluding VAT. Only completed orders recognize revenue. Gross revenue less discounts/refunds gives net revenue; net less direct costs gives gross profit; operating costs and line-rounded 5% service commissions give net profit. Provider scope excludes shared operating costs. Cash flow is illustrative, not a bank reconciliation.
- **Inventory:** ledger-based balances, paired branch transfers, explicit count adjustments, cost valuation, reorder/max thresholds, FIFO oldest-lot age, turnover and demo physical-count accuracy.
- **Customer metrics:** unique completed purchasers; new/returning uses two years of seeded history. Retention compares purchasers in adjacent equal-length periods.

The dashboard's seeded business records are separate from local member requests: an unconfirmed demo member order must not be presented as actual business revenue. Production use requires a backend, authenticated authorization, transaction feeds, supplier/technician integration, validated financial policies and an appropriate AI service.

## Hub Administration application

### Start and provision the first administrator

Run from this directory with **Node.js 24+**. There are no default passwords or pre-provisioned staff accounts. On the first start only, set `HUB_ADMIN_EMAIL` and `HUB_ADMIN_PASSWORD` (14-200 characters). Use a strong unique password, not a real password copied into source code.

PowerShell example that prompts locally rather than writing the password into shell history:

```powershell
$env:HUB_ADMIN_EMAIL = Read-Host 'Initial corporate administrator email'
$credential = Get-Credential -UserName $env:HUB_ADMIN_EMAIL -Message 'Choose the initial DriveCore administrator password'
$env:HUB_ADMIN_PASSWORD = $credential.GetNetworkCredential().Password
# Recommended: keep the live database outside a OneDrive/synced directory.
$env:HUB_DB = Join-Path $env:LOCALAPPDATA 'DriveCore\hub.sqlite'
npm start
```

Open `http://127.0.0.1:8787/`. After creating the account, stop the server with Ctrl+C, clear the bootstrap variables, and restart using the same database:

```powershell
Remove-Item Env:HUB_ADMIN_PASSWORD
Remove-Item Env:HUB_ADMIN_EMAIL
npm start
```

`HUB_DB` must remain configured on every start when using a custom location. Otherwise the default is `hub-server/data/hub.sqlite`. The database is ignored by Git. Without bootstrap variables, an existing database starts normally; an empty database refuses to create insecure default credentials.

The first corporate administrator can create all other staff roles, including regional managers, through **Staff administration**. Everyone else can administer only lower-level staff within their own branch scope. Employees can change their passwords from **Workforce & attendance**. Password changes and administrator account edits revoke active sessions.

### Implemented operational modules

- **Dashboard:** authorized daily sales/refunds, pending orders, stock risks, attendance, bookings, open tickets, queue and bay occupancy. Multi-branch staff can select **All authorized branches** for a read-only centralized overview, scorecards and combined exports; mutations require a specific working branch. Refresh polls the server every 15 seconds, pausing during dialogs and focused table controls; it is not an event-stream or push-notification service.
- **Inventory/catalogue:** parts, accessories and labour catalogue; supplier receiving, stock issues, damage quarantine, physical counts/adjustments, transactional reservations and stock ledger. FIFO oldest remaining lot age, available-stock valuation, trailing-30-day demand, fast/slow/dead-stock review, stock cover and seven-day constant-rate forecasts. Transfers and returns start new FIFO lots; quarantine is excluded from sellable stock/value.
- **Transfers/locator:** network-wide rack/shelf and warehouse stock lookup, available/reserved quantities, incoming transfer ETA and approximate straight-line branch distance. Inventory controllers can set branch-specific rack locations; catalogue shelves are defaults only. Transfers follow request -> independent source approval -> source dispatch -> destination receipt. Approval reserves stock; dispatched stock is not available at either branch until received.
- **Workforce:** server-timed self punches, breaks, time-out, attendance history, overlapping-shift checks, leave requests and independent leave decisions. Worked hours exclude breaks. Overtime above eight hours per completed punch is an operational estimate, not a payroll calculation. An employee cannot have multiple open punches across branches.
- **Bookings:** all/day/seven-day schedule, four bays per service centre, employee/bay reassignment, resource conflict checks, all six requested booking statuses and active queue. Warehouses have no service bays. Employees cannot hold overlapping appointments across branches.
- **Tickets:** inspection, parts reservations, approval, repair, quality review and completion stages. An independent supervisor starts repair and a reviewer other than the technician authorizes release. Parts consumption is atomic and happens once. Repair start/completion synchronize the linked booking. Approved repairs cannot be reassigned, and bookings with work orders cannot be cancelled/no-show, avoiding orphaned reservations.
- **Queue:** branch/day queue numbers, priority authorization, oldest-priority-first allocation, one serving entry per employee across branches, current-number screen, measured historical waits and completed throughput. Wait estimates are deliberately labelled simple baselines.
- **POS/assisted kiosk:** multi-line parts/accessories/labour orders, server pricing snapshots, reservations, cancellation, externally settled payment records, receipts, bounded returns, restock/quarantine dispositions and loyalty reversal. Cash, debit, credit, e-wallet and bank-transfer records are supported. This is **not a payment gateway**. Non-cash records require explicit confirmation of external settlement; refunds must be performed externally before recording them.
- **Customers:** branch profiles/contact/primary vehicle, additional structured vehicle profiles, notes/complaints, authorized purchase/service histories, points/tier calculation and supplier-specific warranty registrations against paid purchases.
- **Service centre:** occupied bays, staff workload, repair progress, completion counts, parts consumption and quality-check history.
- **Reports:** server-scoped sales, stock movement, services, attendance, bookings, customer activity and settlement CSV/real Excel exports. Print/PDF is available for receipts/customer history. UTC creation-date filters are explicit; raw reports are not statutory accounting statements.
- **Alerts:** low/critical stock, overdue work, delayed bookings, attendance exceptions, customer complaints and branch announcements. Ticket updates create a **not-sent notification outbox**, not fictitious customer delivery confirmations.

### Authorization and integrity

All 15 requested roles have explicit default permissions; corporate administrators can configure role grants. Hierarchy sets minimum authority: stock administration requires level 2+, approvals/attendance oversight level 3+, employee management level 4+. Corporate role permissions are protected to preserve recovery access. Role level alone never gives a clerk manager access.

Every API read, mutation and export checks the active employee, current permissions and assigned branches on the server. Inventory locator intentionally exposes network stock only; it does not expose other branches' customer, employee or sales records. Changing the browser's navigation, branch ID or submitted role cannot grant access. The owner dashboard's role selector remains a separate public sample demo.

Authentication uses salted scrypt hashes, random session tokens stored as hashes, eight-hour HttpOnly/SameSite cookies, CSRF tokens, same-origin mutation checks, account lockout after five failed attempts, and per-address sign-in throttling. Mutations use SQLite transactions, optimistic record versions and idempotency keys. Retry comparison stores request hashes, not passwords. Stock/transfer/payment mutations are atomic, and sensitive server/database files are never served publicly. Audit records identify actors, branches, actions and targets without passwords.

### Hosting, backups and integration boundaries

**GitHub Pages cannot run this backend.** The Pages workflow validates backend tests but uploads only public HTML/CSS/JS/images; the static Hub entry explains how to open the separate server. Host the Node process and durable SQLite file on a single server. Configure `HUB_HOST`, `PORT` and an exact HTTPS `HUB_ORIGIN` behind a TLS reverse proxy for non-loopback hosting. Render's trusted `RENDER_EXTERNAL_URL` is also supported as the public origin. Remote binding without explicit HTTPS configuration is rejected. Only use proxy configurations that preserve the same public origin and restrict direct backend access. Secure cookies are enabled with HTTPS.

### Render deployment

[render.yaml](render.yaml) defines a paid Starter Node service in Singapore with a 1 GB persistent disk mounted at `/var/data`. The build runs all tests before `npm start`; `/api/health` is the readiness endpoint. Review Render's current service/disk pricing before creating it. Set the initial administrator email and strong password in Render's environment settings, not Git. After the first successful sign-in, remove both bootstrap environment variables and redeploy; the persisted account and database remain. Render supplies the HTTPS public origin automatically. If using a custom domain, explicitly set `HUB_ORIGIN` to that exact HTTPS origin.

Never use the free ephemeral filesystem for operational SQLite storage. Keep the service single-instance, configure persistent disk backups, and verify restore procedures. An attached disk means deployments can briefly interrupt service; stock mutations are transaction-safe but staff may need to retry after reconnecting.

Back up the database regularly. For a straightforward consistent backup, stop the Node process gracefully before copying the SQLite file; do not copy just an active `.sqlite` file while WAL writes are in progress. Protect the database and backups with OS file permissions/disk encryption. Do not run multiple application instances against OneDrive/network-synced SQLite files. Set up managed supervision, monitoring, restore drills, retention and your local privacy/tax policies before operational rollout.

The starter catalogue and four branches are configuration fixtures with **zero starting stock and no invented sales/customers**. Adapt branch names/coordinates, bay capacity, currencies, permission policy and catalogue to the actual business before rollout. Technician assignment is to active branch employees; qualification/certification validation is not implemented.

Not yet connected/enabled: card/e-wallet charging or automatic settlement verification, SMS/email delivery, biometric devices, anonymous self-service customer kiosk/QR checkout, supplier APIs, cross-device member-account integration, payroll, VAT/tax invoices, or real-data feeds into the owner's demo BI. The kiosk currently requires an authenticated employee and is explicitly labelled staff-assisted. Biometric intake needs a verified device adapter; there is no unauthenticated endpoint accepting trusted employee clock times. These boundaries require provider/device credentials, business policies and separate integration work, and are never represented as successful live transactions.
