"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");

const source = fs.readFileSync(path.join(__dirname, "drivecore-store.js"), "utf8");
const key = "drivecore-member-v1";

function load(storage = new Map(), options = {}) {
  const context = {
    window: { dispatchEvent() {} },
    localStorage: {
      getItem(name) {
        if (options.failRead) throw new Error("Storage blocked");
        return storage.get(name) ?? null;
      },
      setItem(name, value) {
        if (options.failWrite) throw new Error("Quota exceeded");
        storage.set(name, value);
      }
    },
    crypto: { randomUUID },
    Event: class Event {},
    Intl,
    Date
  };
  vm.runInNewContext(source, context);
  return context.window.DriveCoreStore;
}

const car = {
  id: "car-demo", name: "Demo car", make: "Toyota", model: "Corolla",
  registration: "DEMO", fuel: "Petrol", vin: "", year: 2020, mileage: 50000
};

test("cart and garage persist across page instances without floating-point totals", () => {
  const storage = new Map();
  const store = load(storage);
  store.update(state => { state.cars.push(car); state.selectedCar = car.id; });
  store.addItem("engine-oil", 2);
  store.addItem("screenwash", 1);
  const reloaded = load(storage);
  assert.equal(reloaded.count(), 3);
  assert.equal(reloaded.total(reloaded.get().cart), 7747);
  assert.equal(reloaded.get().selectedCar, car.id);
  assert.equal(reloaded.money(7747), "£77.47");
});

test("separate tabs read the latest saved state before updating", () => {
  const storage = new Map();
  const first = load(storage);
  const second = load(storage);
  first.addItem("engine-oil", 1);
  second.addItem("screenwash", 1);
  assert.equal(first.count(), 2);
  assert.equal(second.count(), 2);
});

test("invalid and excessive quantities never change saved data", () => {
  const storage = new Map();
  const store = load(storage);
  store.addItem("engine-oil", 99);
  const saved = storage.get(key);
  assert.throws(() => store.addItem("engine-oil", 1), /at most 99/);
  assert.throws(() => store.addItem("screenwash", 0), /invalid data/);
  assert.throws(() => store.addItem("unknown", 1), /invalid data/);
  assert.throws(() => store.update(state => { state.cart[0].quantity = 1.5; }), /invalid data/);
  assert.equal(storage.get(key), saved);
});

test("corrupted data is reported and is not overwritten", () => {
  for (const saved of ["not-json", JSON.stringify({ version: 99 }), JSON.stringify({ version: 1, cars: [] })]) {
    const storage = new Map([[key, saved]]);
    const store = load(storage);
    assert.match(store.error(), /Cannot load/);
    assert.throws(() => store.addItem("engine-oil", 1), /Cannot load/);
    assert.equal(storage.get(key), saved);
  }
});

test("storage failures are explicit and failed writes do not claim success", () => {
  const storage = new Map();
  const blocked = load(storage, { failRead: true });
  assert.match(blocked.error(), /Storage blocked/);
  const store = load(storage, { failWrite: true });
  assert.throws(() => store.addItem("engine-oil", 1), /could not be saved/);
  assert.equal(store.count(), 0);
  assert.equal(storage.size, 0);
});

test("scan and maintenance dates and vehicle references are validated", () => {
  const store = load();
  store.update(state => { state.cars.push(car); state.selectedCar = car.id; });
  const scan = { id: "scan-demo", carId: car.id, date: "2026-10-08", mileage: 50000, codes: "P0300", notes: "Demo" };
  store.update(state => { state.scans.push(scan); });
  assert.throws(() => store.update(state => { state.scans[0].date = "2026-02-30"; }), /invalid data/);
  assert.throws(() => store.update(state => { state.scans[0].carId = "missing-car"; }), /invalid data/);
  assert.equal(store.get().scans[0].date, "2026-10-08");
  store.update(state => {
    state.maintenance.push({ id: "pms-demo", carId: car.id, service: "Oil change", date: "2026-11-08", mileage: null, status: "scheduled", notes: "" });
  });
  assert.equal(store.get().maintenance[0].mileage, null);
});

test("RFQ and order snapshots retain prices after catalogue changes", () => {
  const store = load();
  const customer = { name: "Demo", email: "demo@example.test", phone: "000", address: "Test" };
  const items = [{ productId: "engine-oil", quantity: 2, name: "Quoted engine oil", unitPrice: 3000 }];
  store.update(state => {
    state.quotes.push({ id: "rfq-demo", items, customer, notes: "", createdAt: "2026-10-08T00:00:00Z" });
    state.orders.push({ id: "po-demo", quoteId: "rfq-demo", items, customer, createdAt: "2026-10-08T00:00:00Z" });
  });
  store.products[0].price = 4000;
  assert.equal(store.total(store.get().orders[0].items), 6000);
  assert.equal(store.total([{ productId: "engine-oil", quantity: 2 }]), 8000);
});

test("all four service modes persist with valid car and order references", () => {
  const storage = new Map();
  const store = load(storage);
  store.update(state => {
    state.cars.push(car);
    state.selectedCar = car.id;
    store.services.forEach((service, index) => state.bookings.push({
      id: "booking-" + index, carId: car.id, orderId: "", service,
      date: "2026-11-15", time: "10:00", notes: "Demo details",
      customer: { name: "Demo", email: "demo@example.test", phone: "000", address: "Test" }
    }));
  });
  assert.equal(load(storage).get().bookings.length, 4);
  assert.throws(() => store.update(state => { state.bookings[0].time = "25:90"; }), /invalid data/);
  assert.throws(() => store.update(state => { state.bookings[0].orderId = "missing-order"; }), /invalid data/);
});
