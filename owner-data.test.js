"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("./owner-data.js");
const E = require("./owner-export.js");
const data = A.seed("2026-10-08");
const period = A.range(data.today, "30");

test("calendar periods respect Monday weeks, leap years and year boundaries", () => {
  assert.deepEqual(A.range("2026-10-08", "week"), { start: "2026-10-05", end: "2026-10-08" });
  assert.deepEqual(A.range("2026-10-11", "week"), { start: "2026-10-05", end: "2026-10-11" });
  assert.equal(A.range("2026-01-01", "year").start, "2026-01-01");
  assert.equal(A.shift("2024-03-01", -1), "2024-02-29");
  assert.deepEqual(A.previous({ start: "2026-01-01", end: "2026-01-07" }), { start: "2025-12-25", end: "2025-12-31" });
  assert.equal(A.pctChange(100, 0), null);
  assert.equal(A.pctChange(118, 100), 18);
});

test("seeded transactions are deterministic and have unique identifiers", () => {
  const second = A.seed(data.today);
  assert.equal(JSON.stringify(second), JSON.stringify(data));
  assert.equal(new Set(data.orders.map(order => order.id)).size, data.orders.length);
  assert.equal(new Set(data.movements.map(entry => entry.id)).size, data.movements.length);
  assert.ok(data.orders.length > 5000);
});

test("order partitions, revenue, profit and cash reconcile exactly", () => {
  for (const role of Object.keys(A.roles)) {
    const m = A.metrics(data, role, "all", period);
    assert.equal(m.completed + m.pending + m.cancelled, m.orders);
    assert.equal(m.gross - m.discounts - m.refunds, m.net);
    assert.equal(m.net - m.cost, m.grossProfit);
    assert.equal(m.grossProfit - m.expenses - m.commission, m.netProfit);
    assert.equal(m.collected + m.outstanding, m.net);
    assert.equal(m.collected - m.cost - m.expenses - m.commission, m.cashFlow);
    assert.equal(m.newCustomers + m.returning, m.customers);
    for (const value of Object.values(m)) assert.ok(Number.isFinite(value));
  }
});

test("company finance totals equal the sum of branch finance totals", () => {
  const total = A.metrics(data, "product", "all", period);
  const perBranch = A.branches.map(branch => A.metrics(data, "product", branch.id, period));
  for (const key of ["gross", "net", "cost", "expenses", "commission", "grossProfit", "netProfit", "collected", "outstanding", "orders"]) {
    assert.equal(A.sum(perBranch, branch => branch[key]), total[key], key + " must reconcile");
  }
});

test("role scopes reject unauthorized branch selections", () => {
  assert.equal(A.scopedBranches("product", "all").length, 4);
  assert.equal(A.scopedBranches("hub", "all").length, 2);
  assert.equal(A.scopedBranches("branch", "all").length, 1);
  assert.throws(() => A.scopeOrders(data, "hub", "central"), /outside/);
  assert.throws(() => A.scopeOrders(data, "branch", "south"), /outside/);
  assert.throws(() => A.scopedBranches("unknown", "all"), /Unknown/);
  assert.ok(A.scopeOrders(data, "hub", "all").every(order => ["north", "south"].includes(order.branchId)));
});

test("service provider scope excludes products, other technicians and shared expenses", () => {
  const orders = A.scopeOrders(data, "provider", "all");
  assert.ok(orders.length > 0);
  assert.ok(orders.every(order => order.branchId === "north" && order.items.every(item => item.kind === "service" && item.technicianId === "north-tech-1")));
  assert.equal(A.metrics(data, "provider", "all", period).expenses, 0);
  assert.deepEqual(A.inventory(data, "provider", "all"), []);
  assert.ok(!A.roles.provider.sections.includes("inventory"));
  assert.ok(!A.roles.provider.sections.includes("branches"));
});

test("grouped revenues and daily/monthly series reconcile to net revenue", () => {
  const m = A.metrics(data, "product", "all", period);
  for (const dimension of ["category", "payment", "segment", "kind"]) {
    assert.equal(A.sum(A.groupSales(data, "product", "all", period, dimension), entry => entry.revenue), m.net);
  }
  assert.equal(A.sum(A.series(data, "product", "all", period, "day"), entry => entry.value), m.net);
  const yearly = A.range(data.today, "year");
  assert.equal(A.sum(A.series(data, "product", "all", yearly, "month"), entry => entry.value), A.metrics(data, "product", "all", yearly).net);
});

test("customer retention is computed from actual previous-period purchasers", () => {
  const sample = { orders: [], expenses: [] };
  function order(id, date, customer, status = "completed") {
    return { id, date, customerId: customer, branchId: "north", status, paid: true, items: [{ kind: "product", id: "oil", price: 1000, cost: 400, quantity: 1, discount: 0, refund: 0 }] };
  }
  sample.orders.push(order("1", "2026-09-01", "old"), order("2", "2026-09-02", "lost"), order("3", "2026-09-08", "old"), order("4", "2026-09-09", "new"), order("5", "2026-09-10", "cancelled-customer", "cancelled"));
  const m = A.metrics(sample, "branch", "all", { start: "2026-09-08", end: "2026-09-14" });
  assert.equal(m.customers, 2);
  assert.equal(m.returning, 1);
  assert.equal(m.newCustomers, 1);
  assert.equal(m.previousCustomers, 2);
  assert.equal(m.retained, 1);
  assert.equal(m.retention, 50);
});

test("inventory balances, valuation and transfer pairs are consistent", () => {
  const inventory = A.inventory(data, "product", "all");
  assert.equal(inventory.length, 32);
  for (const entry of inventory) {
    const ledger = data.movements.filter(move => move.branchId === entry.branchId && move.productId === entry.id);
    assert.equal(A.sum(ledger, move => move.quantity), entry.quantity);
    assert.equal(ledger.at(-1).balance, entry.quantity);
    assert.equal(entry.quantity * entry.cost, entry.value);
    assert.ok(entry.quantity >= 0);
    assert.ok(entry.age >= 0);
  }
  assert.equal(A.sum(data.movements.filter(move => move.type.startsWith("Transfer")), move => move.quantity), 0);
  for (const product of A.products) assert.equal(A.sum(data.movements.filter(move => move.productId === product.id && move.type.startsWith("Transfer")), move => move.quantity), 0);
  const metrics = A.inventoryMetrics(data, "product", "all", period);
  assert.equal(metrics.valuation, A.sum(inventory, entry => entry.value));
  assert.ok(metrics.accuracy >= 0 && metrics.accuracy <= 100);
});

test("inventory risk thresholds and zero-demand cover are explicit", () => {
  const entries = A.inventory(data, "product", "all");
  assert.ok(entries.some(entry => entry.status === "Out of stock"));
  assert.ok(entries.some(entry => entry.status === "Low stock"));
  assert.ok(entries.some(entry => entry.status === "Overstock"));
  assert.ok(entries.some(entry => entry.speed === "Slow-moving"));
  for (const entry of entries) {
    if (entry.rate === 0) assert.equal(entry.daysCover, null);
    else assert.equal(entry.daysCover, entry.quantity / entry.rate);
    if (entry.quantity === 0) assert.equal(entry.status, "Out of stock");
  }
});

test("service status partitions and technician revenue reconcile", () => {
  for (const role of Object.keys(A.roles)) {
    const s = A.serviceMetrics(data, role, "all", period);
    assert.equal(s.completed + s.ongoing + s.pending + s.cancelled, s.total);
    assert.equal(A.sum(s.technicians, tech => tech.completed), s.completed);
    assert.equal(A.sum(s.technicians, tech => tech.revenue), s.revenue);
    assert.equal(A.sum(A.groupSales(data, role, "all", period, "service"), group => group.revenue), s.revenue);
    assert.ok(s.rating === null || (s.rating >= 1 && s.rating <= 5));
  }
});

test("forecasts produce seven dated, nonnegative and ordered baseline scenarios", () => {
  const forecast = A.forecast(data, "hub", "all");
  assert.equal(forecast.history.length, 14);
  assert.equal(forecast.prediction.length, 7);
  assert.equal(forecast.prediction[0].label, A.shift(data.today, 1));
  for (const point of forecast.prediction) {
    assert.ok(Number.isInteger(point.value));
    assert.ok(point.low <= point.value && point.value <= point.high);
    assert.ok(point.low >= 0);
  }
});

test("simulated updates reconcile and never produce inventory side effects", () => {
  const clone = A.seed(data.today);
  const stockBefore = JSON.stringify(clone.movements);
  const before = clone.orders.length;
  for (let i = 0; i < 5; i += 1) A.simulate(clone);
  assert.equal(clone.orders.length, before + 5);
  assert.equal(clone.revision, 5);
  assert.equal(new Set(clone.orders.map(order => order.id)).size, clone.orders.length);
  assert.equal(JSON.stringify(clone.movements), stockBefore);
  const m = A.metrics(clone, "product", "all", period);
  assert.equal(m.orders, m.completed + m.pending + m.cancelled);
});

test("empty scopes produce finite zero metrics, forecasts and honest insights", () => {
  const empty = { today: data.today, orders: [], expenses: [], movements: [], technicians: [] };
  const m = A.metrics(empty, "product", "all", period);
  assert.equal(m.net, 0);
  assert.equal(m.retention, 0);
  assert.equal(m.margin, 0);
  assert.ok(Object.values(m).every(Number.isFinite));
  assert.ok(A.forecast(empty, "product", "all").prediction.every(point => point.value === 0));
  assert.match(A.insights(empty, "product", "all", period)[0].text, /cannot be calculated/);
});

test("CSV escapes delimiters, quotes, Unicode and spreadsheet formula injection", () => {
  const csv = E.csv([["Name", "Amount"], ['Brake "pads", set', 12.5], ["=HYPERLINK(\"unsafe\")", "@SUM(A1)"], [" +cmd", "-bad"], ["Café", -3]]);
  assert.ok(csv.startsWith("\ufeff"));
  assert.match(csv, /"Brake ""pads"", set","12.5"/);
  assert.match(csv, /"'=HYPERLINK/);
  assert.match(csv, /"'@SUM/);
  assert.match(csv, /"' \+cmd"/);
  assert.match(csv, /"Café","-3"/);
});

function unzipStored(bytes) {
  const buffer = Buffer.from(bytes);
  const files = new Map();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString();
    const start = offset + 30 + nameLength + extraLength;
    files.set(name, buffer.subarray(start, start + size).toString());
    offset = start + size;
  }
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
  assert.equal(buffer.readUInt32LE(buffer.length - 22), 0x06054b50);
  return files;
}

test("Excel export is an actual OOXML zip workbook with typed cells", () => {
  const files = unzipStored(E.xlsx([["Report", "Café & <Stock>"], ["Revenue", 7747.55], ["=SUM(A1)", "-literal"]]));
  assert.equal(files.size, 5);
  assert.ok(files.has("[Content_Types].xml"));
  assert.ok(files.has("_rels/.rels"));
  assert.ok(files.has("xl/workbook.xml"));
  const sheet = files.get("xl/worksheets/sheet1.xml");
  assert.match(sheet, /Café &amp; &lt;Stock&gt;/);
  assert.match(sheet, /<c r="B2"><v>7747.55<\/v><\/c>/);
  assert.match(sheet, /t="inlineStr"/);
  assert.ok(!sheet.includes("<f>"));
  assert.match(sheet, /=SUM\(A1\)/);
});
