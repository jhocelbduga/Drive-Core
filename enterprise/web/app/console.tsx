"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Actor, can, Hub, money, Order, Product, Snapshot, Stock, Stored, totals } from "../lib/models";
import { HttpError } from "../lib/policy";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/${path}`, { ...init, cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new HttpError(`${data.title ?? "Operation failed"}${data.traceId ? ` (trace ${data.traceId})` : ""}`, response.status);
  return data as T;
}
type View = "overview" | "hubs" | "catalogue" | "inventory" | "orders";
type Command = "hub" | "status" | "product" | "price" | "receive" | "order" | "settle" | "cancel";
type Field = { name: string; label: string; type?: string; default?: string; choices?: string[]; min?: number; max?: number };
const idField = (name: string, label: string): Field => ({ name, label, type: "uuid" });
const definitions: Record<Command, { title: string; fields: Field[]; roles: string[] }> = {
  hub: { title: "Register a facility", roles: ["Corporate Administrator"], fields: [
    { name: "name", label: "Facility name" }, { name: "region", label: "Region" },
    { name: "kind", label: "Facility type", choices: ["Hub", "Branch", "Service Centre", "Warehouse"] },
    { name: "bays", label: "Service bays", type: "number", default: "0", min: 0, max: 100 },
    { name: "latitude", label: "Latitude", type: "decimal", min: -90, max: 90 },
    { name: "longitude", label: "Longitude", type: "decimal", min: -180, max: 180 }
  ] },
  status: { title: "Update facility status", roles: ["Hub Manager", "Regional Manager"], fields: [
    idField("hubId", "Hub UUID"), { name: "version", label: "Current hub version", type: "number", min: 1 },
    { name: "status", label: "Status", choices: ["Active", "Suspended", "Closed"] }
  ] },
  product: { title: "Create product", roles: ["Inventory Controller"], fields: [
    { name: "sku", label: "Unique SKU" }, { name: "name", label: "Product name" }, { name: "category", label: "Category" },
    { name: "kind", label: "Product type", choices: ["Part", "Accessory"] }, { name: "currency", label: "Currency", choices: ["PHP", "GBP"] },
    { name: "price", label: "Price in minor units (100 = 1.00)", type: "number", min: 0, max: 1000000000 },
    { name: "cost", label: "Cost in minor units", type: "number", min: 0, max: 1000000000 }
  ] },
  price: { title: "Set branch selling price", roles: ["Inventory Controller", "Hub Manager"], fields: [
    idField("productId", "Product UUID"), idField("hubId", "Hub UUID"),
    { name: "price", label: "Price in minor units", type: "number", min: 0, max: 1000000000 },
    { name: "version", label: "Branch price version (0 = first price)", type: "number", min: 0, default: "0" }
  ] },
  receive: { title: "Receive supplier delivery", roles: ["Stock Custodian", "Inventory Controller", "Hub Manager"], fields: [
    idField("hubId", "Hub UUID"), idField("productId", "Product UUID"),
    { name: "quantity", label: "Quantity received", type: "number", min: 1, max: 1000000 },
    { name: "safetyStock", label: "Reorder threshold", type: "number", min: 0, default: "5" },
    { name: "version", label: "Current stock version (0 = new position)", type: "number", min: 0, default: "0" },
    { name: "reference", label: "Unique supplier delivery reference" }
  ] },
  order: { title: "Create merchandise order", roles: ["Sales Clerk", "Hub Manager", "Customer"], fields: [
    idField("hubId", "Hub UUID"), idField("productId", "Product UUID"),
    { name: "quantity", label: "Quantity", type: "number", min: 1, max: 1000, default: "1" }
  ] },
  settle: { title: "Record verified external settlement", roles: ["Cashier", "Hub Manager"], fields: [
    idField("orderId", "Order UUID"), { name: "version", label: "Current order version", type: "number", min: 1 },
    { name: "amount", label: "Exact order total in minor units", type: "number", min: 0 },
    { name: "currency", label: "Currency", choices: ["PHP", "GBP"] },
    { name: "method", label: "Externally verified payment method", choices: ["Cash", "Debit Card", "Credit Card", "E-Wallet", "Bank Transfer"] },
    { name: "reference", label: "External settlement reference" }
  ] },
  cancel: { title: "Cancel unpaid order", roles: ["Sales Clerk", "Hub Manager", "Customer"], fields: [
    idField("orderId", "Order UUID"), { name: "version", label: "Current order version", type: "number", min: 1 }
  ] }
};

function CommandForm({ actor, commands, changed }: { actor: Actor; commands: Command[]; changed: () => void }) {
  const permitted = commands.filter(command => can(actor, ...definitions[command].roles));
  const [selected, select] = useState<Command>(permitted[0] ?? commands[0]);
  const [busy, setBusy] = useState(false), [result, setResult] = useState("");
  const retry = useRef<{ key: string; id: string } | null>(null);
  const active = permitted.includes(selected) ? selected : permitted[0] ?? selected;
  const current = definitions[active];
  if (!permitted.length) return <p className="muted">Your role has read-only access here. Mutation permissions are enforced by the services.</p>;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setResult("");
    const data = new FormData(event.currentTarget), payload: Record<string, string | number | boolean | { productId: string; quantity: number }[]> = {};
    for (const field of current.fields) payload[field.name] = field.type === "number" || field.type === "decimal" ? Number(data.get(field.name)) : String(data.get(field.name));
    retry.current ??= { key: crypto.randomUUID(), id: crypto.randomUUID() };
    let path: string = "", method = "POST";
    switch (active) {
      case "hub": path = "hubs"; payload.id = retry.current.id; break;
      case "status": path = `hubs/${payload.hubId}/status`; delete payload.hubId; method = "PUT"; break;
      case "product": path = "products"; payload.id = retry.current.id; break;
      case "price": path = `products/${payload.productId}/price`; delete payload.productId; method = "PUT"; break;
      case "receive": path = `stock/${payload.hubId}/receive`; delete payload.hubId; break;
      case "order": path = "orders"; payload.id = retry.current.id; payload.lines = [{ productId: String(payload.productId), quantity: Number(payload.quantity) }]; delete payload.productId; delete payload.quantity; break;
      case "settle": path = `orders/${payload.orderId}/settle`; delete payload.orderId; payload.verifiedExternal = data.get("verified") === "on"; break;
      case "cancel": path = `orders/${payload.orderId}/cancel`; delete payload.orderId; break;
    }
    try {
      const response = await api<unknown>(path, { method, headers: { "Content-Type": "application/json", "Idempotency-Key": retry.current.key }, body: JSON.stringify(payload) });
      setResult(`Recorded: ${JSON.stringify(response, null, 2)}`); retry.current = null; changed();
    } catch (error) { setResult(error instanceof Error ? error.message : "Operation failed."); }
    finally { setBusy(false); }
  }
  return <section className="panel command"><h2>Operational command</h2>
    <label>Action<select value={active} onChange={event => { select(event.target.value as Command); setResult(""); retry.current = null; }}>
      {permitted.map(command => <option value={command} key={command}>{definitions[command].title}</option>)}
    </select></label>
    <form key={active} onSubmit={submit} onChange={() => { retry.current = null; }}>
      <div className="form-grid">{current.fields.map(field => <label key={field.name}>{field.label}
        {field.choices ? <select name={field.name}>{field.choices.map(choice => <option key={choice}>{choice}</option>)}</select> :
          <input required name={field.name} defaultValue={field.default} type={field.type === "number" || field.type === "decimal" ? "number" : "text"}
            min={field.min} max={field.max} step={field.type === "decimal" ? "any" : "1"} maxLength={200}
            pattern={field.type === "uuid" ? "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" : undefined} />}
      </label>)}</div>
      {active === "settle" && <label className="check"><input name="verified" type="checkbox" required /> I verified the payment externally. This does not charge a card or wallet.</label>}
      <p className="muted">Commands use optimistic versions and retry-safe keys. Event projections can take a few seconds to update.</p>
      <button disabled={busy}>{busy ? "Submitting..." : current.title}</button>
    </form><pre role="status">{result}</pre>
  </section>;
}

export default function Console() {
  const [actor, setActor] = useState<Actor | null>(null), [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [view, setView] = useState<View>("overview"), [error, setError] = useState(""), [loading, setLoading] = useState(true);
  const [region, setRegion] = useState("All"), [currency, setCurrency] = useState("PHP"), [dark, setDark] = useState(false);
  const [products, setProducts] = useState<Stored<Product>[]>([]), [orders, setOrders] = useState<Stored<Order>[]>([]);
  const [hubs, setHubs] = useState<Stored<{ name: string; region: string; status: string }>[]>([]);
  const [stocks, setStocks] = useState<Stock[]>([]), [lookup, setLookup] = useState(""), [lookupType, setLookupType] = useState("stock");
  const [more, setMore] = useState(false);
  const identity = useRef("");
  const scope = actor ? JSON.stringify([actor.tenant, actor.subject, [...actor.roles].sort(), [...actor.hubs].sort()]) : "";
  const monitor = actor && can(actor, "Regional Manager", "Hub Manager", "Hub Owner");
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const user = await api<Actor>("me");
      const key = JSON.stringify([user.tenant, user.subject, [...user.roles].sort(), [...user.hubs].sort()]);
      if (identity.current !== key) {
        setSnapshot(null); setProducts([]); setOrders([]); setHubs([]); setStocks([]); setMore(false);
        identity.current = key;
      }
      setActor(user);
      if (can(user, "Regional Manager", "Hub Manager", "Hub Owner")) setSnapshot(await api<Snapshot>("national"));
      setError("");
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        setActor(null); setSnapshot(null); setProducts([]); setOrders([]); setHubs([]); setStocks([]); setMore(false); identity.current = "";
      }
      setError(error instanceof Error ? error.message : "Platform unavailable.");
    }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 30000);
    return () => clearInterval(interval);
  }, [refresh]);
  const loadRows = useCallback(async (target: View, offset = 0) => {
    try {
      if (target === "catalogue") { const rows = await api<Stored<Product>[]>(`products?offset=${offset}`); setProducts(old => offset ? [...old, ...rows] : rows); setMore(rows.length === 100); }
      if (target === "orders") { const rows = await api<Stored<Order>[]>(`orders?offset=${offset}`); setOrders(old => offset ? [...old, ...rows] : rows); setMore(rows.length === 100); }
      if (target === "hubs") { const rows = await api<Stored<{ name: string; region: string; status: string }>[]>(`hubs?offset=${offset}`); setHubs(old => offset ? [...old, ...rows] : rows); setMore(rows.length === 200); }
      setError("");
    } catch (error) { setError(error instanceof Error ? error.message : "Records unavailable."); }
  }, []);
  useEffect(() => { if (scope && ["catalogue", "orders", "hubs"].includes(view)) void loadRows(view); }, [view, scope, loadRows]);
  const visible = snapshot?.hubs.filter(hub => region === "All" || hub.region === region) ?? [];
  const revenue = totals(visible, currency);
  async function locate(event: React.FormEvent) {
    event.preventDefault();
    try { setStocks(await api<Stock[]>(`${lookupType}/${lookup}`)); setError(""); }
    catch (error) { setError(error instanceof Error ? error.message : "Stock lookup failed."); }
  }
  function changed() {
    void refresh(); void loadRows(view);
    if (view === "inventory" && lookup) void api<Stock[]>(`${lookupType}/${lookup}`).then(setStocks).catch(error => setError(error instanceof Error ? error.message : "Stock lookup failed."));
  }
  return <div className={dark ? "shell dark" : "shell"}>
    <aside><a className="brand" href="/">DRIVE<span>CORE</span><small>NATIONAL OPERATIONS</small></a><div className="nav-label">COMMAND CENTER</div>
      <nav>{(["overview", "hubs", "catalogue", "inventory", "orders"] as View[]).map(item => <button className={view === item ? "active" : ""} key={item} onClick={() => setView(item)}>{item === "overview" ? "Executive overview" : item[0].toUpperCase() + item.slice(1)}</button>)}</nav>
      <div className="scope"><strong>Tenant-isolated workspace</strong><p>Role and hub scope come from your verified identity, not a browser selector.</p>{actor && <code>{actor.tenant}</code>}</div>
    </aside>
    <main><header><div><div className="eyebrow">DRIVE CORE / ENTERPRISE</div><h1>{view === "overview" ? "National command center" : `${view[0].toUpperCase()}${view.slice(1)} operations`}</h1></div>
      <div className="actions"><button className="secondary" onClick={() => setDark(!dark)}>{dark ? "Light mode" : "Dark mode"}</button>
        {actor ? <form action="/auth/logout" method="post"><button className="secondary">Sign out</button></form> : <a className="button" href="/auth/login">Sign in with SSO</a>}</div></header>
      <div className="statusbar"><span className={actor ? "dot" : "dot offline"} />{actor ? actor.roles.join(" / ") : "Authentication required"}<span>Refresh every 30s while visible</span><button className="secondary" disabled={loading} onClick={() => { void refresh(); void loadRows(view); }}>{loading ? "Connecting..." : "Refresh now"}</button></div>
      {error && <div role="alert" className="error">{error}</div>}
      {!actor ? <section className="panel welcome"><div className="eyebrow">ONE NETWORK. ONE OPERATIONAL VIEW.</div><h2>Turn nationwide visibility into coordinated action.</h2><p>Sign in to view authorized hubs, merchandise sales, stock health and order reservations. No demo records or simulated business results are shown here.</p><a className="button" href="/auth/login">Connect your enterprise identity</a><p className="muted">Requires the enterprise API, OIDC provider and session store. This is separate from the public demo site.</p></section> :
        <>{view === "overview" && (monitor && snapshot ? <>
          <section className="toolbar"><label>Region<select value={region} onChange={e => setRegion(e.target.value)}><option>All</option>{[...new Set(snapshot.hubs.map(h => h.region))].sort().map(r => <option key={r}>{r}</option>)}</select></label><label>Revenue currency<select value={currency} onChange={e => setCurrency(e.target.value)}><option>PHP</option><option>GBP</option></select></label><div className="muted">Snapshot {new Date(snapshot.generatedAt).toLocaleTimeString()}<br />UTC revenue periods; currencies never combined</div></section>
          <section className="kpis">{[
            ["Sales today", money(revenue.today, currency), "Completed merchandise only"],
            ["This week", money(revenue.week, currency), "Monday to today (UTC)"],
            ["This month", money(revenue.month, currency), "Month to date (UTC)"],
            ["This year", money(revenue.year, currency), "Year to date (UTC)"],
            ["Visible facilities", String(visible.length), `${visible.filter(h => h.status === "Active").length} active`],
            ["Available stock units", String(visible.reduce((n, h) => n + h.availableUnits, 0)), "On-hand less reservations"],
            ["Low-stock positions", String(visible.reduce((n, h) => n + h.lowStockPositions, 0)), "At or below reorder threshold"],
            ["Completed orders", String(visible.reduce((n, h) => n + h.completedOrders, 0)), "Lifetime completed merchandise"]
          ].map(([label, value, note]) => <article className="panel kpi" key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>)}</section>
          <div className="analytics"><section className="panel"><h2>Branch revenue ranking</h2><p className="muted">Current month, {currency}</p><RevenueChart hubs={visible} currency={currency} /></section><section className="panel"><h2>Nationwide stock health</h2><p className="muted">Philippines coordinate view. Select a facility for its stock records.</p><GeoMap hubs={visible} select={id => { setLookup(id); setLookupType("stock"); setView("inventory"); }} /></section></div>
          <section className="panel"><h2>Operational attention</h2><p>Rule-based signals, not AI predictions.</p>{visible.some(h => h.lowStockPositions > 0) ? <ul>{visible.filter(h => h.lowStockPositions > 0).map(h => <li key={h.id}><strong>{h.name}</strong>: {h.lowStockPositions} low-stock positions. Review availability before replenishing.</li>)}</ul> : <p>No low-stock signals in the current projection.</p>}
            <p className="muted">{snapshot.consistency}. {snapshot.coverage}</p><p className="muted">Operations service only: {snapshot.pendingInbox} pending events / {snapshot.pendingOutbox} pending publications / {snapshot.deadLetters} failed handlers. These are not fleet-wide totals.</p></section>
          <HubTable hubs={visible} currency={currency} />
        </> : <section className="panel"><h2>Role-scoped operational access</h2><p>Your role does not include national analytics, or its projection is unavailable. Use the operational tabs authorized to your responsibilities.</p></section>)}
        {view === "hubs" && <><section className="panel"><h2>Facility registry</h2><div className="table-wrap"><table><thead><tr><th>Facility / UUID</th><th>Region</th><th>Status</th><th>Version</th></tr></thead><tbody>{hubs.map(row => <tr key={row.id}><td>{row.data.name}<small>{row.id}</small></td><td>{row.data.region}</td><td>{row.data.status}</td><td>{row.version}</td></tr>)}</tbody></table></div>{!hubs.length && <p>No authorized facilities returned.</p>}</section><CommandForm key={view} actor={actor} commands={["hub", "status"]} changed={changed} /></>}
        {view === "catalogue" && <><section className="panel"><h2>Central product master</h2><div className="table-wrap"><table><thead><tr><th>Product / UUID</th><th>SKU</th><th>Category</th><th>Base selling price</th><th>Version</th></tr></thead><tbody>{products.map(row => <tr key={row.id}><td>{row.data.name}<small>{row.id}</small></td><td>{row.data.sku}</td><td>{row.data.category}</td><td>{money(row.data.price, row.data.currency)}</td><td>{row.version}</td></tr>)}</tbody></table></div>{!products.length && <p>No products returned.</p>}</section><CommandForm key={view} actor={actor} commands={["product", "price"]} changed={changed} /></>}
        {view === "inventory" && <><section className="panel"><h2>Inventory locator</h2><form onSubmit={locate} className="toolbar"><label>Search by<select value={lookupType} onChange={e => setLookupType(e.target.value)}><option value="stock">Assigned hub</option><option value="availability">Product across tenant branches</option></select></label><label>UUID<input required value={lookup} onChange={e => setLookup(e.target.value)} pattern="[0-9a-fA-F-]{36}" /></label><button>Locate stock</button></form><p className="muted">Hub lookup returns up to 200 positions; product locator up to 500 branches. Not a complete inventory export.</p><div className="table-wrap"><table><thead><tr><th>Hub</th><th>Product</th><th>On hand</th><th>Reserved</th><th>Available</th><th>Threshold</th><th>Version</th></tr></thead><tbody>{stocks.map(row => <tr key={`${row.hubId}:${row.productId}`}><td><code>{row.hubId}</code></td><td><code>{row.productId}</code></td><td>{row.onHand}</td><td>{row.reserved}</td><td>{row.available}</td><td>{row.safetyStock}</td><td>{row.version}</td></tr>)}</tbody></table></div></section><CommandForm key={view} actor={actor} commands={["receive"]} changed={changed} /></>}
        {view === "orders" && <><section className="panel"><h2>Reservation and settlement lifecycle</h2><p className="muted">Pending reservation - awaiting settlement - committing inventory - completed. Payments are recorded, not charged. Refresh this list to follow asynchronous status updates.</p><div className="table-wrap"><table><thead><tr><th>Order / UUID</th><th>Status</th><th>Total</th><th>Version</th><th>Attention</th></tr></thead><tbody>{orders.map(row => <tr key={row.id}><td><code>{row.id}</code></td><td><span className="badge">{row.data.status}</span></td><td>{money(row.data.total, row.data.currency)}</td><td>{row.version}</td><td>{row.data.failure ?? "None"}</td></tr>)}</tbody></table></div>{!orders.length && <p>No authorized orders returned.</p>}</section><CommandForm key={view} actor={actor} commands={["order", "settle", "cancel"]} changed={changed} /></>}
        {more && ["catalogue", "orders", "hubs"].includes(view) && <button className="secondary" onClick={() => void loadRows(view, view === "catalogue" ? products.length : view === "orders" ? orders.length : hubs.length)}>Load more records</button>}
        </>}
      <footer>DRIVE CORE ENTERPRISE FOUNDATION <span>Live API records | eventual consistency | no simulated metrics</span></footer>
    </main>
  </div>;
}

function RevenueChart({ hubs, currency }: { hubs: Hub[]; currency: string }) {
  const values = hubs.map(h => ({ ...h, amount: h.revenue.find(r => r.currency === currency)?.month ?? 0 })).sort((a, b) => b.amount - a.amount).slice(0, 8);
  const max = Math.max(1, ...values.map(h => h.amount));
  return <div className="bars">{values.map(h => <div key={h.id}><div className="bar-label"><span>{h.name}</span><strong>{money(h.amount, currency)}</strong></div><div className="track"><div style={{ width: `${h.amount / max * 100}%` }} /></div></div>)}{!values.length && <p>No facilities in this scope.</p>}</div>;
}
function GeoMap({ hubs, select }: { hubs: Hub[]; select: (id: string) => void }) {
  const mapped = hubs.filter(h => h.longitude >= 116 && h.longitude <= 127 && h.latitude >= 4 && h.latitude <= 22);
  return <><svg className="map" viewBox="0 0 330 250" role="img" aria-label="Facility locations by latitude and longitude in the Philippines">
    <defs><pattern id="grid" width="30" height="25" patternUnits="userSpaceOnUse"><path d="M30 0H0V25" fill="none" stroke="currentColor" strokeOpacity=".1" /></pattern></defs>
    <rect width="330" height="250" fill="url(#grid)" />
    <text x="10" y="20" className="map-label">22 N / 116 E</text><text x="205" y="240" className="map-label">4 N / 127 E</text>
    {mapped.map(h => <g key={h.id} role="button" tabIndex={0} aria-label={`Inspect ${h.name}`} onClick={() => select(h.id)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(h.id); } }}>
      <title>{h.name}: {h.availableUnits} available units, {h.lowStockPositions} low-stock positions</title>
      <circle cx={(h.longitude - 116) / 11 * 300 + 15} cy={(22 - h.latitude) / 18 * 210 + 20} r="8" fill={h.lowStockPositions ? "#ef9e43" : "#22b99a"} stroke="currentColor" strokeWidth="2" />
    </g>)}
  </svg><p className="muted">{mapped.length} plotted / {hubs.length} visible facilities. Not a road map.</p></>;
}
function HubTable({ hubs, currency }: { hubs: Hub[]; currency: string }) {
  return <section className="panel"><h2>Facility performance</h2><div className="table-wrap"><table><thead><tr><th>Facility</th><th>Region</th><th>Status</th><th>Available units</th><th>Low stock</th><th>Month revenue</th><th>Last event</th></tr></thead><tbody>{hubs.map(h => <tr key={h.id}><td>{h.name}<small>{h.kind}</small></td><td>{h.region}</td><td><span className="badge">{h.status}</span></td><td>{h.availableUnits}</td><td>{h.lowStockPositions}</td><td>{money(h.revenue.find(r => r.currency === currency)?.month ?? 0, currency)}</td><td>{h.lastEvent ? new Date(h.lastEvent).toLocaleString() : "Not synchronized"}</td></tr>)}</tbody></table></div>{!hubs.length && <p>No facilities in this scope.</p>}</section>;
}
