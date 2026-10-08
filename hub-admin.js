"use strict";
document.addEventListener("DOMContentLoaded", () => {
  const $ = id => document.getElementById(id);
  let state, csrf, branch = "", section = "dashboard", pending = false;
  const money = n => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(n / 100);
  const when = value => value ? new Date(value).toLocaleString() : "-";
  const today = () => new Date().toISOString().slice(0, 10);
  const rec = kind => state.records[kind] || [];
  const can = p => state.user.grants.includes(p);
  const name = id => (rec("customers").find(c => c.id === id) || (state.employees || []).find(e => e.id === id) || (state.products || []).find(p => p.id === id) || { name: id }).name;
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  function notify(message, error = false) { $("notice").textContent = message; $("notice").classList.toggle("error", error); $("notice").hidden = false; }
  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: "same-origin", ...options });
    if (!(response.headers.get("content-type") || "").includes("application/json")) throw new Error("Backend unavailable. Run the Node application server, not the static preview.");
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 && path !== "/api/login") signedOut();
      throw new Error(data.error || `Request failed (${response.status}).`);
    }
    return data;
  }
  function signedOut() { state = undefined; csrf = undefined; $("workspace").hidden = true; $("login-panel").hidden = false; $("action-dialog").close(); }
  async function refresh(renderPage = true) {
    if (pending) return;
    if (!branch) {
      const session = await api("/api/me");
      branch = session.user.branches[0];
    }
    const fresh = await api(`/api/state${branch && branch !== "all" ? "?branch=" + encodeURIComponent(branch) : ""}`);
    state = fresh;
    if (!branch || branch !== "all" && !state.branches.some(b => b.id === branch)) branch = state.branches[0].id;
    $("staff-name").textContent = state.user.name;
    $("staff-role").textContent = `${state.user.role} / Level ${state.user.level}`;
    const branchOptions = state.branches.map(b => { const o = node("option", b.name); o.value = b.id; return o; });
    if (state.branches.length > 1) { const all = node("option", "All authorized branches (read-only overview)"); all.value = "all"; branchOptions.unshift(all); }
    $("branch-select").replaceChildren(...branchOptions);
    $("branch-select").value = branch;
    $("sync-status").textContent = `Live records / updated ${new Date(state.generated).toLocaleTimeString()}`;
    $("workspace").hidden = false; $("login-panel").hidden = true;
    if (renderPage) render();
  }
  async function command(action, input) {
    if (branch === "all") throw new Error("Select a specific working branch before recording an operation.");
    pending = true;
    try {
      const result = await api("/api/action", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf, "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ action, input: { ...input, branch } }) });
      return result;
    } finally { pending = false; }
  }
  function button(label, handler, secondary = false) {
    const b = node("button", label, secondary ? "secondary" : ""); b.type = "button";
    b.addEventListener("click", () => Promise.resolve().then(handler).catch(e => notify(e.message, true))); return b;
  }
  function panel(title, description) {
    const p = node("section", undefined, "panel"); p.append(node("h2", title));
    if (description) p.append(node("p", description)); $("content").append(p); return p;
  }
  function kpis(values) {
    const grid = node("div", undefined, "kpis");
    values.forEach(([label, value, note]) => { const card = node("article", undefined, "kpi"); card.append(node("p", label), node("strong", value), node("small", note || "Current working branch")); grid.append(card); });
    $("content").append(grid);
  }
  function toolbar(p, actions) {
    const bar = node("div", undefined, "toolbar");
    actions.forEach(([label, permission, callback]) => { if (!permission || can(permission)) bar.append(button(label, callback)); });
    if (bar.childElementCount) p.append(bar);
  }
  function table(p, title, rows, columns, actions) {
    if (branch === "all" && rows.some(r => r.branch) && !columns.some(([label]) => label === "Branch")) columns = [["Branch", r => r.branch], ...columns];
    const search = node("input"); search.type = "search"; search.placeholder = `Search ${title}`; search.setAttribute("aria-label", `Search ${title}`);
    const control = node("div", undefined, "toolbar"), status = node("small");
    control.append(search, status); p.append(control);
    const wrap = node("div", undefined, "table-wrap"); wrap.tabIndex = 0; wrap.setAttribute("role", "region"); wrap.setAttribute("aria-label", title);
    const t = node("table"), head = node("thead"), tr = node("tr");
    columns.forEach(([label]) => tr.append(node("th", label))); if (actions) tr.append(node("th", "Actions"));
    head.append(tr); t.append(head); const body = node("tbody"); t.append(body); wrap.append(t); p.append(wrap);
    let page = 0;
    const pages = node("div", undefined, "toolbar");
    const back = button("Previous", () => { page--; fill(); }, true), next = button("Next", () => { page++; fill(); }, true);
    pages.append(back, next); p.append(pages);
    function fill() {
      const query = search.value.toLowerCase(), filtered = rows.filter(r => columns.some(([, getter]) => String(getter(r) ?? "").toLowerCase().includes(query)));
      page = Math.max(0, Math.min(page, Math.ceil(filtered.length / 12) - 1));
      body.replaceChildren();
      filtered.slice(page * 12, page * 12 + 12).forEach(row => {
        const r = node("tr"); columns.forEach(([, getter]) => r.append(node("td", getter(row) ?? "-")));
        if (actions) { const cell = node("td"); actions(row).forEach(b => cell.append(b)); r.append(cell); } body.append(r);
      });
      if (!filtered.length) { const r = node("tr"), cell = node("td", "No matching records."); cell.colSpan = columns.length + (actions ? 1 : 0); r.append(cell); body.append(r); }
      status.textContent = `${filtered.length} records / page ${page + 1}`;
      back.disabled = page === 0; next.disabled = (page + 1) * 12 >= filtered.length;
    }
    search.addEventListener("input", () => { page = 0; fill(); }); fill();
  }
  function bars(p, values, formatter = String) {
    const div = node("div", undefined, "bars"), max = Math.max(1, ...values.map(v => v[1]));
    values.forEach(([label, value]) => {
      const row = node("div", undefined, "bar-row"), svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 100 14"); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("aria-hidden", "true");
      const rect = document.createElementNS(svg.namespaceURI, "rect"); rect.setAttribute("width", String(Math.max(0, value) / max * 100)); rect.setAttribute("height", "14"); svg.append(rect);
      row.append(node("span", label), svg, node("strong", formatter(value))); div.append(row);
    }); if (!values.length) div.append(node("p", "No recorded activity.", "empty")); p.append(div);
  }
  const select = (key, label, options, value) => ({ key, label, type: "select", options, value });
  const field = (key, label, type = "text", value) => ({ key, label, type, value });
  const customers = () => rec("customers").map(c => [c.id, `${c.name} / ${c.vehicle}`]);
  const products = (includeServices = false) => (state.products || []).filter(p => includeServices || p.kind !== "Service").map(p => [p.id, `${p.sku} / ${p.name}`]);
  const employees = () => (state.employees || []).filter(e => e.active && e.branches.includes(branch)).map(e => [e.id, e.name]);
  const quantities = () => field("quantity", "Quantity (whole units)", "number", 1);
  const reason = () => field("reason", "Reason / supporting detail", "textarea");
  function form(title, action, fields, initial = {}, description = "") {
    if (branch === "all") throw new Error("Select a specific working branch before recording an operation.");
    $("dialog-title").textContent = title; $("dialog-description").textContent = description;
    $("form-error").textContent = ""; const formNode = $("action-form"); formNode.replaceChildren();
    const controls = new Map();
    fields.forEach(f => {
      const label = node("label", f.label);
      let input;
      if (f.type === "select") {
        input = node("select"); input.append(node("option", "Select...")); input.firstChild.value = "";
        f.options.forEach(([id, name]) => { const o = node("option", name); o.value = id; input.append(o); });
      } else if (f.type === "textarea") input = node("textarea");
      else { input = node("input"); input.type = f.type; }
      input.name = f.key;
      input.setAttribute("aria-label", f.label);
      if (f.type === "checkbox") { input.checked = Boolean(initial[f.key] ?? f.value); label.className = "check-field"; }
      else { input.required = !f.optional; input.value = initial[f.key] ?? f.value ?? ""; }
      if (f.type === "number") { input.min = "0"; input.step = "1"; }
      if (f.type === "password") input.autocomplete = "new-password";
      label.append(input); formNode.append(label); controls.set(f.key, { input, f });
    });
    const additionalLines = [];
    if (action === "order.create") {
      const lines = node("div");
      const addLine = button("Add another item", () => {
        const row = node("div", undefined, "toolbar"), productSelect = node("select"), quantity = node("input");
        productSelect.required = true; productSelect.setAttribute("aria-label", `Additional product ${additionalLines.length + 1}`);
        productSelect.append(node("option", "Select item")); productSelect.firstChild.value = "";
        products(true).forEach(([id, label]) => { const option = node("option", label); option.value = id; productSelect.append(option); });
        quantity.type = "number"; quantity.min = "1"; quantity.max = "1000"; quantity.step = "1"; quantity.value = "1"; quantity.required = true; quantity.setAttribute("aria-label", `Additional quantity ${additionalLines.length + 1}`);
        const item = { productSelect, quantity, removed: false }; additionalLines.push(item);
        row.append(productSelect, quantity, button("Remove item", () => { item.removed = true; row.remove(); }, true)); lines.append(row);
      }, true);
      formNode.append(addLine, lines);
    }
    const submit = node("button", "Save operation"); submit.type = "submit"; formNode.append(submit);
    const requestId = crypto.randomUUID();
    formNode.onsubmit = async event => {
      event.preventDefault(); submit.disabled = true; $("form-error").textContent = "";
      try {
        const input = { ...initial };
        controls.forEach(({ input: element, f }, key) => { input[key] = f.type === "number" ? Number(element.value) : f.type === "checkbox" ? element.checked : element.value; });
        if (action === "order.create") {
          const quantities = new Map([[input.product, input.quantity]]);
          additionalLines.filter(l => !l.removed).forEach(l => quantities.set(l.productSelect.value, (quantities.get(l.productSelect.value) || 0) + Number(l.quantity.value)));
          input.lines = [...quantities].map(([product, quantity]) => ({ product, quantity }));
        }
        if (action === "employee.save") { input.branches = input.branchIds.split(",").map(b => b.trim()).filter(Boolean); delete input.branchIds; }
        if (action === "role.save") { input.grants = input.permissionText.split(/[\s,]+/).filter(Boolean); delete input.permissionText; }
        pending = true;
        await api("/api/action", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf, "Idempotency-Key": requestId }, body: JSON.stringify({ action, input: { ...input, branch } }) });
        if (action === "password.change") {
          pending = false; $("action-dialog").close(); signedOut(); $("login-notice").textContent = "Password changed. Sign in again."; return;
        }
        pending = false; $("action-dialog").close(); await refresh(); notify("Operation saved and audited.");
      } catch (e) { pending = false; $("form-error").textContent = e.message; }
      finally { submit.disabled = false; }
    };
    $("action-dialog").showModal();
  }
  function statusForm(item, action, options, title, additional = []) {
    form(title, action, [select("status", "Next status", options.map(s => [s, s])), ...additional], { id: item.id, version: item.version });
  }
  const views = [
    ["dashboard", "Daily overview", null, "Your role-specific operational workspace. Figures come from saved transactions, not sample revenue."],
    ["inventory", "Inventory control", "inventory.view", "Receiving, issues, quarantine, transfers and independently approved stock counts."],
    ["locator", "Store inventory locator", "inventory.locate", "Network-wide stock visibility only. Other branches' staff and customer records remain private."],
    ["attendance", "Workforce & attendance", "attendance.self", "Web time punches, breaks, shift planning and leave approvals. Biometric hardware is not connected."],
    ["bookings", "Bookings & appointments", "bookings.view", "Daily and weekly schedules with conflict-checked bays and employee assignments."],
    ["tickets", "Service work orders", "tickets.view", "Parts reservations, independent repair approval, quality checks and vehicle release."],
    ["queue", "Smart service queue", "queue.view", "Priority-aware next-customer allocation and recorded wait/throughput measurements."],
    ["pos", "POS & assisted kiosk", "sales.view", "Reserve parts, record externally settled payments and produce receipts. No card details are collected."],
    ["customers", "Customers & vehicles", "customers.view", "Branch-scoped profiles, notes, loyalty, purchase and service histories."],
    ["operations", "Service centre operations", "operations.view", "Current bays, technician workloads, repair progress and operational alerts."],
    ["approvals", "Approvals", "approvals.manage", "Separate requesters and approvers. Stock counts cannot silently overwrite changed balances."],
    ["reports", "Reports & analytics", "reports.view", "Server-authorized CSV/Excel exports and operational charts, scoped to your assigned branches."],
    ["alerts", "Alerts & announcements", null, "Actionable alerts derived only from records you are authorized to view."],
    ["employees", "Staff administration", "employees.manage", "Create and manage lower-level staff accounts and branch assignments."],
    ["roles", "Role permissions", "roles.manage", "Central permission configuration. Hierarchy restrictions and protected corporate recovery access are enforced."],
    ["audit", "Audit trail", "audit.view", "Persistent action history. Passwords and session tokens are never stored in audit details."]
  ];
  function alerts() {
    const values = [];
    (state.stock || []).forEach(s => { const p = state.products.find(p => p.id === s.product); if (s.quantity - s.reserved <= p.reorder) values.push([s.quantity - s.reserved === 0 ? "Critical stock" : "Low stock", p.name, `${s.quantity - s.reserved} available / reorder ${p.reorder}`]); });
    rec("tickets").filter(t => t.status !== "Completed" && Date.parse(t.due) < Date.now()).forEach(t => values.push(["Overdue repair", t.vehicle, t.status]));
    rec("bookings").filter(b => b.status === "Confirmed" && Date.parse(b.starts) < Date.now()).forEach(b => values.push(["Booking waiting", b.vehicle, when(b.starts)]));
    rec("customers").filter(c => c.complaint).forEach(c => values.push(["Customer complaint", c.name, c.notes]));
    rec("shifts").filter(s => Date.parse(s.starts) < Date.now() && Date.parse(s.ends) > Date.now() && !rec("attendance").some(a => a.employee === s.employee && !a.out)).forEach(s => values.push(["Attendance exception", name(s.employee), `Shift started ${when(s.starts)}`]));
    return values;
  }
  function dashboard() {
    const cards = [];
    if (can("sales.view")) {
      cards.push(["Today's recorded sales", money(state.salesSummary.net), "Server-calculated sales minus recorded refunds (UTC date)"],
        ["Pending orders", rec("orders").filter(o => o.status === "Awaiting Payment").length, "Stock remains reserved until paid or cancelled"]);
    }
    if (can("queue.view")) cards.push(["Current queue", rec("queue").filter(q => ["Waiting", "Serving"].includes(q.status)).length, "Waiting and serving"]);
    if (can("bookings.view")) cards.push(["Active bookings", rec("bookings").filter(b => !["Completed", "Cancelled", "No Show"].includes(b.status)).length, "All upcoming and unfinished appointments"]);
    if (can("tickets.view")) cards.push(["Open tickets", rec("tickets").filter(t => t.status !== "Completed").length, "Inspection through release"]);
    if (can("inventory.view")) cards.push(["Low inventory positions", alerts().filter(a => a[0].includes("stock")).length, "Based on available, unreserved units"]);
    if (can("attendance.self")) cards.push(["Clocked-in staff", new Set(rec("attendance").filter(a => !a.out).map(a => a.employee)).size, can("attendance.manage") ? "Working branch" : "Your attendance only"]);
    if (can("bookings.view")) {
      const serviceBranches = state.branches.filter(b => (branch === "all" || b.id === branch) && b.kind !== "Warehouse").length;
      const occupied = new Set(rec("bookings").filter(b => b.status === "In Progress").map(b => `${b.branch}:${b.bay}`)).size;
      cards.push(["Service bay utilization", serviceBranches ? `${Math.round(occupied / (serviceBranches * 4) * 100)}%` : "No service bays", "Four bays per service centre; warehouses excluded"]);
    }
    kpis(cards);
    const activity = panel("Daily activity", "UTC dates for reporting; payments shown only where sales access is authorized.");
    const days = Array.from({ length: 7 }, (_, i) => new Date(Date.now() - (6 - i) * 86400000).toISOString().slice(0, 10));
    if (can("sales.view")) bars(activity, days.map(day => [day, rec("orders").filter(o => o.paidAt && o.paidAt.slice(0, 10) === day).reduce((n, o) => n + o.total, 0)]), money);
    else bars(activity, days.map(day => [day, rec("bookings").filter(b => b.created.slice(0, 10) === day).length]));
    alertsView();
  }
  function inventory() {
    const positions = state.stock || [];
    kpis([["Sellable units", positions.reduce((n, s) => n + s.quantity, 0)], ["Reserved units", positions.reduce((n, s) => n + s.reserved, 0)],
      ["Quarantined units", positions.reduce((n, s) => n + s.quarantine, 0)], ["Stock cost value", money(positions.reduce((n, s) => n + s.quantity * state.products.find(p => p.id === s.product).cost, 0))]]);
    const p = panel("Stock positions", "FIFO oldest remaining lot age; incoming transfers and returns begin new lots. Demand uses trailing-30-day paid sales and service consumption. Quarantined stock is excluded from sellable valuation.");
    toolbar(p, [
      ["Receive supplier delivery", "inventory.move", () => form("Receive stock", "stock.receive", [select("product", "Product", products()), quantities(), field("reference", "Supplier / delivery reference"), reason()])],
      ["Issue stock", "inventory.move", () => form("Issue stock", "stock.issue", [select("product", "Product", products()), quantities(), field("reference", "Transaction reference"), reason()])],
      ["Report damage / defect", "inventory.move", () => form("Quarantine stock", "stock.damage", [select("product", "Product", products()), quantities(), field("reference", "Incident reference"), reason()])],
      ["Audit / adjust stock", "inventory.manage", () => form("Request physical-count adjustment", "stock.audit", [select("product", "Product", products()), field("count", "Physical sellable count", "number"), reason()], {}, "Another authorized employee must approve. Reserved units cannot be removed.")],
      ["New catalogue product", "catalogue.manage", () => productForm()],
      ["Request transfer", "transfers.manage", () => form("Inter-branch transfer request", "transfer.request", [select("product", "Product", products()), quantities(), select("destination", "Destination", [...new Map((state.locations || []).map(l => [l.branch, l.name]))].filter(([id]) => id !== branch)), field("eta", "Incoming ETA", "date"), reason()])]
    ]);
    const rate = s => s.rate;
    table(p, "Stock", positions, [["Branch", s => s.branch], ["Product", s => name(s.product)], ["Shelf", s => s.shelf || state.products.find(p => p.id === s.product).shelf],
      ["On hand", s => s.quantity], ["Available", s => s.quantity - s.reserved], ["Reserved", s => s.reserved], ["Quarantine", s => s.quarantine],
      ["FIFO age", s => s.age === null ? "No stock" : `${s.age} days`],
      ["Movement", s => rate(s) === 0 ? s.age >= 90 ? "Dead-stock review (90+ days)" : "No 30-day demand" : rate(s) >= 1 ? "Fast-moving" : "Slow-moving"],
      ["7-day baseline", s => (rate(s) * 7).toFixed(1)], ["Days cover", s => rate(s) ? ((s.quantity - s.reserved) / rate(s)).toFixed(1) : "No observed demand"]],
      can("catalogue.manage") || can("inventory.manage") ? s => [
        ...(can("catalogue.manage") ? [button("Edit product", () => productForm(state.products.find(p => p.id === s.product)), true)] : []),
        ...(can("inventory.manage") ? [button("Rack / shelf", () => form("Set branch product location", "stock.location", [field("shelf", "Rack / shelf")], { product: s.product, shelf: s.shelf || state.products.find(p => p.id === s.product).shelf }), true)] : [])
      ] : undefined);
    const transfers = panel("Branch transfers", "Approval reserves source inventory; dispatch moves it into transit; receiving adds it to destination. Approval requires a different employee.");
    table(transfers, "Transfers", rec("transfers"), [["Product", t => name(t.product)], ["Source", t => t.branch], ["Destination", t => t.destination], ["Quantity", t => t.quantity], ["ETA", t => t.eta], ["Status", t => t.status]], t => {
      const result = [];
      if (can("approvals.manage") && t.status === "Requested" && t.branch === branch) result.push(button("Approve / reject", () => statusForm(t, "transfer.progress", ["Approved", "Rejected"], "Transfer decision"), true));
      if (can("transfers.manage") && t.status === "Approved" && t.branch === branch) result.push(button("Dispatch", () => statusForm(t, "transfer.progress", ["Dispatched"], "Dispatch transfer")));
      if (can("transfers.manage") && t.status === "Dispatched" && t.destination === branch) result.push(button("Receive", () => statusForm(t, "transfer.progress", ["Received"], "Receive transfer")));
      return result;
    });
    const ledger = panel("Inventory movement ledger");
    table(ledger, "Movement ledger", state.movements || [], [["Date", m => when(m.created)], ["Product", m => name(m.product)], ["Units", m => m.quantity], ["Reason", m => m.reason], ["Reference", m => m.reference]]);
    const catalogue = panel("Parts, accessories & service catalogue", "Service items can be sold without stock reservations. Prices are snapshotted on orders.");
    table(catalogue, "Catalogue", state.products, [["SKU", p => p.sku], ["Name", p => p.name], ["Type", p => p.kind], ["Price", p => money(p.price)], ["Cost", p => money(p.cost)]],
      can("catalogue.manage") ? p => [button("Edit", () => productForm(p), true)] : undefined);
  }
  function productForm(product = {}) {
    form(product.id ? "Edit global catalogue product" : "New global catalogue product", "product.save",
      [field("name", "Product name"), field("sku", "SKU"), select("kind", "Catalogue type", ["Part", "Accessory", "Service"].map(v => [v, v]), "Part"), field("price", "Selling price (GBP pennies)", "number"), field("cost", "Unit cost (GBP pennies)", "number"),
        field("reorder", "Reorder point", "number"), field("shelf", "Default rack / shelf")], product, "Catalogue names and pricing are shared across branches. Existing order snapshots are preserved.");
  }
  function locator() {
    const p = panel("Find stock across the network", "Available excludes reservations; quarantine is never sellable. Sorted by straight-line distance from the working branch, not driving distance.");
    const origin = state.branches.find(b => b.id === branch);
    const distance = l => origin ? Math.round(Math.hypot((l.lat - origin.lat) * 111, (l.lon - origin.lon) * 111 * Math.cos(origin.lat * Math.PI / 180))) : null;
    table(p, "Network inventory", [...state.locations].sort((a, b) => distance(a) - distance(b)), [
      ["Product / SKU", l => `${l.productName} / ${l.sku}`], ["Hub / type", l => `${l.name} / ${l.kind}`], ["Rack / shelf", l => l.shelf],
      ["Available", l => l.quantity - l.reserved], ["Reserved", l => l.reserved],
      ["Incoming / ETA", l => state.incoming.filter(t => t.branch === l.branch && t.product === l.product).map(t => `${t.quantity} ${t.status} / ${t.eta}`).join("; ") || "None"],
      ["Approx. km", l => distance(l) ?? "Choose working branch"]
    ]);
  }
  function attendance() {
    const p = panel("Attendance desk", "Server timestamps prevent client-clock overrides. Overtime is worked time above eight hours per completed punch, not payroll approval.");
    toolbar(p, ["Time In", "Break Start", "Break End", "Time Out"].map(event => [event, "attendance.self", async () => { await command("attendance.punch", { event }); await refresh(); notify(`${event} recorded.`); }]));
    toolbar(p, [
      ["Schedule shift", "attendance.manage", () => form("Schedule employee shift", "shift.create", [select("employee", "Employee", employees()), field("starts", "Starts", "datetime-local"), field("ends", "Ends", "datetime-local")])],
      ["Request leave", "attendance.self", () => form("Request leave", "leave.request", [field("starts", "First day", "date"), field("ends", "Last day", "date"), reason()])]
    ]);
    toolbar(p, [["Change my password", "attendance.self", () => form("Change your password", "password.change", [field("current", "Current password", "password"), field("password", "New password (14+ characters)", "password")], {}, "This will revoke your sessions and require a new sign-in.")]]);
    function worked(a) { return Math.max(0, ((a.out ? Date.parse(a.out) : Date.now()) - Date.parse(a.in) - a.breaks.reduce((n, b) => n + Date.parse(b.end) - Date.parse(b.start), 0) - (a.breakStart ? Date.now() - Date.parse(a.breakStart) : 0)) / 60000); }
    table(p, "Attendance history", rec("attendance"), [["Employee", a => name(a.employee)], ["Time in", a => when(a.in)], ["Time out", a => when(a.out)],
      ["Break", a => a.breakStart ? "On break" : `${a.breaks.length} completed`], ["Worked hours", a => (worked(a) / 60).toFixed(2)], ["Overtime hours", a => a.out ? (Math.max(0, worked(a) - 480) / 60).toFixed(2) : "Open punch"]]);
    const shifts = panel("Shift schedule & punctuality", "Late means first punch after the scheduled start. Missing punches remain visible as exceptions.");
    table(shifts, "Shifts", rec("shifts"), [["Employee", s => name(s.employee)], ["Starts", s => when(s.starts)], ["Ends", s => when(s.ends)], ["Punctuality", s => {
      const punch = rec("attendance").filter(a => a.employee === s.employee && a.in.slice(0, 10) === s.starts.slice(0, 10)).sort((a, b) => a.in.localeCompare(b.in))[0];
      return punch ? Date.parse(punch.in) > Date.parse(s.starts) ? "Late" : "On time" : Date.parse(s.starts) < Date.now() ? "No punch" : "Upcoming";
    }]]);
    const leaves = panel("Leave requests");
    table(leaves, "Leave", rec("leaves"), [["Employee", l => name(l.employee)], ["From", l => l.starts], ["To", l => l.ends], ["Reason", l => l.reason], ["Status", l => l.status]],
      can("attendance.manage") ? l => l.status === "Pending" ? [button("Decide", () => statusForm(l, "leave.decide", ["Approved", "Rejected"], "Leave decision"))] : [] : undefined);
  }
  const bookingNext = { Confirmed: ["Waiting", "Cancelled", "No Show"], Waiting: ["In Progress", "Cancelled"], "In Progress": ["Completed"] };
  function bookings() {
    const p = panel("Service appointment calendar", "Each service centre has four bays. Overlapping bay or employee assignments are rejected by the backend.");
    toolbar(p, [["New appointment", "bookings.manage", () => form("Create appointment", "booking.create", [select("customer", "Customer / vehicle", customers()),
      { ...select("vehicleId", "Additional saved vehicle (optional; must match customer)", rec("vehicles").map(v => [v.id, `${name(v.customer)} / ${v.model} / ${v.registration}`])), optional: true },
      field("service", "Requested service"), field("starts", "Appointment", "datetime-local"), field("duration", "Duration in minutes", "number", 60),
      field("bay", "Service bay (1 to 4)", "number", 1), select("technician", "Assigned employee", employees())])]]);
    const controls = node("div", undefined, "toolbar"), label = node("label", "Schedule day"), day = node("input"); day.type = "date"; day.value = today(); label.append(day);
    const modeLabel = node("label", "Calendar view"), mode = node("select");
    ["All appointments", "Day", "Week"].forEach(v => mode.append(node("option", v))); modeLabel.append(mode); controls.append(label, modeLabel); p.append(controls);
    const target = node("div"); p.append(target);
    const fill = () => {
      target.replaceChildren(); const start = Date.parse(day.value), end = start + (mode.value === "Week" ? 7 : 1) * 86400000;
      table(target, "Appointment schedule", rec("bookings").filter(b => mode.value === "All appointments" || Date.parse(b.starts) >= start && Date.parse(b.starts) < end).sort((a, b) => a.starts.localeCompare(b.starts)),
        [["Appointment", b => when(b.starts)], ["Customer", b => name(b.customer)], ["Vehicle", b => b.vehicle], ["Service", b => b.service],
          ["Bay / employee", b => `${b.bay} / ${name(b.technician)}`], ["Minutes", b => b.duration], ["Status", b => b.status]], b => {
          const result = [];
          if (can("bookings.manage") && bookingNext[b.status]) result.push(button("Status", () => statusForm(b, "booking.status", bookingNext[b.status], "Booking status"), true),
            button("Assign", () => form("Reassign appointment", "booking.assign", [field("bay", "Bay", "number", b.bay), select("technician", "Employee", employees(), b.technician)], { id: b.id, version: b.version }), true));
          if (can("tickets.manage") && !rec("tickets").some(t => t.booking === b.id) && !["Completed", "Cancelled", "No Show"].includes(b.status)) result.push(button("Work order", () => ticketForm(b)));
          return result;
        });
    };
    day.addEventListener("change", fill); mode.addEventListener("change", fill); fill();
  }
  function ticketForm(booking) {
    form("Create service work order", "ticket.create", [select("booking", "Booking", rec("bookings").filter(b => !["Completed", "Cancelled", "No Show"].includes(b.status)).map(b => [b.id, `${b.vehicle} / ${b.service}`]), booking && booking.id),
      select("advisor", "Service advisor", employees()), field("work", "Inspection / work instructions", "textarea"), field("due", "Expected completion", "datetime-local")]);
  }
  const ticketNext = { "Pending Inspection": ["Waiting for Parts", "Awaiting Approval"], "Waiting for Parts": ["Awaiting Approval"],
    "Awaiting Approval": ["Under Repair"], "Under Repair": ["Quality Check"], "Quality Check": ["Under Repair", "Ready for Release"], "Ready for Release": ["Completed"] };
  function tickets() {
    const p = panel("Service tickets & work orders", "Parts are reserved before approval and consumed once when repair starts. Repair approval and quality checks require authorized independent employees.");
    toolbar(p, [["Create service ticket", "tickets.manage", () => ticketForm()]]);
    table(p, "Service tickets", rec("tickets"), [["Vehicle", t => t.vehicle], ["Advisor", t => name(t.advisor)], ["Technician", t => name(t.technician)], ["Work", t => t.work], ["Parts", t => t.parts.map(p => `${p.name} x${p.quantity}`).join(", ") || "None"],
      ["Due", t => when(t.due)], ["Status", t => t.status], ["Quality", t => t.qualityNote || "Not checked"]], t => {
      const result = [];
      if (can("tickets.manage") && ticketNext[t.status]) result.push(button("Progress", () => statusForm(t, "ticket.status", ticketNext[t.status], "Ticket progress", t.status === "Quality Check" ? [field("note", "QA checklist / findings", "textarea")] : [])));
      if (can("tickets.manage") && !t.consumed && !t.approvedBy) result.push(button("Add parts", () => form("Reserve service parts", "ticket.parts", [select("product", "Product", products()), quantities()], { id: t.id, version: t.version }), true));
      return result;
    });
    const notifications = panel("Customer notification outbox", "These notices have NOT been sent. Configure an SMS/email provider before enabling delivery.");
    table(notifications, "Notification outbox", rec("notifications"), [["Customer", n => name(n.customer)], ["Message", n => n.message], ["Delivery", n => `${n.status} / ${n.channel}`], ["Created", n => when(n.created)]]);
  }
  function queue() {
    const waiting = rec("queue").filter(q => q.status === "Waiting"), serving = rec("queue").filter(q => q.status === "Serving"), completed = rec("queue").filter(q => q.status === "Completed");
    const average = completed.length ? completed.reduce((n, q) => n + (Date.parse(q.served) - Date.parse(q.joined)) / 60000, 0) / completed.length : null;
    const screen = node("section", undefined, "queue-screen"); screen.append(node("p", "NOW SERVING"), node("strong", serving.map(q => `${branch === "all" ? q.branch + ": " : ""}${String(q.number).padStart(3, "0")}`).join(" / ") || "---"),
      node("p", `${waiting.length} waiting / ${average === null ? "No measured wait history" : average.toFixed(1) + " min historical average wait"}`)); $("content").append(screen);
    kpis([["Waiting", waiting.length], ["Serving", serving.length], ["Completed", completed.length], ["Estimated wait", average === null ? "Not enough data" : `${Math.round(average * Math.max(1, waiting.length))} min`, "Simple historical baseline, not a promise"]]);
    const p = panel("Queue control", "A technician may serve one queue entry at a time. Priority override requires supervisor authority.");
    toolbar(p, [
      ["Add customer", "queue.manage", () => form("Join service queue", "queue.join", [select("customer", "Customer", customers()), ...(can("queue.priority") ? [field("priority", "Priority customer", "checkbox")] : [])])],
      ["Serve next", "queue.manage", () => form("Allocate next waiting customer", "queue.next", [select("technician", "Available employee", employees())])]
    ]);
    table(p, "Customer queue", rec("queue"), [["Number", q => q.number], ["Customer", q => name(q.customer)], ["Priority", q => q.priority ? "Priority" : "Standard"], ["Status", q => q.status],
      ["Employee", q => q.technician ? name(q.technician) : "Unassigned"], ["Wait", q => `${Math.round(((q.served ? Date.parse(q.served) : Date.now()) - Date.parse(q.joined)) / 60000)} min`]],
      q => can("queue.manage") && q.status === "Serving" ? [button("Finish", () => statusForm(q, "queue.finish", ["Completed"], "Finish queue service"))] : []);
    const employeesPanel = panel("Employee workload", "Assignments are staff-based; technician qualifications must be managed by your service supervisor.");
    bars(employeesPanel, (state.employees || []).filter(e => e.active).map(e => [e.name, rec("bookings").filter(b => b.technician === e.id && !["Completed", "Cancelled", "No Show"].includes(b.status)).length]));
  }
  function receipt(order) {
    const target = $("receipt-content"); target.replaceChildren(node("p", `Order ${order.id}`), node("p", `Customer: ${name(order.customer)} / Branch: ${order.branch}`),
      node("p", `Status: ${order.status} / ${when(order.paidAt || order.created)}`));
    order.lines.forEach(l => target.append(node("p", `${l.name} x${l.quantity} / ${money(l.price * l.quantity)} / returned ${l.returned}`)));
    target.append(node("h3", `Total: ${money(order.total)}`), node("p", `Payment record: ${order.receipt || "Awaiting payment"}`),
      node("p", "Amounts exclude VAT. This is an operational receipt, not a tax invoice. Card/e-wallet processing and refunds occur outside this system."));
    $("receipt-dialog").showModal();
  }
  function pos() {
    const p = panel("Sales desk / staff-assisted kiosk", "Orders reserve inventory until settlement. Kiosk orders use the same authenticated, audited workflow; anonymous public ordering and QR checkout are not enabled.");
    toolbar(p, [["New POS order", "sales.create", () => orderForm("POS")], ["Assisted kiosk order", "sales.create", () => orderForm("Kiosk")]]);
    table(p, "Customer orders", rec("orders"), [["Created", o => when(o.created)], ["Customer", o => name(o.customer)], ["Lines", o => o.lines.map(l => `${l.name} x${l.quantity}`).join("; ")], ["Total", o => money(o.total)], ["Channel", o => o.channel], ["Status", o => o.status]], o => {
      const result = [button("Receipt", () => receipt(o), true)];
      if (can("payments.manage") && o.status === "Awaiting Payment") result.push(button("Record payment", () => form("Record settled payment", "payment.record",
        [select("method", "Payment method", ["Cash", "Debit Card", "Credit Card", "E-Wallet", "Bank Transfer"].map(v => [v, v])),
          field("amount", "Received amount (GBP pennies)", "number", o.total), field("reference", "Cash receipt / external settlement reference"),
          field("verified", "I verified external settlement (required for non-cash)", "checkbox")], { id: o.id, version: o.version },
        "No gateway charge is performed. Verify non-cash payment in your provider portal before recording. Never enter card numbers.")));
      if (can("sales.create") && o.status === "Awaiting Payment") result.push(button("Cancel", () => statusForm(o, "order.cancel", ["Cancelled"], "Cancel unpaid order"), true));
      if (can("payments.manage") && ["Paid", "Partially Returned"].includes(o.status)) result.push(button("Return / refund record", () => form("Record returned items", "order.return",
        [select("product", "Purchased item", o.lines.filter(l => l.returned < l.quantity).map(l => [l.product, l.name])), quantities(),
          select("disposition", "Disposition", ["Restock", "Defective", "Damaged"].map(v => [v, v])), field("reference", "Refund settlement reference"), reason()],
        { id: o.id, version: o.version }, "Issue and verify the refund externally first. This operation records it and updates stock/loyalty; it does not transfer money."), true));
      return result;
    });
    if (can("settlement.view")) {
      const settlement = panel("Payment and refund settlement records");
      table(settlement, "Settlements", [...rec("payments"), ...rec("returns").map(r => ({ ...r, amount: -r.amount, method: "Refund" }))],
        [["Date", p => when(p.created)], ["Order", p => p.order], ["Method", p => p.method], ["Amount", p => money(p.amount)], ["Reference", p => p.reference]]);
    }
  }
  function orderForm(channel) {
    form(`Create ${channel} order`, "order.create", [select("customer", "Customer", customers()), select("product", "Product", products(true)), quantities()],
      { channel }, "Add parts, accessories or service labour lines. Duplicate products are combined; current server catalogue prices apply.");
  }
  function customersView() {
    const p = panel("Customer and vehicle profiles", "Membership points are earned on paid merchandise and reversed on returns. Warranty notes should reference supplier terms; this system does not promise a universal warranty.");
    toolbar(p, [["New customer / vehicle", "customers.manage", () => form("Create customer profile", "customer.create", [field("name", "Customer name"), field("contact", "Contact"), field("vehicle", "Vehicle / registration"), { ...field("notes", "Notes / warranty terms", "textarea"), optional: true }])]]);
    table(p, "Customers", rec("customers"), [["Name", c => c.name], ["Contact", c => c.contact], ["Vehicle", c => c.vehicle], ["Points / tier", c => `${c.points} / ${c.tier}`], ["Notes", c => c.notes]], c => [
      button("History", () => {
        const target = $("receipt-content"); target.replaceChildren(node("h3", c.name), node("p", c.vehicle), node("p", c.notes || "No notes"));
        rec("orders").filter(o => o.customer === c.id).forEach(o => target.append(node("p", `Purchase ${when(o.created)} / ${money(o.total)} / ${o.status}`)));
        rec("tickets").filter(t => t.customer === c.id).forEach(t => target.append(node("p", `Service ${when(t.created)} / ${t.work} / ${t.status}`)));
        rec("vehicles").filter(v => v.customer === c.id).forEach(v => target.append(node("p", `Vehicle: ${v.model} / ${v.registration} / ${v.year} / ${v.mileage} km`)));
        rec("warranties").filter(w => w.customer === c.id).forEach(w => target.append(node("p", `Warranty ${w.reference}: ${name(w.product)} / expires ${w.expires} / ${w.terms}`)));
        if (!can("sales.view") || !can("tickets.view")) target.append(node("p", "History is limited to the modules your role can access."));
        $("receipt-dialog").showModal();
      }, true),
      ...(can("customers.manage") ? [button("Notes / complaint", () => form("Update customer notes", "customer.note", [field("notes", "Notes / warranty details", "textarea"), field("complaint", "Open complaint", "checkbox")], { id: c.id, version: c.version, notes: c.notes, complaint: c.complaint }), true)] : []),
      ...(can("customers.manage") ? [button("Add vehicle", () => form("Add customer vehicle", "vehicle.create", [field("registration", "Registration / plate"), field("model", "Make / model"), field("year", "Model year", "number", new Date().getFullYear()), field("mileage", "Odometer (km)", "number", 0), { ...field("vin", "VIN (optional)"), optional: true }], { customer: c.id }), true)] : [])
    ]);
    const warranties = panel("Warranty register", "Record supplier-specific terms against actual paid purchases. No automatic warranty entitlement is assumed.");
    toolbar(warranties, [["Record supplier warranty", "customers.manage", () => form("Record warranty", "warranty.create",
      [select("order", "Paid order", rec("orders").filter(o => o.paidAt).map(o => [o.id, `${name(o.customer)} / ${o.id.slice(0, 8)}`])),
        select("product", "Purchased item (validated against order)", products(true)), field("expires", "Expiry date", "date"), field("reference", "Warranty reference"), field("terms", "Supplier terms", "textarea")])]]);
    table(warranties, "Warranties", rec("warranties"), [["Customer", w => name(w.customer)], ["Product", w => name(w.product)], ["Expires", w => w.expires], ["Reference", w => w.reference], ["Terms", w => w.terms]]);
  }
  function operations() {
    const p = panel("Service bay monitoring", "Bookings marked In Progress represent occupied bays. Calendar assignments are validated, but staff must update statuses on time.");
    const grid = node("div", undefined, "grid");
    if (!can("bookings.view")) grid.append(node("p", "Your role is not authorized to view booking/bay occupancy records."));
    for (const hub of state.branches.filter(b => can("bookings.view") && (branch === "all" || b.id === branch))) {
      if (hub.kind === "Warehouse") { grid.append(node("p", `${hub.name}: no service bays.`)); continue; }
      for (let i = 1; i <= 4; i++) {
        const active = rec("bookings").filter(b => b.branch === hub.id && b.bay === i && b.status === "In Progress"), card = node("article", undefined, "bay");
        card.append(node("h3", `${hub.name} / bay ${i}`), node("strong", active.length ? "Occupied" : "Available"), node("p", active.map(b => `${b.vehicle} / ${name(b.technician)}`).join("; ") || "No active repairs")); grid.append(card);
      }
    }
    p.append(grid);
    const technicians = panel("Technician productivity", "Completed bookings and tickets are recorded throughput, not payroll or skill certification.");
    table(technicians, "Team performance", state.employees || [], [["Employee", e => e.name], ["Active bookings", e => can("bookings.view") ? rec("bookings").filter(b => b.technician === e.id && ["Waiting", "In Progress"].includes(b.status)).length : "Not authorized"],
      ["Completed bookings", e => can("bookings.view") ? rec("bookings").filter(b => b.technician === e.id && b.status === "Completed").length : "Not authorized"], ["Completed tickets", e => can("tickets.view") ? rec("tickets").filter(t => t.technician === e.id && t.status === "Completed").length : "Not authorized"]]);
    alertsView();
  }
  function approvals() {
    const p = panel("Inventory adjustment approvals", "Self-approval is blocked. A stale count must be rejected and repeated after subsequent stock movements.");
    table(p, "Approvals", rec("approvals"), [["Type", a => a.type], ["Product", a => name(a.product)], ["Baseline / count", a => `${a.baseline} / ${a.count}`], ["Difference", a => a.delta], ["Reason", a => a.reason], ["Status", a => a.status]],
      a => a.status === "Pending" ? [button("Approve / reject", () => statusForm(a, "approval.decide", ["Approved", "Rejected"], "Count approval"))] : []);
    const hint = node("p", "Transfer approvals are available in Inventory control; service approvals in Service work orders."); p.append(hint);
  }
  const reportTypes = [["sales", "sales.view", "Daily sales"], ["inventory", "inventory.view", "Inventory movement"], ["services", "tickets.view", "Service performance"],
    ["attendance", "attendance.manage", "Employee attendance"], ["bookings", "bookings.view", "Booking utilization"], ["customers", "customers.view", "Customer activity"], ["settlement", "settlement.view", "Payment settlement"]];
  function reports() {
    const p = panel("Operational report centre", "Exports are generated and authorized on the server. Date filters use UTC record creation timestamps, not appointment dates.");
    const bar = node("div", undefined, "toolbar"), startLabel = node("label", "From (UTC)"), start = node("input"), endLabel = node("label", "To (UTC)"), end = node("input");
    start.type = end.type = "date"; start.value = today().slice(0, 8) + "01"; end.value = today(); startLabel.append(start); endLabel.append(end); bar.append(startLabel, endLabel); p.append(bar);
    reportTypes.filter(([, permission]) => can(permission)).forEach(([type, , label]) => {
      const row = node("div", undefined, "toolbar"); row.append(node("strong", label));
      ["csv", "xlsx"].forEach(format => row.append(button(format.toUpperCase(), async () => {
        const params = new URLSearchParams({ type, start: start.value, end: end.value, format });
        if (branch !== "all") params.set("branch", branch);
        const response = await fetch("/api/report?" + params, { credentials: "same-origin" });
        if (!response.ok) { const error = await response.json(); throw new Error(error.error); }
        const blob = await response.blob(), url = URL.createObjectURL(blob), a = node("a"); a.href = url; a.download = `DriveCore-${type}.${format}`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }, true))); p.append(row);
    });
    const scores = panel("Branch operational scorecards", "Select All authorized branches for a centralized comparison. Saved operational records remain separate from the owner's seeded BI demo.");
    table(scores, "Branch scorecards", state.branches.filter(b => branch === "all" || b.id === branch), [
      ["Branch", b => b.name],
      ["Recorded sales", b => can("sales.view") ? money(rec("orders").filter(o => o.branch === b.id && o.paidAt).reduce((n, o) => n + o.total, 0)) : "Not authorized"],
      ["Completed tickets", b => can("tickets.view") ? rec("tickets").filter(t => t.branch === b.id && t.status === "Completed").length : "Not authorized"],
      ["Active bookings", b => can("bookings.view") ? rec("bookings").filter(t => t.branch === b.id && !["Completed", "Cancelled", "No Show"].includes(t.status)).length : "Not authorized"],
      ["Completed queue", b => can("queue.view") ? rec("queue").filter(t => t.branch === b.id && t.status === "Completed").length : "Not authorized"],
      ["Clocked in", b => can("attendance.manage") ? rec("attendance").filter(t => t.branch === b.id && !t.out).length : "Team view not authorized"]
    ]);
    if (can("bookings.view")) {
      const serviceVolume = panel("Service volume by branch");
      bars(serviceVolume, state.branches.filter(b => branch === "all" || b.id === branch).map(b => [b.name, rec("bookings").filter(t => t.branch === b.id && t.status === "Completed").length]));
    }
    if (can("attendance.manage")) {
      const attendanceTrend = panel("Attendance activity", "Count of recorded time-ins by UTC day; this is not a payroll utilization rate.");
      const attendanceDays = Array.from({ length: 7 }, (_, i) => new Date(Date.now() - (6 - i) * 86400000).toISOString().slice(0, 10));
      bars(attendanceTrend, attendanceDays.map(day => [day, rec("attendance").filter(a => a.in.slice(0, 10) === day).length]));
    }
    if (can("inventory.view")) {
      const movements = panel("Inventory movement trend");
      const days = Array.from({ length: 7 }, (_, i) => new Date(Date.now() - (6 - i) * 86400000).toISOString().slice(0, 10));
      bars(movements, days.map(day => [day, (state.movements || []).filter(m => m.created.slice(0, 10) === day).reduce((n, m) => n + Math.abs(m.quantity), 0)]));
    }
  }
  function alertsView() {
    const p = panel("Operational alerts");
    table(p, "Alerts", alerts(), [["Alert", a => a[0]], ["Subject", a => a[1]], ["Detail", a => a[2]]]);
    const announcements = panel("Hub announcements");
    toolbar(announcements, [["Post announcement", "announcements.manage", () => form("Publish announcement", "announcement.create", [field("title", "Title"), field("message", "Announcement", "textarea")])]]);
    rec("announcements").forEach(a => { const item = node("article", undefined, "announcement"); item.append(node("h3", a.title), node("p", a.message), node("small", when(a.created))); announcements.append(item); });
    if (!rec("announcements").length) announcements.append(node("p", "No operational announcements.", "empty"));
  }
  function employeeForm(employee = {}) {
    form(employee.id ? "Update employee / reset password" : "Create staff account", "employee.save",
      [field("name", "Employee name"), field("email", "Staff email", "email"), select("role", "Assigned role", state.roles.filter(r => r.level < state.user.level || state.user.role === "Corporate Operations Manager" && r.name !== state.user.role).map(r => [r.name, `Level ${r.level} / ${r.name}`])),
        field("branchIds", `Assigned branch IDs (${state.branches.map(b => b.id).join(", ")})`), { ...field("password", "Password (14+ characters; leave blank to keep existing)", "password"), optional: Boolean(employee.id) },
        field("active", "Account enabled", "checkbox", true)],
      { ...employee, branchIds: employee.branches ? employee.branches.join(", ") : branch, active: employee.id ? Boolean(employee.active) : true },
      "Only authorized lower-level staff may be edited. Changes revoke their current sessions.");
  }
  function staff() {
    const p = panel("Employee administration"); toolbar(p, [["Add staff account", "employees.manage", () => employeeForm()]]);
    table(p, "Employees", state.employees || [], [["Name", e => e.name], ["Role", e => e.role], ["Assigned branches", e => e.branches.join(", ")], ["Active", e => e.active ? "Enabled" : "Disabled"]],
      e => e.id !== state.user.id ? [button("Manage", () => employeeForm(e), true)] : []);
  }
  function rolesView() {
    const p = panel("Configurable role permissions", "Permissions apply immediately on every request. Supervisory approvals require level 3+, staff management requires level 4+. Corporate recovery access is protected.");
    table(p, "Role permissions", state.roles, [["Role", r => r.name], ["Level", r => r.level], ["Permissions", r => r.grants.join(", ")]],
      r => r.name !== "Corporate Operations Manager" ? [button("Configure", () => form("Configure role grants", "role.save", [field("permissionText", "Allowed permissions, separated by commas or newlines", "textarea")],
        { role: r.name, permissionText: r.grants.join(", ") }, `Available permissions: ${state.permissions.join(", ")}`), true)] : []);
  }
  function auditView() {
    const p = panel("Persistent audit trail", "Most recent 1,000 events are loaded; records remain in SQLite. Operational mutations and account/role changes are recorded.");
    table(p, "Audit history", state.audit || [], [["Date", a => when(a.created)], ["Actor", a => name(a.actor)], ["Action", a => a.action], ["Branch", a => a.branch], ["Target", a => a.target], ["Details", a => a.details]]);
  }
  function render() {
    const allowed = views.filter(([, , permission]) => !permission || can(permission));
    section = location.hash.slice(1) || "dashboard";
    if (!allowed.some(([id]) => id === section)) { section = "dashboard"; history.replaceState(null, "", "#dashboard"); }
    $("navigation").replaceChildren(...allowed.map(([id, label]) => {
      const a = node("a", label); a.href = "#" + id; if (section === id) a.setAttribute("aria-current", "page");
      a.addEventListener("click", () => { $("sidebar").classList.remove("open"); $("menu-toggle").setAttribute("aria-expanded", "false"); }); return a;
    }));
    const view = views.find(([id]) => id === section); $("page-title").textContent = view[1]; $("page-description").textContent = view[3];
    $("content").replaceChildren();
    const renderers = { dashboard, inventory, locator, attendance, bookings, tickets, queue, pos, customers: customersView, operations, approvals, reports, alerts: alertsView, employees: staff, roles: rolesView, audit: auditView };
    renderers[section](); document.title = `${view[1]} | DriveCore Hub`;
  }
  $("login-form").addEventListener("submit", async event => {
    event.preventDefault(); const form = event.currentTarget, submit = form.querySelector("button"); submit.disabled = true;
    $("login-notice").textContent = "";
    try {
      const data = await api("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      csrf = data.csrf; branch = ""; form.reset(); await refresh();
    } catch (e) { $("login-notice").textContent = e.message; }
    finally { submit.disabled = false; }
  });
  $("logout").addEventListener("click", async () => { try { await api("/api/logout", { method: "POST", headers: { "X-CSRF-Token": csrf } }); signedOut(); } catch (e) { notify(e.message, true); } });
  $("refresh").addEventListener("click", () => refresh().catch(e => notify(e.message, true)));
  $("branch-select").addEventListener("change", () => { branch = $("branch-select").value; refresh().catch(e => notify(e.message, true)); });
  $("close-dialog").addEventListener("click", () => $("action-dialog").close());
  $("close-receipt").addEventListener("click", () => $("receipt-dialog").close());
  $("print-receipt").addEventListener("click", () => window.print());
  $("menu-toggle").addEventListener("click", () => { const open = $("sidebar").classList.toggle("open"); $("menu-toggle").setAttribute("aria-expanded", String(open)); });
  document.addEventListener("keydown", event => { if (event.key === "Escape") { $("sidebar").classList.remove("open"); $("menu-toggle").setAttribute("aria-expanded", "false"); } });
  window.addEventListener("hashchange", () => { if (state) render(); });
  function theme(value) { document.documentElement.dataset.theme = value; $("theme-toggle").textContent = value === "dark" ? "Light theme" : "Dark theme"; }
  try { theme(localStorage.getItem("drivecore-hub-theme") === "dark" ? "dark" : "light"); }
  catch (e) { $("login-notice").textContent = `Theme storage unavailable: ${e.message}`; }
  $("theme-toggle").addEventListener("click", () => { const value = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; theme(value); try { localStorage.setItem("drivecore-hub-theme", value); } catch (e) { notify(`Theme was not saved: ${e.message}`, true); } });
  setInterval(() => {
    if (state && !document.hidden && !pending && !$("action-dialog").open && !$("receipt-dialog").open && !$("content").contains(document.activeElement)) refresh().catch(e => notify(`Live refresh failed: ${e.message}`, true));
  }, 15000);
  api("/api/me").then(async session => { csrf = session.csrf; await refresh(); }).catch(e => {
    if (e.message.includes("Backend unavailable")) { $("backend-help").hidden = false; $("login-form").hidden = true; }
    else if (!e.message.includes("Sign in")) $("login-notice").textContent = e.message;
  });
});
