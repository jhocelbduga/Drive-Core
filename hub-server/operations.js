"use strict";

const { randomUUID, createHash } = require("node:crypto");
const { passwordHash, permissions } = require("./database");
class Problem extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fail(message, status = 400) { throw new Problem(status, message); }
function text(value, label, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail(`${label} is required (maximum ${max} characters).`);
  return value.trim();
}
function integer(value, label, min = 0, max = 100000000) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} must be an integer between ${min} and ${max}.`);
  return value;
}
function date(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value) fail("A valid calendar date is required.");
  return value;
}
function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) || !Number.isFinite(Date.parse(value))) fail("A valid appointment timestamp is required.");
  date(value.slice(0, 10));
  return new Date(value).toISOString();
}
function requirePermission(user, permission) { if (!user.grants.includes(permission)) fail("Your role does not allow this operation.", 403); }
function scope(user, branch) { if (!user.branches.includes(branch)) fail("Branch access denied.", 403); return branch; }
function identity(db, id) {
  const u = db.prepare("SELECT u.*, r.level, r.grants FROM users u JOIN roles r ON u.role=r.name WHERE u.id=? AND u.active=1").get(id);
  if (!u) fail("Session is no longer authorized.", 401);
  return { id: u.id, name: u.name, email: u.email, role: u.role, level: u.level, branches: JSON.parse(u.branches), grants: JSON.parse(u.grants) };
}
function record(row) { return { ...JSON.parse(row.body), id: row.id, branch: row.branch, version: row.version, created: row.created, updated: row.updated }; }
function list(db, kind, branches) {
  return db.prepare("SELECT * FROM records WHERE kind=? ORDER BY created DESC").all(kind).filter(r => branches.includes(r.branch)).map(record);
}
function get(db, kind, id, user) {
  const row = db.prepare("SELECT * FROM records WHERE kind=? AND id=?").get(kind, text(id, "Record ID"));
  if (!row) fail("Record not found.", 404);
  if (user) scope(user, row.branch);
  return record(row);
}
function create(db, kind, branch, body) {
  const id = randomUUID(), now = new Date().toISOString();
  db.prepare("INSERT INTO records(id,kind,branch,body,created,updated) VALUES(?,?,?,?,?,?)").run(id, kind, branch, JSON.stringify(body), now, now);
  return get(db, kind, id);
}
function update(db, kind, item, body, version) {
  if (version !== item.version) fail("This record changed. Refresh and try again.", 409);
  const { id, branch, created, updated, version: oldVersion, ...previous } = item;
  const changed = db.prepare("UPDATE records SET body=?, version=version+1, updated=? WHERE id=? AND kind=? AND version=?")
    .run(JSON.stringify({ ...previous, ...body }), new Date().toISOString(), id, kind, oldVersion).changes;
  if (!changed) fail("Concurrent update rejected.", 409);
  return get(db, kind, id);
}
function audit(db, user, branch, action, target, details) {
  db.prepare("INSERT INTO audit(actor,branch,action,target,details,created) VALUES(?,?,?,?,?,?)")
    .run(user.id, branch || null, action, target || "", JSON.stringify(details), new Date().toISOString());
}
function product(db, id) {
  const p = db.prepare("SELECT * FROM products WHERE id=? AND active=1").get(text(id, "Product"));
  if (!p) fail("Active product not found.", 404);
  return p;
}
function move(db, user, branch, p, quantity, reason, reference) {
  const changed = db.prepare("UPDATE stock SET quantity=quantity+? WHERE branch=? AND product=? AND quantity+? >= reserved")
    .run(quantity, branch, p, quantity).changes;
  if (!changed) fail("Insufficient unreserved inventory.", 409);
  db.prepare("INSERT INTO movements VALUES(?,?,?,?,?,?,?,?)")
    .run(randomUUID(), branch, p, quantity, reason, reference, user.id, new Date().toISOString());
}
function reserve(db, branch, p, quantity) {
  if (!db.prepare("UPDATE stock SET reserved=reserved+? WHERE branch=? AND product=? AND reserved+? BETWEEN 0 AND quantity")
    .run(quantity, branch, p, quantity).changes) fail("Insufficient available stock for reservation.", 409);
}
function employee(db, id, branch) {
  const u = db.prepare("SELECT id,name,branches,active FROM users WHERE id=?").get(text(id, "Employee"));
  if (!u || !u.active || !JSON.parse(u.branches).includes(branch)) fail("Employee must be active and assigned to this branch.");
  return u;
}
const bookingTransitions = {
  Confirmed: ["Waiting", "Cancelled", "No Show"], Waiting: ["In Progress", "Cancelled"],
  "In Progress": ["Completed"], Completed: [], Cancelled: [], "No Show": []
};
const ticketTransitions = {
  "Pending Inspection": ["Waiting for Parts", "Awaiting Approval"],
  "Waiting for Parts": ["Awaiting Approval"], "Awaiting Approval": ["Under Repair"],
  "Under Repair": ["Quality Check"], "Quality Check": ["Under Repair", "Ready for Release"],
  "Ready for Release": ["Completed"], Completed: []
};
const actionPermissions = {
  "product.save": "catalogue.manage", "stock.receive": "inventory.move", "stock.issue": "inventory.move",
  "stock.damage": "inventory.move", "stock.audit": "inventory.manage", "transfer.request": "transfers.manage",
  "transfer.progress": "transfers.manage", "approval.decide": "approvals.manage", "customer.create": "customers.manage",
  "customer.note": "customers.manage", "order.create": "sales.create", "order.cancel": "sales.create",
  "payment.record": "payments.manage", "order.return": "payments.manage", "attendance.punch": "attendance.self",
  "shift.create": "attendance.manage", "leave.request": "attendance.self", "leave.decide": "attendance.manage",
  "booking.create": "bookings.manage", "booking.status": "bookings.manage", "booking.assign": "bookings.manage",
  "ticket.create": "tickets.manage", "ticket.parts": "tickets.manage", "ticket.status": "tickets.manage",
  "queue.join": "queue.manage", "queue.next": "queue.manage", "queue.finish": "queue.manage",
  "announcement.create": "announcements.manage", "employee.save": "employees.manage", "role.save": "roles.manage",
  "password.change": "attendance.self", "vehicle.create": "customers.manage", "warranty.create": "customers.manage",
  "stock.location": "inventory.manage"
};
function administerRole(user, role) {
  return role.level < user.level || (user.role === "Corporate Operations Manager" && role.name !== user.role);
}
function transition(item, value, transitions) {
  if (!(transitions[item.status] || []).includes(value)) fail(`Cannot change ${item.status} to ${value}.`, 409);
}
function scheduleCheck(db, branch, starts, duration, bay, technician, except) {
  const end = Date.parse(starts) + duration * 60000;
  const clashes = list(db, "bookings", db.prepare("SELECT id FROM branches").all().map(b => b.id)).some(b => b.id !== except && !["Completed", "Cancelled", "No Show"].includes(b.status) &&
    Date.parse(b.starts) < end && Date.parse(b.starts) + b.duration * 60000 > Date.parse(starts) &&
    (b.branch === branch && b.bay === bay || b.technician === technician));
  if (clashes) fail("The selected bay or technician already has an overlapping booking.", 409);
}
function execute(db, user, action, input) {
  const branch = scope(user, input.branch);
  const now = new Date().toISOString();
  let result;
  switch (action) {
    case "product.save": {
      requirePermission(user, "catalogue.manage");
      const kind = input.kind || "Part";
      if (!["Part", "Accessory", "Service"].includes(kind)) fail("Invalid catalogue type.");
      const values = [text(input.name, "Name"), text(input.sku, "SKU", 50), integer(input.price, "Price in pennies"),
        integer(input.cost, "Cost in pennies"), integer(input.reorder, "Reorder threshold", 0, 100000), text(input.shelf, "Rack/shelf", 50)];
      if (input.id) {
        const p = product(db, input.id);
        if (p.version !== input.version) fail("Catalogue product changed. Refresh before editing.", 409);
        if (kind !== p.kind) fail("Catalogue item type cannot be changed after creation.");
        db.prepare("UPDATE products SET name=?,sku=?,price=?,cost=?,reorder=?,shelf=?,version=version+1 WHERE id=?").run(...values, input.id);
        result = { id: input.id };
      } else {
        const id = randomUUID();
        db.prepare("INSERT INTO products(id,name,sku,price,cost,reorder,shelf,kind) VALUES(?,?,?,?,?,?,?,?)").run(id, ...values, kind);
        if (kind !== "Service") for (const b of db.prepare("SELECT id FROM branches").all()) db.prepare("INSERT INTO stock(branch,product) VALUES(?,?)").run(b.id, id);
        result = { id };
      }
      break;
    }
    case "stock.receive":
    case "stock.issue":
    case "stock.damage": {
      requirePermission(user, "inventory.move");
      const p = product(db, input.product), q = integer(input.quantity, "Quantity", 1, 100000);
      if (p.kind === "Service") fail("Service catalogue items have no physical stock.");
      const reference = text(input.reference, "Supplier/delivery or transaction reference");
      const reason = text(input.reason, "Reason");
      if (action === "stock.receive" && db.prepare("SELECT id FROM movements WHERE branch=? AND product=? AND reference=? AND reason LIKE 'stock.receive:%'").get(branch, p.id, reference)) fail("This product/delivery reference was already received. Use the original idempotency key to retry.", 409);
      move(db, user, branch, p.id, action === "stock.receive" ? q : -q, `${action}: ${reason}`, reference);
      if (action === "stock.damage") db.prepare("UPDATE stock SET quarantine=quarantine+? WHERE branch=? AND product=?").run(q, branch, p.id);
      result = { product: p.id, quantity: q };
      break;
    }
    case "stock.audit": {
      requirePermission(user, "inventory.manage");
      const p = product(db, input.product), count = integer(input.count, "Physical count", 0, 100000);
      if (p.kind === "Service") fail("Service catalogue items have no inventory.");
      const balance = db.prepare("SELECT * FROM stock WHERE branch=? AND product=?").get(branch, p.id);
      result = create(db, "approvals", branch, { type: "adjustment", product: p.id, count, baseline: balance.quantity,
        delta: count - balance.quantity, reason: text(input.reason, "Count/adjustment reason"), requester: user.id, status: "Pending" });
      break;
    }
    case "stock.location": {
      requirePermission(user, "inventory.manage");
      const p = product(db, input.product), shelf = text(input.shelf, "Rack / shelf", 50);
      if (!db.prepare("UPDATE stock SET shelf=? WHERE branch=? AND product=?").run(shelf, branch, p.id).changes) fail("Product has no stock position at this branch.", 404);
      result = { product: p.id, shelf };
      break;
    }
    case "transfer.request": {
      requirePermission(user, "transfers.manage");
      if (product(db, input.product).kind === "Service") fail("Service catalogue items cannot be transferred.");
      if (input.destination === branch || !db.prepare("SELECT id FROM branches WHERE id=?").get(text(input.destination, "Destination"))) fail("Select a different destination branch.");
      const quantity = integer(input.quantity, "Quantity", 1, 100000);
      result = create(db, "transfers", branch, { product: input.product, destination: input.destination, quantity,
        eta: date(input.eta), requester: user.id, status: "Requested", reason: text(input.reason, "Transfer reason") });
      break;
    }
    case "transfer.progress": {
      const t = get(db, "transfers", input.id);
      if (input.status === "Approved") {
        scope(user, t.branch); requirePermission(user, "approvals.manage");
        if (t.requester === user.id) fail("A different authorized employee must approve this transfer.", 403);
        if (t.status !== "Requested") fail("Transfer is not awaiting approval.", 409);
        reserve(db, t.branch, t.product, t.quantity);
      } else if (input.status === "Dispatched") {
        scope(user, t.branch); requirePermission(user, "transfers.manage");
        if (t.status !== "Approved") fail("Transfer must be approved before dispatch.", 409);
        reserve(db, t.branch, t.product, -t.quantity);
        move(db, user, t.branch, t.product, -t.quantity, "Transfer dispatch", t.id);
      } else if (input.status === "Received") {
        scope(user, t.destination); requirePermission(user, "transfers.manage");
        if (t.status !== "Dispatched") fail("Only dispatched stock can be received.", 409);
        move(db, user, t.destination, t.product, t.quantity, "Transfer receipt", t.id);
      } else if (input.status === "Rejected") {
        scope(user, t.branch); requirePermission(user, "approvals.manage");
        if (t.status !== "Requested") fail("Only requested transfers can be rejected.", 409);
      } else fail("Invalid transfer transition.");
      if (branch !== (input.status === "Received" ? t.destination : t.branch)) fail("Select the branch handling this transfer.");
      result = update(db, "transfers", t, { status: input.status }, input.version);
      break;
    }
    case "approval.decide": {
      requirePermission(user, "approvals.manage");
      const a = get(db, "approvals", input.id, user);
      if (a.branch !== branch || a.status !== "Pending") fail("Approval is not pending at this branch.", 409);
      if (a.requester === user.id) fail("Self-approval is prohibited.", 403);
      if (!["Approved", "Rejected"].includes(input.status)) fail("Choose approve or reject.");
      if (input.status === "Approved" && a.type === "adjustment") {
        const balance = db.prepare("SELECT quantity FROM stock WHERE branch=? AND product=?").get(branch, a.product);
        if (balance.quantity !== a.baseline) fail("Stock changed since the count. Reject this request and recount.", 409);
        move(db, user, branch, a.product, a.delta, "Approved physical count", a.id);
      }
      result = update(db, "approvals", a, { status: input.status, approver: user.id }, input.version);
      break;
    }
    case "customer.create": {
      requirePermission(user, "customers.manage");
      result = create(db, "customers", branch, { name: text(input.name, "Customer"), contact: text(input.contact, "Contact", 120),
        vehicle: text(input.vehicle, "Vehicle and registration"), notes: input.notes ? text(input.notes, "Notes", 1000) : "", points: 0, tier: "Standard" });
      break;
    }
    case "customer.note": {
      requirePermission(user, "customers.manage");
      const c = get(db, "customers", input.id, user);
      if (c.branch !== branch) fail("Select the customer's branch.");
      result = update(db, "customers", c, { notes: text(input.notes, "Customer note / complaint", 1000), complaint: input.complaint === true }, input.version);
      break;
    }
    case "vehicle.create": {
      requirePermission(user, "customers.manage");
      const c = get(db, "customers", input.customer, user);
      if (c.branch !== branch) fail("Customer belongs to another branch.");
      result = create(db, "vehicles", branch, { customer: c.id, registration: text(input.registration, "Registration", 50),
        model: text(input.model, "Make / model"), year: integer(input.year, "Model year", 1900, new Date().getUTCFullYear() + 1),
        mileage: integer(input.mileage, "Odometer in km", 0, 10000000), vin: input.vin ? text(input.vin, "VIN", 30) : "" });
      break;
    }
    case "warranty.create": {
      requirePermission(user, "customers.manage");
      const order = get(db, "orders", input.order, user);
      if (order.branch !== branch || !order.paidAt || !order.lines.some(l => l.product === input.product)) fail("Warranty must reference a purchased item at this branch.");
      const expires = date(input.expires);
      if (expires < order.paidAt.slice(0, 10)) fail("Warranty expires before purchase.");
      result = create(db, "warranties", branch, { customer: order.customer, order: order.id, product: input.product,
        expires, terms: text(input.terms, "Supplier warranty terms", 1000), reference: text(input.reference, "Warranty reference") });
      break;
    }
    case "order.create": {
      requirePermission(user, "sales.create");
      const customer = get(db, "customers", input.customer, user);
      if (customer.branch !== branch) fail("Customer belongs to a different branch.");
      if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 50) fail("Order needs 1 to 50 lines.");
      const ids = new Set();
      const lines = input.lines.map(line => {
        const p = product(db, line.product), quantity = integer(line.quantity, "Quantity", 1, 1000);
        if (ids.has(p.id)) fail("Combine duplicate product lines."); ids.add(p.id);
        if (p.kind !== "Service") reserve(db, branch, p.id, quantity);
        return { product: p.id, name: p.name, kind: p.kind, quantity, price: p.price, cost: p.cost, returned: 0 };
      });
      const total = lines.reduce((n, l) => n + l.quantity * l.price, 0);
      result = create(db, "orders", branch, { customer: customer.id, lines, total, status: "Awaiting Payment", channel: input.channel === "Kiosk" ? "Kiosk" : "POS", creator: user.id });
      break;
    }
    case "order.cancel": {
      requirePermission(user, "sales.create");
      const order = get(db, "orders", input.id, user);
      if (order.branch !== branch || order.status !== "Awaiting Payment") fail("Only unpaid orders can be cancelled at this branch.", 409);
      for (const l of order.lines) if (l.kind !== "Service") reserve(db, branch, l.product, -l.quantity);
      result = update(db, "orders", order, { status: "Cancelled" }, input.version);
      break;
    }
    case "payment.record": {
      requirePermission(user, "payments.manage");
      const order = get(db, "orders", input.id, user);
      if (order.branch !== branch || order.status !== "Awaiting Payment") fail("Order is not awaiting payment at this branch.", 409);
      const methods = ["Cash", "Debit Card", "Credit Card", "E-Wallet", "Bank Transfer"];
      if (!methods.includes(input.method)) fail("Unsupported payment method.");
      if (integer(input.amount, "Received amount in pennies") !== order.total) fail("Payment must match the order total.");
      const reference = text(input.reference, "Receipt or external settlement reference");
      if (input.method !== "Cash" && input.verified !== true) fail("Confirm external settlement before recording this payment. DriveCore does not charge cards.");
      for (const l of order.lines) {
        if (l.kind !== "Service") {
          reserve(db, branch, l.product, -l.quantity);
          move(db, user, branch, l.product, -l.quantity, "Paid sale", order.id);
        }
      }
      const payment = create(db, "payments", branch, { order: order.id, method: input.method, amount: order.total, reference, cashier: user.id });
      result = update(db, "orders", order, { status: "Paid", receipt: payment.id, paidAt: now }, input.version);
      const c = get(db, "customers", order.customer);
      const points = c.points + Math.floor(order.total / 100);
      update(db, "customers", c, { points, tier: points >= 1000 ? "Gold" : points >= 250 ? "Silver" : "Standard" }, c.version);
      break;
    }
    case "order.return": {
      requirePermission(user, "payments.manage");
      const order = get(db, "orders", input.id, user);
      if (order.branch !== branch || !["Paid", "Partially Returned", "Returned"].includes(order.status)) fail("Select a paid order at this branch.");
      const lines = order.lines.map(l => ({ ...l })), line = lines.find(l => l.product === input.product);
      const q = integer(input.quantity, "Return quantity", 1, 1000);
      if (!line || q > line.quantity - line.returned) fail("Return exceeds unreturned purchased quantity.");
      if (!["Restock", "Defective", "Damaged"].includes(input.disposition)) fail("Select return disposition.");
      const refundReference = text(input.reference, "External refund / cash refund reference");
      if (line.kind !== "Service") {
        if (input.disposition === "Restock") move(db, user, branch, line.product, q, "Customer return", order.id);
        else db.prepare("UPDATE stock SET quarantine=quarantine+? WHERE branch=? AND product=?").run(q, branch, line.product);
      }
      line.returned += q;
      create(db, "returns", branch, { order: order.id, product: line.product, quantity: q, amount: q * line.price,
        disposition: input.disposition, reason: text(input.reason, "Return reason"), reference: refundReference });
      result = update(db, "orders", order, { lines, status: lines.every(l => l.returned === l.quantity) ? "Returned" : "Partially Returned" }, input.version);
      const before = Math.floor(order.lines.reduce((n, l) => n + (l.quantity - l.returned) * l.price, 0) / 100);
      const after = Math.floor(lines.reduce((n, l) => n + (l.quantity - l.returned) * l.price, 0) / 100);
      const c = get(db, "customers", order.customer), points = Math.max(0, c.points - (before - after));
      update(db, "customers", c, { points, tier: points >= 1000 ? "Gold" : points >= 250 ? "Silver" : "Standard" }, c.version);
      break;
    }
    case "attendance.punch": {
      requirePermission(user, "attendance.self");
      const employeeId = input.employee || user.id;
      if (employeeId !== user.id) requirePermission(user, "attendance.manage");
      employee(db, employeeId, branch);
      const open = list(db, "attendance", user.branches).find(a => a.employee === employeeId && !a.out);
      if (input.event === "Time In") {
        if (open) fail("Employee is already clocked in.", 409);
        result = create(db, "attendance", branch, { employee: employeeId, in: now, out: null, breaks: [], breakStart: null, source: "Web attendance" });
      } else {
        if (!open || open.branch !== branch) fail("No open attendance at this branch.", 409);
        if (input.event === "Break Start") {
          if (open.breakStart) fail("Break already started.", 409);
          result = update(db, "attendance", open, { breakStart: now }, open.version);
        } else if (input.event === "Break End") {
          if (!open.breakStart) fail("No active break.", 409);
          result = update(db, "attendance", open, { breakStart: null, breaks: [...open.breaks, { start: open.breakStart, end: now }] }, open.version);
        } else if (input.event === "Time Out") {
          if (open.breakStart) fail("End the active break before clocking out.", 409);
          result = update(db, "attendance", open, { out: now }, open.version);
        } else fail("Invalid attendance event.");
      }
      break;
    }
    case "shift.create": {
      requirePermission(user, "attendance.manage");
      employee(db, input.employee, branch);
      const starts = timestamp(input.starts), ends = timestamp(input.ends);
      if (Date.parse(ends) <= Date.parse(starts) || Date.parse(ends) - Date.parse(starts) > 24 * 3600000) fail("Shift must last between 1 minute and 24 hours.");
      if (list(db, "shifts", user.branches).some(s => s.employee === input.employee && Date.parse(s.starts) < Date.parse(ends) && Date.parse(s.ends) > Date.parse(starts))) fail("Overlapping employee shift.", 409);
      result = create(db, "shifts", branch, { employee: input.employee, starts, ends });
      break;
    }
    case "leave.request": {
      requirePermission(user, "attendance.self");
      const starts = date(input.starts), ends = date(input.ends);
      if (ends < starts) fail("Leave end must be on or after start.");
      result = create(db, "leaves", branch, { employee: user.id, starts, ends, reason: text(input.reason, "Leave reason"), status: "Pending" });
      break;
    }
    case "leave.decide": {
      requirePermission(user, "attendance.manage");
      const l = get(db, "leaves", input.id, user);
      if (l.branch !== branch || l.status !== "Pending" || l.employee === user.id) fail("Leave requires another authorized manager and pending status.", 403);
      if (!["Approved", "Rejected"].includes(input.status)) fail("Choose approve or reject.");
      result = update(db, "leaves", l, { status: input.status, approver: user.id }, input.version);
      break;
    }
    case "booking.create": {
      requirePermission(user, "bookings.manage");
      const c = get(db, "customers", input.customer, user);
      if (c.branch !== branch) fail("Customer belongs to another branch.");
      employee(db, input.technician, branch);
      const starts = timestamp(input.starts), duration = integer(input.duration, "Duration in minutes", 15, 480), bay = integer(input.bay, "Bay", 1, 4);
      if (db.prepare("SELECT kind FROM branches WHERE id=?").get(branch).kind === "Warehouse") fail("This warehouse has no service bays.");
      scheduleCheck(db, branch, starts, duration, bay, input.technician);
      const vehicle = input.vehicleId ? get(db, "vehicles", input.vehicleId, user) : null;
      if (vehicle && vehicle.customer !== c.id) fail("Vehicle must belong to the selected customer.");
      result = create(db, "bookings", branch, { customer: c.id, vehicle: vehicle ? `${vehicle.model} / ${vehicle.registration}` : c.vehicle, service: text(input.service, "Service"), starts,
        duration, bay, technician: input.technician, status: "Confirmed" });
      break;
    }
    case "booking.status": {
      requirePermission(user, "bookings.manage");
      const b = get(db, "bookings", input.id, user);
      if (b.branch !== branch) fail("Select the booking branch.");
      transition(b, input.status, bookingTransitions);
      if (["Cancelled", "No Show"].includes(input.status) && list(db, "tickets", [branch]).some(t => t.booking === b.id)) fail("A booking with a work order cannot be cancelled or marked no-show. Complete the service workflow.", 409);
      if (input.status === "In Progress") {
        if (list(db, "bookings", db.prepare("SELECT id FROM branches").all().map(row => row.id)).some(other => other.id !== b.id && other.status === "In Progress" &&
          (other.branch === branch && other.bay === b.bay || other.technician === b.technician))) fail("This bay or employee is still occupied by an ongoing service.", 409);
      }
      if (input.status === "Completed" && list(db, "tickets", [branch]).some(t => t.booking === b.id && t.status !== "Completed")) fail("Complete the linked service ticket first.", 409);
      result = update(db, "bookings", b, { status: input.status }, input.version);
      break;
    }
    case "booking.assign": {
      requirePermission(user, "bookings.manage");
      const b = get(db, "bookings", input.id, user);
      if (b.branch !== branch || ["Completed", "Cancelled", "No Show"].includes(b.status)) fail("Cannot reassign this booking.");
      employee(db, input.technician, branch);
      const bay = integer(input.bay, "Bay", 1, 4);
      scheduleCheck(db, branch, b.starts, b.duration, bay, input.technician, b.id);
      const ticket = list(db, "tickets", [branch]).find(t => t.booking === b.id);
      if (ticket && ticket.status !== "Completed") {
        if (ticket.approvedBy || ticket.consumed) fail("Cannot reassign an approved repair. Finish the work order first.", 409);
        update(db, "tickets", ticket, { technician: input.technician }, ticket.version);
      }
      result = update(db, "bookings", b, { technician: input.technician, bay }, input.version);
      break;
    }
    case "ticket.create": {
      requirePermission(user, "tickets.manage");
      const b = get(db, "bookings", input.booking, user);
      if (b.branch !== branch || ["Completed", "Cancelled", "No Show"].includes(b.status)) fail("Select an active booking.");
      if (list(db, "tickets", [branch]).some(t => t.booking === b.id)) fail("Booking already has a ticket.", 409);
      employee(db, input.advisor, branch);
      result = create(db, "tickets", branch, { booking: b.id, customer: b.customer, vehicle: b.vehicle, technician: b.technician,
        advisor: input.advisor, work: text(input.work, "Work order", 1000), due: timestamp(input.due),
        status: "Pending Inspection", parts: [], consumed: false, approvedBy: null, qualityBy: null });
      break;
    }
    case "ticket.parts": {
      requirePermission(user, "tickets.manage");
      const t = get(db, "tickets", input.id, user);
      if (t.branch !== branch || t.consumed || t.approvedBy) fail("Parts can only be added before work approval.");
      const p = product(db, input.product), q = integer(input.quantity, "Quantity", 1, 1000);
      if (p.kind === "Service") fail("Service labour cannot be reserved as a physical part.");
      reserve(db, branch, p.id, q);
      result = update(db, "tickets", t, { parts: [...t.parts, { product: p.id, name: p.name, quantity: q, cost: p.cost }] }, input.version);
      break;
    }
    case "ticket.status": {
      requirePermission(user, "tickets.manage");
      const t = get(db, "tickets", input.id, user);
      if (t.branch !== branch) fail("Select the ticket branch.");
      transition(t, input.status, ticketTransitions);
      const changes = { status: input.status };
      if (input.status === "Under Repair" && t.status === "Awaiting Approval") {
        requirePermission(user, "approvals.manage");
        if (t.advisor === user.id || t.technician === user.id) fail("Repair approval requires an independent supervisor.", 403);
        changes.approvedBy = user.id;
        const booking = get(db, "bookings", t.booking);
        if (!["Waiting", "In Progress"].includes(booking.status)) fail("Mark the booking Waiting before starting repair.", 409);
        if (list(db, "bookings", db.prepare("SELECT id FROM branches").all().map(row => row.id)).some(b => b.id !== booking.id && b.status === "In Progress" &&
          (b.branch === branch && b.bay === booking.bay || b.technician === booking.technician))) fail("The repair bay or employee is occupied.", 409);
        if (booking.status === "Waiting") update(db, "bookings", booking, { status: "In Progress" }, booking.version);
        if (!t.consumed) {
          for (const p of t.parts) { reserve(db, branch, p.product, -p.quantity); move(db, user, branch, p.product, -p.quantity, "Service consumption", t.id); }
          changes.consumed = true;
        }
      }
      if (input.status === "Ready for Release") {
        requirePermission(user, "approvals.manage");
        if (t.technician === user.id) fail("Quality check requires an independent reviewer.", 403);
        changes.qualityBy = user.id;
        changes.qualityNote = text(input.note, "Quality assurance checklist / result", 1000);
      }
      if (input.status === "Completed" && !t.qualityBy) fail("Quality assurance is required.");
      result = update(db, "tickets", t, changes, input.version);
      if (input.status === "Completed") {
        const booking = get(db, "bookings", t.booking);
        if (booking.status === "In Progress") update(db, "bookings", booking, { status: "Completed" }, booking.version);
      }
      create(db, "notifications", branch, { customer: t.customer, ticket: t.id, message: `Service status: ${input.status}`, status: "Pending integration", channel: "Not sent" });
      break;
    }
    case "queue.join": {
      requirePermission(user, "queue.manage");
      const c = get(db, "customers", input.customer, user);
      if (c.branch !== branch) fail("Customer belongs to a different branch.");
      if (list(db, "queue", [branch]).some(q => q.customer === c.id && ["Waiting", "Serving"].includes(q.status))) fail("Customer is already in the queue.", 409);
      if (input.priority) requirePermission(user, "queue.priority");
      const number = list(db, "queue", [branch]).filter(q => q.created.slice(0, 10) === now.slice(0, 10)).length + 1;
      result = create(db, "queue", branch, { customer: c.id, number, priority: input.priority === true, status: "Waiting", joined: now });
      break;
    }
    case "queue.next": {
      requirePermission(user, "queue.manage");
      const technician = employee(db, input.technician, branch);
      if (list(db, "queue", db.prepare("SELECT id FROM branches").all().map(b => b.id)).some(q => q.technician === technician.id && q.status === "Serving")) fail("Technician is already serving a queue entry.", 409);
      const next = list(db, "queue", [branch]).filter(q => q.status === "Waiting").sort((a, b) => Number(b.priority) - Number(a.priority) || a.joined.localeCompare(b.joined) || a.number - b.number)[0];
      if (!next) fail("No waiting customers.", 409);
      result = update(db, "queue", next, { status: "Serving", technician: technician.id, served: now }, next.version);
      break;
    }
    case "queue.finish": {
      requirePermission(user, "queue.manage");
      const q = get(db, "queue", input.id, user);
      if (q.branch !== branch || q.status !== "Serving") fail("Only a serving entry can be completed.", 409);
      result = update(db, "queue", q, { status: "Completed", completed: now }, input.version);
      break;
    }
    case "announcement.create": {
      requirePermission(user, "announcements.manage");
      result = create(db, "announcements", branch, { title: text(input.title, "Title"), message: text(input.message, "Announcement", 2000), author: user.id });
      break;
    }
    case "employee.save": {
      requirePermission(user, "employees.manage");
      const r = db.prepare("SELECT * FROM roles WHERE name=?").get(text(input.role, "Role"));
      if (!r || !administerRole(user, r)) fail("You may only administer lower-level roles; corporate administrators may also manage regional managers.", 403);
      if (!Array.isArray(input.branches) || !input.branches.length || new Set(input.branches).size !== input.branches.length) fail("Assign at least one unique branch.");
      input.branches.forEach(b => scope(user, b));
      const email = text(input.email, "Email", 150).toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail("Enter a valid staff email.");
      const name = text(input.name, "Employee name");
      if (input.id) {
        const existing = db.prepare("SELECT u.*,r.level FROM users u JOIN roles r ON r.name=u.role WHERE u.id=?").get(input.id);
        if (!existing || existing.id === user.id || !administerRole(user, { name: existing.role, level: existing.level }) || !JSON.parse(existing.branches).every(b => user.branches.includes(b))) fail("Employee administration is outside your authority.", 403);
        db.prepare("UPDATE users SET name=?,email=?,role=?,branches=?,active=? WHERE id=?")
          .run(name, email, input.role, JSON.stringify(input.branches), input.active === false ? 0 : 1, input.id);
        if (input.password) {
          if (text(input.password, "Password", 200).length < 14) fail("Password requires at least 14 characters.");
          db.prepare("UPDATE users SET password=?,failures=0,locked_until=0 WHERE id=?").run(passwordHash(input.password), input.id);
        }
        db.prepare("DELETE FROM sessions WHERE user_id=?").run(input.id);
        result = { id: input.id };
      } else {
        if (text(input.password, "Password", 200).length < 14) fail("Password requires at least 14 characters.");
        const id = randomUUID();
        db.prepare("INSERT INTO users(id,email,name,password,role,branches) VALUES(?,?,?,?,?,?)")
          .run(id, email, name, passwordHash(input.password), input.role, JSON.stringify(input.branches));
        result = { id };
      }
      break;
    }
    case "role.save": {
      requirePermission(user, "roles.manage");
      const r = db.prepare("SELECT * FROM roles WHERE name=?").get(input.role);
      if (!r || input.role === "Corporate Operations Manager") fail("The bootstrap corporate role is protected.");
      if (!Array.isArray(input.grants) || input.grants.some(p => !permissions.includes(p) || p === "roles.manage")) fail("Invalid permission selection.");
      const minimumLevel = p => p === "employees.manage" ? 4 : ["approvals.manage", "queue.priority", "attendance.manage", "audit.view", "announcements.manage"].includes(p) ? 3 :
        ["inventory.manage", "inventory.move", "catalogue.manage", "transfers.manage"].includes(p) ? 2 : 1;
      if (input.grants.some(p => r.level < minimumLevel(p))) fail("Approval and administration authority cannot be granted below its hierarchy level.");
      db.prepare("UPDATE roles SET grants=? WHERE name=?").run(JSON.stringify([...new Set(input.grants)]), input.role);
      result = { role: input.role };
      break;
    }
    case "password.change": {
      const existing = db.prepare("SELECT password FROM users WHERE id=?").get(user.id);
      const { passwordMatches } = require("./database");
      if (typeof input.current !== "string" || input.current.length > 200 || !passwordMatches(input.current, existing.password)) fail("Current password is incorrect.", 403);
      if (text(input.password, "New password", 200).length < 14) fail("Password requires at least 14 characters.");
      db.prepare("UPDATE users SET password=? WHERE id=?").run(passwordHash(input.password), user.id);
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
      result = { signInAgain: true };
      break;
    }
    default: fail("Unknown operation.", 404);
  }
  audit(db, user, branch, action, result.id || result.product || "", action === "employee.save" ?
    { role: input.role, branches: input.branches } : action === "role.save" ? { role: input.role, grants: input.grants } :
      { status: result.status || "", reference: input.reference || "" });
  return result;
}
function transact(db, userId, action, input, requestId) {
  text(requestId, "Idempotency key", 100);
  // Compare retries without retaining passwords or other request-body secrets.
  const encoded = createHash("sha256").update(JSON.stringify({ action, input })).digest("hex");
  db.exec("BEGIN IMMEDIATE");
  try {
    const user = identity(db, userId);
    scope(user, input.branch);
    const permission = action === "transfer.progress" && ["Approved", "Rejected"].includes(input.status) ?
      "approvals.manage" : actionPermissions[action];
    if (!permission) fail("Unknown operation.", 404);
    requirePermission(user, permission);
    if (action === "ticket.status" && ["Ready for Release", "Under Repair"].includes(input.status)) requirePermission(user, "approvals.manage");
    const previous = db.prepare("SELECT * FROM requests WHERE user_id=? AND request_id=?").get(user.id, requestId);
    if (previous) {
      if (previous.input !== encoded) fail("Idempotency key was already used for a different operation.", 409);
      db.exec("COMMIT"); return JSON.parse(previous.response);
    }
    const result = execute(db, user, action, input);
    db.prepare("INSERT INTO requests VALUES(?,?,?,?)").run(user.id, requestId, encoded, JSON.stringify(result));
    db.exec("COMMIT"); return result;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
const kindPermissions = {
  customers: "customers.view", orders: "sales.view", payments: "settlement.view", returns: "settlement.view",
  vehicles: "customers.view", warranties: "customers.view",
  bookings: "bookings.view", tickets: "tickets.view", queue: "queue.view", approvals: "approvals.manage",
  transfers: "inventory.view", notifications: "tickets.view", announcements: null
};
function snapshot(db, user, selectedBranch) {
  const branches = selectedBranch ? [scope(user, selectedBranch)] : user.branches;
  const result = { user, generated: new Date().toISOString(), scope: branches, branches: db.prepare("SELECT * FROM branches").all().filter(b => user.branches.includes(b.id)), records: {} };
  for (const [kind, permission] of Object.entries(kindPermissions)) {
    if (!permission || user.grants.includes(permission)) result.records[kind] = list(db, kind, branches);
  }
  if (user.grants.includes("sales.view")) {
    const day = new Date().toISOString().slice(0, 10);
    const gross = list(db, "orders", branches).filter(o => o.paidAt && o.paidAt.slice(0, 10) === day).reduce((n, o) => n + o.total, 0);
    const refunds = list(db, "returns", branches).filter(r => r.created.slice(0, 10) === day).reduce((n, r) => n + r.amount, 0);
    result.salesSummary = { day, gross, refunds, net: gross - refunds };
  }
  if (user.grants.includes("inventory.view")) {
    result.records.transfers = list(db, "transfers", db.prepare("SELECT id FROM branches").all().map(b => b.id))
      .filter(t => branches.includes(t.branch) || branches.includes(t.destination));
  }
  const selfAttendance = user.grants.includes("attendance.self"), attendanceManager = user.grants.includes("attendance.manage");
  if (selfAttendance || attendanceManager) for (const kind of ["attendance", "shifts", "leaves"]) {
    result.records[kind] = list(db, kind, branches).filter(r => attendanceManager || r.employee === user.id);
  }
  if (user.grants.includes("inventory.view")) {
    result.products = db.prepare("SELECT * FROM products WHERE active=1").all();
    result.stock = db.prepare("SELECT * FROM stock").all().filter(s => branches.includes(s.branch));
    result.movements = db.prepare("SELECT * FROM movements ORDER BY created DESC,rowid DESC").all().filter(s => branches.includes(s.branch));
    result.stock = result.stock.map(s => {
      const movements = result.movements.filter(m => m.branch === s.branch && m.product === s.product).reverse();
      const lots = [];
      for (const m of movements) {
        if (m.quantity > 0) lots.push({ quantity: m.quantity, created: m.created });
        else {
          let remaining = -m.quantity;
          while (remaining > 0 && lots.length) {
            const used = Math.min(remaining, lots[0].quantity); lots[0].quantity -= used; remaining -= used;
            if (!lots[0].quantity) lots.shift();
          }
        }
      }
      const demand = movements.filter(m => ["Paid sale", "Service consumption"].includes(m.reason) && Date.parse(m.created) >= Date.now() - 30 * 86400000).reduce((n, m) => n - m.quantity, 0);
      return { ...s, age: lots.length ? Math.floor((Date.now() - Date.parse(lots[0].created)) / 86400000) : null, rate: demand / 30 };
    });
  }
  if (user.grants.includes("inventory.locate")) {
    result.locations = db.prepare("SELECT s.branch,s.product,s.quantity,s.reserved,s.quarantine,b.name,b.kind,b.lat,b.lon,p.name AS productName,p.sku,COALESCE(NULLIF(s.shelf,''),p.shelf) AS shelf FROM stock s JOIN branches b ON s.branch=b.id JOIN products p ON s.product=p.id WHERE p.active=1").all();
    result.incoming = list(db, "transfers", db.prepare("SELECT id FROM branches").all().map(b => b.id))
      .filter(t => ["Approved", "Dispatched"].includes(t.status)).map(t => ({ product: t.product, branch: t.destination, quantity: t.quantity, eta: t.eta, status: t.status }));
  }
  if (["bookings.manage", "tickets.manage", "queue.manage", "attendance.manage", "employees.manage", "operations.view"].some(p => user.grants.includes(p))) {
    result.employees = db.prepare(`SELECT id,name,role,branches,active${user.grants.includes("employees.manage") ? ",email" : ""} FROM users`).all()
      .filter(u => JSON.parse(u.branches).some(b => branches.includes(b)))
      .map(u => ({ ...u, branches: JSON.parse(u.branches).filter(b => user.branches.includes(b)) }));
  }
  if (user.grants.includes("employees.manage")) {
    result.roles = db.prepare("SELECT * FROM roles").all().filter(r => administerRole(user, r)).map(r => ({ ...r, grants: JSON.parse(r.grants) }));
  }
  if (user.grants.includes("roles.manage")) { result.roles = db.prepare("SELECT * FROM roles").all().map(r => ({ ...r, grants: JSON.parse(r.grants) })); result.permissions = permissions; }
  if (user.grants.includes("audit.view")) result.audit = db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 1000").all().filter(a => branches.includes(a.branch));
  return result;
}
module.exports = { Problem, fail, identity, transact, snapshot, bookingTransitions, ticketTransitions, list, requirePermission, date };
