"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, randomBytes } = require("node:crypto");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { openDatabase, bootstrap, passwordHash, roles } = require("./database");
const { identity, transact, snapshot, list } = require("./operations");
const { createServer } = require("./server");
const password = randomBytes(24).toString("hex");
const digest = passwordHash(password);
function setup() {
  const db = openDatabase(":memory:");
  const ids = {};
  for (const role of Object.keys(roles)) {
    const id = randomUUID(); ids[role] = id;
    db.prepare("INSERT INTO users(id,email,name,password,role,branches) VALUES(?,?,?,?,?,?)").run(id,
      `${Object.keys(ids).length}@example.test`, role, digest, role, JSON.stringify(role.includes("Corporate") ? ["north", "south", "central", "west"] : ["north"]));
  }
  const run = (role, action, input = {}, key = randomUUID()) => transact(db, ids[role] || role, action, { branch: "north", ...input }, key);
  const admin = "Corporate Operations Manager", custodian = "Stock Custodian", manager = "Hub Manager", clerk = "Sales Clerk", receptionist = "Service Receptionist", supervisor = "Service Supervisor";
  const customer = () => run(receptionist, "customer.create", { name: "Test Customer", contact: "test@example.test", vehicle: "Test car ABC123" });
  const receive = (quantity = 20) => run(custodian, "stock.receive", { product: "oil", quantity, reference: randomUUID(), reason: "Supplier delivery" });
  const order = c => run(clerk, "order.create", { customer: c.id, lines: [{ product: "oil", quantity: 2 }] });
  const stock = () => db.prepare("SELECT * FROM stock WHERE branch='north' AND product='oil'").get();
  const booking = (c, extra = {}) => run(receptionist, "booking.create", { customer: c.id, starts: "2030-10-08T09:00:00Z", duration: 60, bay: 1,
    technician: ids["Service Coordinator"], service: "Oil service", ...extra });
  return { db, ids, run, admin, manager, clerk, receptionist, supervisor, custodian, customer, receive, order, stock, booking };
}
test("all 15 hierarchical roles have explicit grants and never inherit blanket low-level approvals", () => {
  const f = setup();
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM roles").get().n, 15);
  for (const role of Object.keys(roles)) {
    const u = identity(f.db, f.ids[role]);
    if (u.level < 3) assert.ok(!u.grants.includes("approvals.manage"));
    if (u.level < 4) assert.ok(!u.grants.includes("employees.manage"));
  }
  f.db.close();
});
test("branch scope and role restrictions apply to mutations and returned records", () => {
  const f = setup(); f.customer();
  assert.throws(() => f.run(f.clerk, "stock.receive", { product: "oil", quantity: 5, reference: "test", reason: "test" }), /role/);
  assert.throws(() => f.run(f.manager, "announcement.create", { branch: "south", title: "Denied", message: "Denied" }), /Branch access/);
  const state = snapshot(f.db, identity(f.db, f.ids[f.clerk]), "north");
  assert.ok(!state.records.payments && !state.employees && !state.roles && !state.audit);
  assert.equal(state.locations.length, 16);
  assert.throws(() => snapshot(f.db, identity(f.db, f.ids[f.clerk]), "south"), /Branch access/);
  f.db.close();
});
test("stock reservation is transactional and failed multi-line orders leave no partial changes", () => {
  const f = setup(); f.receive(5); const c = f.customer();
  assert.throws(() => f.run(f.clerk, "order.create", { customer: c.id, lines: [{ product: "oil", quantity: 2 }, { product: "pads", quantity: 1 }] }), /Insufficient/);
  assert.equal(f.stock().reserved, 0); assert.equal(list(f.db, "orders", ["north"]).length, 0);
  f.order(c); assert.equal(f.stock().reserved, 2);
  assert.throws(() => f.run(f.custodian, "stock.issue", { product: "oil", quantity: 4, reference: "issue", reason: "test" }), /Insufficient/);
  assert.equal(f.stock().quantity, 5);
  f.db.close();
});
test("cash settlement consumes stock once and retries are idempotent", () => {
  const f = setup(); f.receive(); const o = f.order(f.customer()), key = randomUUID();
  const input = { id: o.id, version: o.version, amount: o.total, method: "Cash", reference: "Cash receipt 1" };
  const paid = f.run("Cashier", "payment.record", input, key);
  assert.equal(paid.status, "Paid"); assert.equal(f.stock().quantity, 18); assert.equal(f.stock().reserved, 0);
  assert.deepEqual(f.run("Cashier", "payment.record", input, key), paid);
  assert.equal(list(f.db, "payments", ["north"]).length, 1);
  assert.throws(() => f.run("Cashier", "payment.record", { ...input, amount: 1 }, key), /different operation/);
  assert.throws(() => f.run("Cashier", "payment.record", input), /not awaiting/);
  f.db.close();
});
test("non-cash records require verified external settlement and exact amount", () => {
  const f = setup(); f.receive(); const o = f.order(f.customer());
  const input = { id: o.id, version: 1, method: "Credit Card", amount: o.total, reference: "Provider settlement" };
  assert.throws(() => f.run("Cashier", "payment.record", input), /external settlement/);
  assert.throws(() => f.run("Cashier", "payment.record", { ...input, verified: true, amount: o.total - 1 }), /match/);
  assert.equal(f.stock().quantity, 20);
  f.run("Cashier", "payment.record", { ...input, verified: true });
  assert.equal(f.stock().quantity, 18);
  f.db.close();
});
test("stale payment versions roll back stock, payments and loyalty", () => {
  const f = setup(); f.receive(); const o = f.order(f.customer());
  assert.throws(() => f.run("Cashier", "payment.record", { id: o.id, version: 99, amount: o.total, method: "Cash", reference: "test" }), /changed/);
  assert.equal(f.stock().quantity, 20); assert.equal(f.stock().reserved, 2);
  assert.equal(list(f.db, "payments", ["north"]).length, 0);
  assert.equal(list(f.db, "customers", ["north"])[0].points, 0);
  f.db.close();
});
test("unpaid cancellation releases reservations and cannot be repeated", () => {
  const f = setup(); f.receive(); const o = f.order(f.customer());
  f.run(f.clerk, "order.cancel", { id: o.id, version: 1 }); assert.equal(f.stock().reserved, 0);
  assert.throws(() => f.run(f.clerk, "order.cancel", { id: o.id, version: 1 }), /unpaid/);
  f.db.close();
});
test("service labour can be sold and refunded without inventory movements", () => {
  const f = setup(), c = f.customer();
  const o = f.run(f.clerk, "order.create", { customer: c.id, lines: [{ product: "labour", quantity: 2 }] });
  assert.equal(o.total, 12000);
  const paid = f.run("Cashier", "payment.record", { id: o.id, version: o.version, amount: o.total, method: "Cash", reference: "labour-payment" });
  f.run("Cashier", "order.return", { id: o.id, version: paid.version, product: "labour", quantity: 2, disposition: "Restock", reason: "Service refund", reference: "labour-refund" });
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM movements").get().n, 0);
  assert.equal(list(f.db, "customers", ["north"])[0].points, 0);
  assert.throws(() => f.run(f.custodian, "stock.receive", { product: "labour", quantity: 1, reference: "test", reason: "test" }), /no physical stock/);
  f.db.close();
});
test("vehicles belong to their customers and warranties require actual paid purchases", () => {
  const f = setup(), c = f.customer(), other = f.customer();
  const v = f.run(f.receptionist, "vehicle.create", { customer: c.id, registration: "SECOND123", model: "Honda", year: 2020, mileage: 35000 });
  assert.throws(() => f.booking(other, { vehicleId: v.id }), /must belong/);
  assert.ok(f.booking(c, { vehicleId: v.id }).vehicle.includes("SECOND123"));
  f.receive(); const o = f.order(c);
  assert.throws(() => f.run(f.receptionist, "warranty.create", { order: o.id, product: "oil", expires: "2030-01-01", terms: "Supplier terms", reference: "WR1" }), /purchased item/);
  f.run("Cashier", "payment.record", { id: o.id, version: 1, amount: o.total, method: "Cash", reference: "receipt" });
  const w = f.run(f.receptionist, "warranty.create", { order: o.id, product: "oil", expires: "2030-01-01", terms: "Supplier terms", reference: "WR1" });
  assert.equal(w.customer, c.id);
  f.db.close();
});
test("catalogue changes are versioned and preserve order pricing snapshots", () => {
  const f = setup(); f.receive(); const o = f.order(f.customer());
  const p = f.db.prepare("SELECT * FROM products WHERE id='oil'").get();
  f.run("Inventory Controller", "product.save", { ...p, price: 9999 });
  assert.throws(() => f.run("Inventory Controller", "product.save", { ...p, price: 5000 }), /changed/);
  assert.equal(list(f.db, "orders", ["north"])[0].total, o.total);
  f.db.close();
});
test("FIFO aging and demand exclude damage/count adjustments and keep consistent balances", () => {
  const f = setup(); f.receive(20);
  const receipt = f.db.prepare("SELECT id FROM movements").get();
  f.db.prepare("UPDATE movements SET created=? WHERE id=?").run(new Date(Date.now() - 100 * 86400000).toISOString(), receipt.id);
  f.run(f.custodian, "stock.damage", { product: "oil", quantity: 1, reference: "damage", reason: "Defective" });
  let s = snapshot(f.db, identity(f.db, f.ids[f.manager]), "north").stock.find(s => s.product === "oil");
  assert.equal(s.age, 100); assert.equal(s.rate, 0); assert.equal(s.quantity, 19); assert.equal(s.quarantine, 1);
  const o = f.order(f.customer());
  f.run("Cashier", "payment.record", { id: o.id, version: 1, amount: o.total, method: "Cash", reference: "cash" });
  s = snapshot(f.db, identity(f.db, f.ids[f.manager]), "north").stock.find(s => s.product === "oil");
  assert.equal(s.rate, 2 / 30);
  f.db.close();
});
test("rack locations are branch-specific and shared catalogue defaults remain unchanged", () => {
  const f = setup();
  f.run("Inventory Controller", "stock.location", { product: "oil", shelf: "North-Rack-07" });
  const state = snapshot(f.db, identity(f.db, f.ids[f.clerk]), "north");
  assert.equal(state.locations.find(l => l.product === "oil" && l.branch === "north").shelf, "North-Rack-07");
  assert.equal(state.locations.find(l => l.product === "oil" && l.branch === "south").shelf, "A-01");
  assert.throws(() => f.run("Inventory Controller", "stock.location", { branch: "south", product: "oil", shelf: "Unauthorized" }), /Branch/);
  f.db.close();
});
test("returns cannot exceed purchases and defective returns do not become sellable", () => {
  const f = setup(); f.receive(); const c = f.customer(), o = f.order(c);
  const paid = f.run("Cashier", "payment.record", { id: o.id, version: 1, amount: o.total, method: "Cash", reference: "cash" });
  const returned = f.run("Cashier", "order.return", { id: o.id, version: paid.version, product: "oil", quantity: 1, disposition: "Defective", reason: "fault", reference: "refund" });
  assert.equal(f.stock().quantity, 18); assert.equal(f.stock().quarantine, 1);
  assert.equal(returned.status, "Partially Returned");
  assert.throws(() => f.run("Cashier", "order.return", { id: o.id, version: returned.version, product: "oil", quantity: 2, disposition: "Restock", reason: "fault", reference: "refund" }), /exceeds/);
  f.run("Cashier", "order.return", { id: o.id, version: returned.version, product: "oil", quantity: 1, disposition: "Restock", reason: "unused", reference: "refund2" });
  assert.equal(f.stock().quantity, 19); assert.equal(list(f.db, "customers", ["north"])[0].points, 0);
  f.db.close();
});
test("stock adjustments enforce separation, stable count baseline and reservation safety", () => {
  const f = setup(); f.receive(); const a = f.run("Inventory Controller", "stock.audit", { product: "oil", count: 12, reason: "Cycle count" });
  assert.throws(() => f.run(f.manager, "approval.decide", { id: a.id, version: 1, status: "Approved", branch: "south" }), /Branch/);
  f.receive(1);
  assert.throws(() => f.run(f.manager, "approval.decide", { id: a.id, version: 1, status: "Approved" }), /Stock changed/);
  const b = f.run(f.manager, "stock.audit", { product: "oil", count: 10, reason: "Cycle count" });
  assert.throws(() => f.run(f.manager, "approval.decide", { id: b.id, version: 1, status: "Approved" }), /Self-approval/);
  f.run(f.admin, "approval.decide", { id: b.id, version: 1, status: "Approved" });
  assert.equal(f.stock().quantity, 10);
  f.db.close();
});
test("transfers conserve inventory and require source approval/dispatch and destination receipt", () => {
  const f = setup(); f.receive();
  let t = f.run(f.custodian, "transfer.request", { destination: "south", product: "oil", quantity: 5, eta: "2030-10-09", reason: "Replenishment" });
  t = f.run(f.manager, "transfer.progress", { id: t.id, version: t.version, status: "Approved" });
  assert.equal(f.stock().reserved, 5);
  assert.throws(() => f.run(f.custodian, "transfer.progress", { id: t.id, version: t.version, status: "Received" }), /Branch/);
  t = f.run(f.custodian, "transfer.progress", { id: t.id, version: t.version, status: "Dispatched" });
  assert.equal(f.stock().quantity, 15); assert.equal(f.stock().reserved, 0);
  assert.equal(snapshot(f.db, identity(f.db, f.ids[f.admin]), "south").records.transfers[0].id, t.id);
  t = f.run(f.admin, "transfer.progress", { id: t.id, version: t.version, status: "Received", branch: "south" });
  assert.equal(f.db.prepare("SELECT quantity FROM stock WHERE branch='south' AND product='oil'").get().quantity, 5);
  assert.throws(() => f.run(f.admin, "transfer.progress", { id: t.id, version: t.version, status: "Received", branch: "south" }), /dispatched/);
  f.db.close();
});
test("attendance is self-scoped, server-timed and respects break transitions", () => {
  const f = setup();
  assert.throws(() => f.run(f.clerk, "attendance.punch", { employee: f.ids[f.manager], event: "Time In" }), /role/);
  f.run(f.clerk, "attendance.punch", { event: "Time In", timestamp: "1990-01-01" });
  assert.throws(() => f.run(f.clerk, "attendance.punch", { event: "Time In" }), /already/);
  f.run(f.clerk, "attendance.punch", { event: "Break Start" });
  assert.throws(() => f.run(f.clerk, "attendance.punch", { event: "Time Out" }), /End the active break/);
  f.run(f.clerk, "attendance.punch", { event: "Break End" });
  f.run(f.clerk, "attendance.punch", { event: "Time Out" });
  const entries = snapshot(f.db, identity(f.db, f.ids[f.clerk]), "north").records.attendance;
  assert.equal(entries.length, 1); assert.equal(entries[0].breaks.length, 1);
  assert.ok(entries[0].in.startsWith(new Date().toISOString().slice(0, 10)));
  f.db.close();
});
test("shift conflicts, invalid dates and leave self-approval are rejected", () => {
  const f = setup();
  const input = { employee: f.ids[f.clerk], starts: "2030-10-08T09:00:00Z", ends: "2030-10-08T17:00:00Z" };
  f.run(f.manager, "shift.create", input);
  assert.throws(() => f.run(f.manager, "shift.create", input), /Overlapping/);
  assert.throws(() => f.run(f.clerk, "leave.request", { starts: "2030-02-30", ends: "2030-03-01", reason: "test" }), /calendar/);
  const l = f.run(f.manager, "leave.request", { starts: "2030-10-09", ends: "2030-10-10", reason: "test" });
  assert.throws(() => f.run(f.manager, "leave.decide", { id: l.id, version: l.version, status: "Approved" }), /another authorized/);
  f.run(f.admin, "leave.decide", { id: l.id, version: l.version, status: "Approved" });
  f.db.close();
});
test("bookings reject overlapping bay/employee assignments and illegal states", () => {
  const f = setup(); const c = f.customer(), b = f.booking(c);
  assert.throws(() => f.booking(c, { bay: 2 }), /overlapping/);
  assert.throws(() => f.booking(c, { technician: f.ids[f.manager] }), /overlapping/);
  assert.throws(() => f.run(f.receptionist, "booking.status", { id: b.id, version: 1, status: "Completed" }), /Cannot change/);
  f.booking(c, { starts: "2030-10-08T10:00:00Z" });
  f.db.close();
});
test("appointments also reject employees double-booked in another branch", () => {
  const f = setup(), c = f.customer();
  f.booking(c, { technician: f.ids[f.admin] });
  const southCustomer = f.run(f.admin, "customer.create", { branch: "south", name: "South customer", contact: "south@example.test", vehicle: "South car" });
  assert.throws(() => f.run(f.admin, "booking.create", { branch: "south", customer: southCustomer.id, starts: "2030-10-08T09:00:00Z",
    duration: 60, bay: 2, technician: f.ids[f.admin], service: "Inspection" }), /overlapping/);
  assert.throws(() => f.booking(c, { starts: "2030-02-30T09:00:00Z" }), /calendar/);
  f.db.close();
});
test("service parts consume once, independent approval/QA are required and notices remain unsent", () => {
  const f = setup(); f.receive(); const b = f.booking(f.customer());
  f.run(f.receptionist, "booking.status", { id: b.id, version: b.version, status: "Waiting" });
  let t = f.run("Service Coordinator", "ticket.create", { booking: b.id, advisor: f.ids["Service Coordinator"], work: "Oil service", due: "2030-10-08T11:00:00Z" });
  t = f.run("Service Coordinator", "ticket.parts", { id: t.id, version: t.version, product: "oil", quantity: 1 });
  assert.equal(f.stock().reserved, 1);
  t = f.run("Service Coordinator", "ticket.status", { id: t.id, version: t.version, status: "Awaiting Approval" });
  assert.throws(() => f.run("Service Coordinator", "ticket.status", { id: t.id, version: t.version, status: "Under Repair" }), /role/);
  t = f.run(f.supervisor, "ticket.status", { id: t.id, version: t.version, status: "Under Repair" });
  assert.equal(f.stock().quantity, 19); assert.equal(f.stock().reserved, 0);
  t = f.run("Service Coordinator", "ticket.status", { id: t.id, version: t.version, status: "Quality Check" });
  assert.throws(() => f.run(f.supervisor, "ticket.status", { id: t.id, version: t.version, status: "Ready for Release" }), /Quality/);
  t = f.run(f.supervisor, "ticket.status", { id: t.id, version: t.version, status: "Ready for Release", note: "No leaks; test drive passed." });
  t = f.run("Service Coordinator", "ticket.status", { id: t.id, version: t.version, status: "Completed" });
  assert.equal(t.status, "Completed"); assert.equal(f.stock().quantity, 19);
  assert.equal(list(f.db, "bookings", ["north"])[0].status, "Completed");
  assert.ok(list(f.db, "notifications", ["north"]).every(n => n.status === "Pending integration" && n.channel === "Not sent"));
  f.db.close();
});
test("password changes revoke sessions without retaining plaintext in idempotency or audit data", () => {
  const f = setup(), id = f.ids[f.clerk], next = randomBytes(24).toString("hex");
  f.db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(randomBytes(32).toString("hex"), id, "csrf", Date.now() + 10000);
  f.run(f.clerk, "password.change", { current: password, password: next });
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id=?").get(id).n, 0);
  assert.ok(!JSON.stringify(f.db.prepare("SELECT * FROM requests").all()).includes(next));
  assert.ok(!JSON.stringify(f.db.prepare("SELECT * FROM audit").all()).includes(password));
  f.db.close();
});
test("service work orders prevent orphaned cancellations", () => {
  const f = setup(); const b = f.booking(f.customer());
  f.run("Service Coordinator", "ticket.create", { booking: b.id, advisor: f.ids[f.receptionist], work: "Inspect", due: "2030-10-08T11:00:00Z" });
  assert.throws(() => f.run(f.receptionist, "booking.status", { id: b.id, version: 1, status: "Cancelled" }), /work order/);
  f.db.close();
});
test("priority queue requires supervisor authority and one active entry per customer/employee", () => {
  const f = setup(); const c = f.customer(), c2 = f.customer();
  assert.throws(() => f.run(f.receptionist, "queue.join", { customer: c.id, priority: true }), /role/);
  f.run(f.receptionist, "queue.join", { customer: c.id });
  f.run(f.supervisor, "queue.join", { customer: c2.id, priority: true });
  assert.throws(() => f.run(f.receptionist, "queue.join", { customer: c.id }), /already/);
  const next = f.run(f.receptionist, "queue.next", { technician: f.ids["Service Coordinator"] });
  assert.equal(next.customer, c2.id);
  assert.throws(() => f.run(f.receptionist, "queue.next", { technician: f.ids["Service Coordinator"] }), /already serving/);
  f.run(f.receptionist, "queue.finish", { id: next.id, version: next.version });
  assert.equal(f.run(f.receptionist, "queue.next", { technician: f.ids["Service Coordinator"] }).customer, c.id);
  f.db.close();
});
test("hierarchy prevents self-escalation and corporate can provision regional managers", () => {
  const f = setup();
  const input = { name: "Regional User", email: "regional@example.test", role: "Regional Manager", branches: ["south"], password };
  assert.throws(() => f.run(f.manager, "employee.save", input), /lower-level/);
  const regional = f.run(f.admin, "employee.save", input);
  assert.equal(identity(f.db, regional.id).role, "Regional Manager");
  assert.throws(() => f.run(f.admin, "employee.save", { ...input, id: f.ids[f.admin], role: f.clerk }), /outside/);
  assert.throws(() => f.run(f.manager, "role.save", { role: f.clerk, grants: ["approvals.manage"] }), /role/);
  assert.throws(() => f.run(f.admin, "role.save", { role: f.clerk, grants: ["approvals.manage"] }), /hierarchy/);
  f.run(f.admin, "role.save", { role: f.clerk, grants: ["inventory.view"] });
  assert.throws(() => f.run(f.clerk, "order.create", { customer: "anything", lines: [] }), /role/);
  const requests = f.db.prepare("SELECT input FROM requests").all();
  assert.ok(requests.every(r => !r.input.includes(password) && /^[a-f0-9]{64}$/.test(r.input)));
  f.db.close();
});
test("idempotency replies cannot bypass later branch/permission revocations", () => {
  const f = setup(), key = randomUUID(), input = { customer: f.customer().id };
  f.run(f.receptionist, "queue.join", input, key);
  f.db.prepare("UPDATE users SET branches=? WHERE id=?").run(JSON.stringify(["south"]), f.ids[f.receptionist]);
  assert.throws(() => f.run(f.receptionist, "queue.join", input, key), /Branch/);
  f.db.close();
});
test("SQLite records, role grants and audit persist across reopening", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "drivecore-hub-")), file = path.join(directory, "hub.sqlite");
  try {
    let db = openDatabase(file); bootstrap(db, "bootstrap@example.test", password);
    const user = db.prepare("SELECT id FROM users").get();
    transact(db, user.id, "announcement.create", { branch: "north", title: "Persistent", message: "SQLite persisted" }, randomUUID());
    db.close(); db = openDatabase(file);
    assert.equal(list(db, "announcements", ["north"])[0].title, "Persistent");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit").get().n, 1);
    assert.equal(bootstrap(db, undefined, undefined), false); db.close();
  } finally { rmSync(directory, { recursive: true }); }
});
test("HTTP enforces authentication, origin, CSRF, scoped reports and session revocation", async () => {
  const f = setup(), origin = "http://127.0.0.1", server = createServer(f.db, { origin });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, value, headers = {}) => fetch(base + route, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(value) });
  try {
    assert.equal((await fetch(base + "/api/state")).status, 401);
    const email = f.db.prepare("SELECT email FROM users WHERE id=?").get(f.ids[f.manager]).email;
    assert.equal((await post("/api/login", { email, password }, { Origin: "https://evil.example" })).status, 403);
    const login = await post("/api/login", { email, password });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0], session = await login.json();
    assert.ok(login.headers.get("set-cookie").includes("HttpOnly"));
    const headers = { Cookie: cookie, "X-CSRF-Token": session.csrf, "Idempotency-Key": randomUUID() };
    assert.equal((await post("/api/action", { action: "announcement.create", input: { branch: "north", title: "test", message: "test" } }, { Cookie: cookie })).status, 403);
    assert.equal((await fetch(base + "/api/state?branch=south", { headers: { Cookie: cookie } })).status, 403);
    assert.equal((await fetch(base + "/api/report?type=sales&branch=south", { headers: { Cookie: cookie } })).status, 403);
    const csv = await fetch(base + "/api/report?type=sales&branch=north", { headers: { Cookie: cookie } });
    assert.equal(csv.status, 200); assert.ok((await csv.text()).includes("North London Hub"));
    assert.equal((await fetch(base + "/api/report?type=sales&branch=north&start=2030-02-30", { headers: { Cookie: cookie } })).status, 400);
    assert.equal((await fetch(base + "/api/report?type=sales&format=pdf", { headers: { Cookie: cookie } })).status, 400);
    const duplicateEmail = f.db.prepare("SELECT email FROM users WHERE id=?").get(f.ids[f.clerk]).email;
    assert.equal((await post("/api/action", { action: "employee.save", input: { branch: "north", name: "Duplicate", email: duplicateEmail,
      role: f.clerk, password, branches: ["north"] } }, headers)).status, 409);
    assert.equal((await fetch(base + "/hub-server/database.js")).status, 404);
    assert.equal((await fetch(base + "/hub-server/data/hub.sqlite")).status, 404);
    assert.equal((await fetch(base + "/.env")).status, 404);
    assert.equal((await post("/api/logout", {}, headers)).status, 200);
    assert.equal((await fetch(base + "/api/me", { headers: { Cookie: cookie } })).status, 401);
  } finally { await new Promise(resolve => server.close(resolve)); f.db.close(); }
});
test("failed login throttling locks account and deactivation invalidates existing sessions", async () => {
  const f = setup(), server = createServer(f.db, { origin: "http://127.0.0.1" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  const email = f.db.prepare("SELECT email FROM users WHERE id=?").get(f.ids[f.manager]).email;
  const login = p => fetch(base + "/api/login", { method: "POST", headers: { Origin: "http://127.0.0.1", "Content-Type": "application/json" }, body: JSON.stringify({ email, password: p }) });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await login("incorrect")).status, 401);
    assert.equal((await login(password)).status, 401);
    f.db.prepare("UPDATE users SET locked_until=0,failures=0 WHERE id=?").run(f.ids[f.manager]);
    const response = await login(password), cookie = response.headers.get("set-cookie").split(";")[0];
    f.db.prepare("UPDATE users SET active=0 WHERE id=?").run(f.ids[f.manager]);
    assert.equal((await fetch(base + "/api/me", { headers: { Cookie: cookie } })).status, 401);
  } finally { await new Promise(resolve => server.close(resolve)); f.db.close(); }
});
