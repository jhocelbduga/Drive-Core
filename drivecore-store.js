"use strict";

(function () {
  var key = "drivecore-member-v1";
  var products = [
    { id: "engine-oil", name: "5W-30 Fully Synthetic Engine Oil, 5L", category: "Engine care", price: 3499, symbol: "5W-30" },
    { id: "screenwash", name: "All-Season Screenwash, 5L", category: "Car care", price: 749, symbol: "CLEAR" },
    { id: "wipers", name: "Premium Windscreen Wiper Blades", category: "Visibility", price: 1899, symbol: "WIPER" },
    { id: "wash-kit", name: "Complete Car Care Wash Kit", category: "Detailing", price: 2499, symbol: "SHINE" }
  ];
  var services = ["User DIY Delivery Service", "Home Installation Service", "Hub Installation Service", "Towing Service"];
  var state = emptyState();
  var storageError = "";

  function emptyState() {
    return { version: 1, selectedCar: "", cars: [], scans: [], maintenance: [], cart: [], quotes: [], orders: [], bookings: [] };
  }

  function text(value) { return typeof value === "string"; }
  function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
  function date(value) {
    return text(value) && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value;
  }
  function record(value) { return value && text(value.id) && value.id.length > 0; }
  function items(value, snapshot) {
    return Array.isArray(value) && value.every(function (item) {
      return item && products.some(function (product) { return product.id === item.productId; }) &&
        Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 99 &&
        (!snapshot || (integer(item.unitPrice) && text(item.name) && item.name.length > 0));
    }) && new Set(value.map(function (item) { return item.productId; })).size === value.length;
  }
  function customer(value) {
    return value && ["name", "email", "phone", "address"].every(function (field) { return text(value[field]); });
  }
  function valid(value) {
    return value && value.version === 1 && text(value.selectedCar) &&
      ["cars", "scans", "maintenance", "quotes", "orders", "bookings"].every(function (list) {
        return Array.isArray(value[list]) && value[list].every(record) &&
          new Set(value[list].map(function (entry) { return entry.id; })).size === value[list].length;
      }) &&
      value.cars.every(function (car) {
        return ["name", "make", "model", "registration", "fuel", "vin"].every(function (field) { return text(car[field]); }) &&
          integer(car.year) && integer(car.mileage);
      }) &&
      (!value.selectedCar || value.cars.some(function (car) { return car.id === value.selectedCar; })) &&
      value.scans.every(function (scan) {
        return value.cars.some(function (car) { return car.id === scan.carId; }) &&
          date(scan.date) && integer(scan.mileage) && ["codes", "notes"].every(function (field) { return text(scan[field]); });
      }) &&
      value.maintenance.every(function (entry) {
        return value.cars.some(function (car) { return car.id === entry.carId; }) &&
          text(entry.service) && text(entry.notes) && date(entry.date) &&
          (entry.mileage === null || integer(entry.mileage)) && ["scheduled", "completed"].includes(entry.status);
      }) && items(value.cart) &&
      value.quotes.every(function (quote) { return items(quote.items, true) && quote.items.length > 0 && customer(quote.customer) && text(quote.createdAt) && text(quote.notes); }) &&
      value.orders.every(function (order) {
        return value.quotes.some(function (quote) { return quote.id === order.quoteId; }) &&
          items(order.items, true) && order.items.length > 0 && customer(order.customer) && text(order.createdAt);
      }) &&
      value.bookings.every(function (booking) {
        return services.includes(booking.service) && date(booking.date) && text(booking.time) && /^([01]\d|2[0-3]):[0-5]\d$/.test(booking.time) &&
          customer(booking.customer) && text(booking.notes) && text(booking.orderId) &&
          (!booking.orderId || value.orders.some(function (order) { return order.id === booking.orderId; })) &&
          value.cars.some(function (car) { return car.id === booking.carId; });
      });
  }

  function readState() {
    try {
      var saved = localStorage.getItem(key);
      var parsed = saved === null ? emptyState() : JSON.parse(saved);
      if (!valid(parsed)) throw new Error("The saved DriveCore data has an unsupported or damaged format.");
      state = parsed;
      storageError = "";
    } catch (error) {
      storageError = "Cannot load your saved DriveCore data. " + error.message +
        " Check browser storage permissions. Existing data has not been overwritten.";
    }
  }
  readState();

  function update(change) {
    readState();
    if (storageError) throw new Error(storageError);
    var next = JSON.parse(JSON.stringify(state));
    change(next);
    if (!valid(next)) throw new Error("The changes contain invalid data and were not saved.");
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch (error) {
      throw new Error("Your changes could not be saved. Check browser storage permissions or available space. " + error.message);
    }
    state = next;
    window.dispatchEvent(new Event("drivecore:change"));
  }

  function addItem(productId, quantity) {
    update(function (next) {
      var item = next.cart.find(function (entry) { return entry.productId === productId; });
      if (item) {
        if (item.quantity + quantity > 99) throw new Error("A cart item can have at most 99 units.");
        item.quantity += quantity;
      } else {
        next.cart.push({ productId: productId, quantity: quantity });
      }
    });
  }

  window.DriveCoreStore = {
    products: products,
    services: services,
    get: function () { readState(); return JSON.parse(JSON.stringify(state)); },
    error: function () { return storageError; },
    update: update,
    addItem: addItem,
    id: function (prefix) { return prefix + "-" + crypto.randomUUID(); },
    today: function () {
      var now = new Date();
      return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
    },
    money: function (amount) { return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(amount / 100); },
    total: function (list) {
      return list.reduce(function (sum, item) {
        var product = products.find(function (entry) { return entry.id === item.productId; });
        return sum + (item.unitPrice === undefined ? product.price : item.unitPrice) * item.quantity;
      }, 0);
    },
    count: function () { readState(); return state.cart.reduce(function (sum, item) { return sum + item.quantity; }, 0); }
  };
})();
