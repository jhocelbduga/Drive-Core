"use strict";

document.addEventListener("DOMContentLoaded", function () {
  var store = window.DriveCoreStore;
  var page = document.body.dataset.page;
  var editingCarId = "";
  var invoiceQuoteId = "";
  var activeOrderId = "";

  function element(tag, text, className) {
    var node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function link(text, href, className) {
    var node = element("a", text, className);
    node.href = href;
    return node;
  }
  function button(text, handler, className) {
    var node = element("button", text, className || "text-button");
    node.type = "button";
    node.addEventListener("click", function () { attempt(handler); });
    return node;
  }
  function notice(message, error) {
    var node = document.getElementById("page-notice");
    node.hidden = false;
    node.className = "notice" + (error ? " error" : "");
    node.setAttribute("role", error ? "alert" : "status");
    node.textContent = message;
  }
  function attempt(action) {
    try { action(); } catch (error) { notice(error.message, true); }
  }
  function shortId(id) { return id.split("-")[0].toUpperCase() + "-" + id.slice(-8).toUpperCase(); }
  function displayDate(date) { return new Date(date + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); }
  function selectedCar() {
    var state = store.get();
    return state.cars.find(function (car) { return car.id === state.selectedCar; });
  }
  function requireCar() {
    var car = selectedCar();
    if (!car) throw new Error("Add and select a car before saving a scan or maintenance record.");
    return car;
  }
  function formValues(form) {
    var values = Object.fromEntries(new FormData(form));
    Object.keys(values).forEach(function (key) {
      if (typeof values[key] === "string") values[key] = values[key].trim();
    });
    return values;
  }
  function requireText(values, fields) {
    fields.forEach(function (field) {
      if (!values[field]) throw new Error("Please enter " + field.replace(/([A-Z])/g, " $1").toLowerCase() + "; spaces alone are not valid.");
    });
  }
  function customer(values) { return { name: values.name, email: values.email, phone: values.phone, address: values.address }; }
  function submit(formId, handler) {
    var form = document.getElementById(formId);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (form.reportValidity()) attempt(function () { handler(formValues(form), form); });
    });
  }
  function empty(container, message) { container.append(element("p", message, "empty")); }
  function product(id) { return store.products.find(function (entry) { return entry.id === id; }); }
  function summary(container, items) {
    container.replaceChildren();
    if (!items.length) { empty(container, "Your cart is empty. Add an item to start your order."); return; }
    var lines = element("div", undefined, "summary-lines");
    items.forEach(function (item) {
      var entry = product(item.productId);
      var unitPrice = item.unitPrice === undefined ? entry.price : item.unitPrice;
      var row = element("div", undefined, "summary-line");
      var label = element("span", item.name || entry.name);
      label.append(element("small", item.quantity + " × " + store.money(unitPrice)));
      row.append(label, element("strong", store.money(unitPrice * item.quantity)));
      lines.append(row);
    });
    var total = element("div", undefined, "summary-line total");
    total.append(element("span", "Item subtotal"), element("strong", store.money(store.total(items))));
    lines.append(total);
    container.append(lines);
  }
  function renderShell() {
    var shell = document.getElementById("member-shell");
    var skip = link("Skip to content", "#main-content", "skip-link");
    var header = element("header", undefined, "member-header");
    var inner = element("div", undefined, "header-inner");
    var brand = link("DRIVE", "index.html", "member-brand");
    brand.append(element("span", "CORE"), element("small", "MEMBER GARAGE"));
    var navigation = element("nav", undefined, "member-nav");
    navigation.setAttribute("aria-label", "Member navigation");
    [
      ["My garage", "userMemberPage.html", "member"],
      ["Shop", "index.html", "shop"],
      ["Cart", "CartItem.html", "cart"],
      ["Services", "bookingservice.html", "booking"]
    ].forEach(function (entry) {
      var item = link(entry[0], entry[1]);
      if (page === entry[2]) item.setAttribute("aria-current", "page");
      if (entry[2] === "cart") {
        var count = element("span", " (" + store.count() + ")");
        count.id = "member-cart-count";
        count.setAttribute("aria-live", "polite");
        item.append(count);
      }
      navigation.append(item);
    });
    inner.append(brand, navigation);
    navigation.append(link("Owners", "ownerDashboard.html"));
    navigation.append(link("Hub admin", "hubAdministration.html"));
    header.append(inner);
    var note = element("div", undefined, "demo-note");
    note.append(element("strong", "Local demo workspace. "), document.createTextNode("Not authenticated. Data is saved in this browser only; do not enter sensitive or real customer information. No live diagnostics, quotations, payments or bookings are sent. Use a local web server for consistent storage across pages."));
    shell.append(skip, header, note);
    var workflow = document.getElementById("workflow-navigation");
    if (workflow) {
      var nav = element("nav");
      nav.setAttribute("aria-label", "Order workflow");
      var list = element("ol", undefined, "workflow-steps");
      [["Cart", "CartItem.html", "cart"], ["Request quote", "rfqForm.html", "rfq"], ["Confirm order", "salesInvoice.html", "invoice"], ["Book service", "bookingservice.html", "booking"]].forEach(function (entry, index) {
        var item = element("li");
        var anchor = link("", entry[1]);
        anchor.append(element("b", String(index + 1)), document.createTextNode(entry[0]));
        if (page === entry[2]) anchor.setAttribute("aria-current", "step");
        item.append(anchor);
        list.append(item);
      });
      nav.append(list);
      workflow.append(nav);
    }
  }
  function renderCatalogue() {
    var container = document.getElementById("member-catalogue");
    if (!container) return;
    store.products.forEach(function (entry) {
      var card = element("article", undefined, "catalogue-card");
      card.append(element("div", entry.symbol, "catalogue-art"), element("p", entry.category, "eyebrow"), element("h3", entry.name));
      var actions = element("div", undefined, "actions");
      actions.append(element("strong", store.money(entry.price)), button("Add to cart", function () {
        store.addItem(entry.id, 1);
        if (page === "cart") renderCart();
        notice(entry.name + " added to your saved cart.");
      }, "primary"));
      card.append(actions);
      container.append(card);
    });
  }
  function selectOptions(select, entries, placeholder, chosen) {
    select.replaceChildren();
    var first = element("option", placeholder);
    first.value = "";
    select.append(first);
    entries.forEach(function (entry) {
      var option = element("option", entry.label);
      option.value = entry.id;
      select.append(option);
    });
    select.value = chosen || "";
  }
  function switchTab(name, focus) {
    var tabs = Array.from(document.querySelectorAll("[data-tab]"));
    tabs.forEach(function (tab) {
      var active = tab.dataset.tab === name;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      document.getElementById(tab.getAttribute("aria-controls")).hidden = !active;
      if (active && focus) tab.focus();
    });
  }
  function fillCarForm(car) {
    var form = document.getElementById("car-form");
    form.reset();
    editingCarId = car ? car.id : "";
    document.getElementById("car-form-title").textContent = car ? "Edit your car details" : "Add your car details";
    document.getElementById("cancel-car").hidden = !selectedCar() || !!car;
    if (car) {
      ["name", "make", "model", "registration", "year", "mileage", "fuel", "vin"].forEach(function (field) { form.elements[field].value = car[field]; });
    } else {
      form.elements.year.value = new Date().getFullYear();
      form.elements.mileage.value = 0;
    }
  }
  function maintenanceStatus(entry, car) {
    if (entry.status === "completed") return { label: "Completed", className: "complete" };
    var days = Math.round((Date.parse(entry.date + "T00:00:00Z") - Date.parse(store.today() + "T00:00:00Z")) / 86400000);
    var km = entry.mileage === null ? Infinity : entry.mileage - car.mileage;
    if (days < 0 || km < 0) return { label: "Overdue", className: "overdue" };
    if (days === 0 || km === 0) return { label: "Due now", className: "warning" };
    if (days <= 30 || km <= 500) return { label: "Due soon", className: "warning" };
    return { label: "Scheduled", className: "" };
  }
  function maintenanceCard(entry, car, compact) {
    var status = maintenanceStatus(entry, car);
    var card = element("article", undefined, "record");
    var head = element("div", undefined, "record-head");
    head.append(element("strong", entry.service), element("span", status.label, "badge " + status.className));
    card.append(head, element("p", displayDate(entry.date) + (entry.mileage === null ? "" : " · " + entry.mileage.toLocaleString() + " km")));
    if (!compact && entry.notes) card.append(element("p", entry.notes));
    if (!compact && entry.status === "scheduled") {
      var actions = element("div", undefined, "actions");
      actions.append(button("Mark completed today", function () {
        store.update(function (state) {
          var saved = state.maintenance.find(function (item) { return item.id === entry.id; });
          saved.status = "completed";
          saved.date = store.today();
          saved.mileage = car.mileage;
        });
        renderCarRecords();
        notice("Maintenance marked completed today at " + car.mileage.toLocaleString() + " km.");
      }), link("Book a service", "bookingservice.html", "text-button"));
      card.append(actions);
    }
    return card;
  }
  function renderCarRecords() {
    var car = selectedCar();
    var state = store.get();
    var scans = document.getElementById("scan-records");
    var upcoming = document.getElementById("pms-upcoming");
    var history = document.getElementById("pms-history");
    var alerts = document.getElementById("maintenance-alerts");
    [scans, upcoming, history, alerts].forEach(function (container) { container.replaceChildren(); });
    ["scan-form", "pms-form"].forEach(function (id) {
      document.getElementById(id).querySelectorAll("input, select, textarea, button").forEach(function (control) { control.disabled = !car; });
    });
    if (!car) {
      [scans, upcoming, history, alerts].forEach(function (container) { empty(container, "Add and select a car to see its records."); });
      return;
    }
    var scanEntries = state.scans.filter(function (entry) { return entry.carId === car.id; }).sort(function (a, b) { return b.date.localeCompare(a.date); });
    if (!scanEntries.length) empty(scans, "No scans logged for this car yet.");
    scanEntries.forEach(function (entry) {
      var card = element("article", undefined, "record");
      card.append(element("strong", displayDate(entry.date) + " · " + entry.mileage.toLocaleString() + " km"), element("p", "Codes: " + (entry.codes || "No codes reported")), element("p", entry.notes));
      scans.append(card);
    });
    var records = state.maintenance.filter(function (entry) { return entry.carId === car.id; }).sort(function (a, b) { return a.date.localeCompare(b.date); });
    records.forEach(function (entry) {
      (entry.status === "completed" ? history : upcoming).append(maintenanceCard(entry, car, false));
      if (entry.status === "scheduled" && maintenanceStatus(entry, car).label !== "Scheduled") alerts.append(maintenanceCard(entry, car, true));
    });
    if (!upcoming.children.length) empty(upcoming, "No upcoming maintenance scheduled.");
    if (!history.children.length) empty(history, "No completed maintenance logged.");
    if (!alerts.children.length) empty(alerts, "You're all caught up. No maintenance is due within 30 days or 500 km.");
  }
  function renderGarage() {
    var state = store.get();
    var car = selectedCar();
    selectOptions(document.getElementById("car-selector"), state.cars.map(function (entry) { return { id: entry.id, label: entry.name + " · " + entry.registration }; }), "Select a car", state.selectedCar);
    document.getElementById("car-summary-name").textContent = car ? car.name : "Your next journey starts here";
    document.getElementById("car-summary-detail").textContent = car ? car.year + " " + car.make + " " + car.model + " · " + car.registration + " · " + car.mileage.toLocaleString() + " km" : "Add your first car to track its health and maintenance.";
    fillCarForm(car);
    renderCarRecords();
    var activity = document.getElementById("member-activity");
    activity.replaceChildren();
    state.orders.slice().reverse().forEach(function (order) {
      var card = element("article", undefined, "record");
      card.append(link(shortId(order.id), "salesInvoice.html?order=" + encodeURIComponent(order.id)), element("p", "Demo purchase order · " + store.money(store.total(order.items))));
      activity.append(card);
    });
    state.bookings.slice().reverse().forEach(function (booking) {
      var card = element("article", undefined, "record");
      card.append(element("strong", booking.service), element("p", displayDate(booking.date) + " · " + booking.time), element("span", "Local request · not confirmed", "badge"));
      activity.append(card);
    });
    if (!activity.children.length) empty(activity, "Your saved purchase orders and service requests will appear here.");
  }
  function initializeMember() {
    renderGarage();
    document.querySelectorAll("[data-tab]").forEach(function (tab, index, tabs) {
      tab.addEventListener("click", function () { switchTab(tab.dataset.tab); });
      tab.addEventListener("keydown", function (event) {
        var next;
        if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
        if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = tabs.length - 1;
        if (next !== undefined) { event.preventDefault(); switchTab(tabs[next].dataset.tab, true); }
      });
    });
    document.getElementById("new-car").addEventListener("click", function () { switchTab("details"); fillCarForm(null); document.getElementById("car-name").focus(); });
    document.getElementById("cancel-car").addEventListener("click", function () { fillCarForm(selectedCar()); });
    document.getElementById("car-selector").addEventListener("change", function (event) {
      attempt(function () {
        store.update(function (state) { state.selectedCar = event.target.value; });
        renderGarage();
      });
    });
    submit("car-form", function (values) {
      requireText(values, ["name", "make", "model", "registration"]);
      var car = Object.assign(values, { id: editingCarId || store.id("car"), year: Number(values.year), mileage: Number(values.mileage) });
      store.update(function (state) {
        var index = state.cars.findIndex(function (entry) { return entry.id === car.id; });
        if (index < 0) state.cars.push(car); else state.cars[index] = car;
        state.selectedCar = car.id;
      });
      renderGarage();
      notice("Car details saved. Your maintenance alerts have been refreshed.");
    });
    document.getElementById("scan-date").value = store.today();
    document.getElementById("scan-date").max = store.today();
    submit("scan-form", function (values, form) {
      var car = requireCar();
      requireText(values, ["notes"]);
      store.update(function (state) {
        state.scans.push({ id: store.id("scan"), carId: car.id, date: values.date, mileage: Number(values.mileage), codes: values.codes.toUpperCase(), notes: values.notes });
      });
      form.reset();
      form.elements.date.value = store.today();
      renderCarRecords();
      notice("OBD scan log saved for " + car.name + ".");
    });
    document.getElementById("pms-date").value = store.today();
    submit("pms-form", function (values, form) {
      var car = requireCar();
      requireText(values, ["service"]);
      if (values.status === "completed" && values.date > store.today()) throw new Error("Completed maintenance cannot have a future completion date.");
      store.update(function (state) {
        state.maintenance.push({ id: store.id("pms"), carId: car.id, service: values.service, status: values.status, date: values.date, mileage: values.mileage === "" ? null : Number(values.mileage), notes: values.notes });
      });
      form.reset();
      form.elements.date.value = store.today();
      renderCarRecords();
      notice("Maintenance record saved.");
    });
  }
  function renderCart() {
    var state = store.get();
    var container = document.getElementById("cart-items");
    container.replaceChildren();
    if (!state.cart.length) empty(container, "No items yet. Choose an item below to start.");
    state.cart.forEach(function (item) {
      var entry = product(item.productId);
      var row = element("article", undefined, "cart-item");
      var detail = element("div");
      detail.append(element("h3", entry.name), element("small", store.money(entry.price) + " each"), element("br"), button("Remove", function () {
        store.update(function (next) { next.cart = next.cart.filter(function (saved) { return saved.productId !== item.productId; }); });
        renderCart();
        notice("Item removed from your cart.");
      }, "text-button danger"));
      var field = element("div");
      var label = element("label", "Quantity");
      var quantity = element("input");
      quantity.id = "quantity-" + item.productId;
      label.htmlFor = quantity.id;
      quantity.type = "number";
      quantity.min = "1";
      quantity.max = "99";
      quantity.step = "1";
      quantity.value = item.quantity;
      quantity.required = true;
      quantity.setAttribute("aria-label", "Quantity for " + entry.name);
      quantity.addEventListener("change", function () {
        if (!quantity.reportValidity()) { notice("Quantity must be a whole number from 1 to 99.", true); return; }
        attempt(function () {
          store.update(function (next) { next.cart.find(function (saved) { return saved.productId === item.productId; }).quantity = Number(quantity.value); });
          renderCart();
          notice("Cart quantity updated.");
        });
      });
      field.append(label, quantity);
      row.append(detail, field, element("strong", store.money(entry.price * item.quantity), "line-total"));
      container.append(row);
    });
    summary(document.getElementById("cart-summary"), state.cart);
    document.getElementById("cart-item-count").textContent = store.count() + " items";
    document.getElementById("cart-next").hidden = !state.cart.length;
  }
  function initializeRfq() {
    var state = store.get();
    summary(document.getElementById("rfq-summary"), state.cart);
    document.getElementById("rfq-submit").disabled = !state.cart.length;
    if (!state.cart.length) notice("Add an item to your cart before saving an RFQ.", true);
    submit("rfq-form", function (values) {
      requireText(values, ["name", "email", "phone", "address"]);
      var quoteId = store.id("rfq");
      store.update(function (next) {
        if (!next.cart.length) throw new Error("Your cart is empty. Add an item first.");
        next.quotes.push({ id: quoteId, items: next.cart.map(function (item) {
          var entry = product(item.productId);
          return { productId: item.productId, quantity: item.quantity, name: entry.name, unitPrice: entry.price };
        }), customer: customer(values), notes: values.notes, createdAt: new Date().toISOString() });
      });
      window.location.assign("salesInvoice.html?quote=" + encodeURIComponent(quoteId));
    });
  }
  function renderInvoice() {
    var state = store.get();
    var params = new URLSearchParams(window.location.search);
    var requestedOrder = params.get("order") || activeOrderId;
    var requestedQuote = params.get("quote");
    var order = state.orders.find(function (entry) { return entry.id === requestedOrder; });
    var quote = state.quotes.find(function (entry) { return entry.id === requestedQuote; });
    if (quote && !order) order = state.orders.find(function (entry) { return entry.quoteId === quote.id; });
    if (!requestedOrder && !requestedQuote) {
      quote = state.quotes[state.quotes.length - 1];
      if (quote) order = state.orders.find(function (entry) { return entry.quoteId === quote.id; });
    }
    var container = document.getElementById("invoice-details");
    container.replaceChildren();
    var confirmForm = document.getElementById("confirm-order-form");
    var actions = document.getElementById("invoice-actions");
    confirmForm.hidden = true;
    actions.hidden = true;
    var record = order || quote;
    if (!record) {
      empty(container, requestedOrder || requestedQuote ? "The requested order or RFQ was not found in this browser." : "No RFQ to review yet. Add items to your cart and save a quotation request first.");
      container.append(link("Go to your cart", "CartItem.html", "button"));
      return;
    }
    if (order) quote = state.quotes.find(function (entry) { return entry.id === order.quoteId; });
    invoiceQuoteId = quote.id;
    activeOrderId = order ? order.id : "";
    var meta = element("div", undefined, "invoice-meta");
    var reference = element("div");
    reference.append(element("strong", shortId(record.id)), element("p", new Date(record.createdAt).toLocaleString("en-GB")), element("span", order ? "Demo order saved · no payment taken" : "Local RFQ · awaiting demo confirmation", "badge"));
    var contact = element("div");
    contact.append(element("strong", record.customer.name), element("p", record.customer.email + "\n" + record.customer.phone + "\n" + record.customer.address));
    meta.append(reference, contact);
    container.append(meta);
    var totals = element("div");
    summary(totals, record.items);
    container.append(totals);
    if (quote.notes) container.append(element("p", "Requirements: " + quote.notes, "muted"));
    container.append(element("p", "This is not a tax invoice. Delivery, installation and taxes are not included. A real supplier must confirm all charges, stock and compatibility.", "muted"));
    confirmForm.hidden = !!order;
    actions.hidden = !order;
    if (order) document.getElementById("book-order-link").href = "bookingservice.html?order=" + encodeURIComponent(order.id);
  }
  function initializeInvoice() {
    renderInvoice();
    submit("confirm-order-form", function () {
      var orderId = store.id("po");
      store.update(function (state) {
        var quote = state.quotes.find(function (entry) { return entry.id === invoiceQuoteId; });
        if (!quote) throw new Error("Save an RFQ before confirming an order.");
        if (state.orders.some(function (entry) { return entry.quoteId === quote.id; })) throw new Error("This RFQ already has a saved purchase order.");
        if (quote.items.some(function (item) {
          var cartItem = state.cart.find(function (entry) { return entry.productId === item.productId; });
          return !cartItem || cartItem.quantity < item.quantity;
        })) throw new Error("Your cart no longer contains the quoted quantities. Review your cart and save a new RFQ.");
        state.orders.push({ id: orderId, quoteId: quote.id, items: quote.items.map(function (item) { return Object.assign({}, item); }), customer: quote.customer, createdAt: new Date().toISOString() });
        quote.items.forEach(function (item) {
          var cartItem = state.cart.find(function (entry) { return entry.productId === item.productId; });
          if (cartItem) cartItem.quantity = Math.max(0, cartItem.quantity - item.quantity);
        });
        state.cart = state.cart.filter(function (item) { return item.quantity > 0; });
      });
      activeOrderId = orderId;
      window.history.replaceState(null, "", "salesInvoice.html?order=" + encodeURIComponent(orderId));
      renderInvoice();
      notice("Demo purchase order saved. No payment has been taken and no supplier order was sent.");
    });
    document.getElementById("print-invoice").addEventListener("click", function () { window.print(); });
  }
  var serviceDetails = {
    "User DIY Delivery Service": ["Delivery address", "Enter the full delivery address.", "Instructions (optional)", "Delivery request for the selected order. Installation is your responsibility; confirm compatibility and follow professional guidance."],
    "Home Installation Service": ["Installation address", "Enter the address where installation is requested.", "Work required / instructions", "Request a mobile installation visit. A provider must confirm that the work can safely be performed at your location."],
    "Hub Installation Service": ["Preferred hub / area", "Enter your preferred hub name or area. No real hub locations are configured.", "Work required / instructions", "Request installation at a preferred service hub. The provider must confirm the location, appointment and service price."],
    "Towing Service": ["Vehicle pickup location", "Enter the exact pickup address or landmark.", "Destination / transport details", "A planned transport request only, not an emergency recovery service. Include the destination and vehicle condition in your notes."]
  };
  function renderBookingService() {
    var form = document.getElementById("booking-form");
    var details = serviceDetails[form.elements.service.value];
    document.getElementById("booking-address-label").textContent = details[0];
    document.getElementById("booking-location-help").textContent = details[1];
    document.getElementById("booking-notes-label").textContent = details[2];
    document.getElementById("booking-service-description").textContent = details[3];
    form.elements.notes.required = form.elements.service.value !== "User DIY Delivery Service";
  }
  function fillBookingContact() {
    var state = store.get();
    var form = document.getElementById("booking-form");
    var order = state.orders.find(function (entry) { return entry.id === form.elements.orderId.value; });
    if (order) Object.keys(order.customer).forEach(function (key) { form.elements[key].value = order.customer[key]; });
  }
  function renderBookingRecords() {
    var container = document.getElementById("booking-records");
    container.replaceChildren();
    var state = store.get();
    state.bookings.slice().reverse().forEach(function (entry) {
      var car = state.cars.find(function (item) { return item.id === entry.carId; });
      var card = element("article", undefined, "record");
      card.append(element("strong", entry.service), element("p", car.name + " · " + displayDate(entry.date) + " · " + entry.time), element("p", entry.customer.address), element("span", "Local request · not confirmed", "badge"));
      container.append(card);
    });
    if (!container.children.length) empty(container, "No service requests saved yet.");
  }
  function initializeBooking() {
    var state = store.get();
    var form = document.getElementById("booking-form");
    selectOptions(form.elements.carId, state.cars.map(function (car) { return { id: car.id, label: car.name + " · " + car.registration }; }), "Select your vehicle", state.selectedCar);
    var requestedOrderId = new URLSearchParams(window.location.search).get("order");
    selectOptions(form.elements.orderId, state.orders.map(function (order) { return { id: order.id, label: shortId(order.id) + " · " + store.money(store.total(order.items)) }; }), "No related order", requestedOrderId);
    form.elements.date.min = store.today();
    form.elements.date.value = store.today();
    if (!state.cars.length) {
      document.getElementById("booking-submit").disabled = true;
      notice("Add a car in your garage before booking a service.", true);
    } else if (requestedOrderId && !state.orders.some(function (order) { return order.id === requestedOrderId; })) {
      notice("The linked purchase order was not found. Select a saved order or continue without one.", true);
    }
    form.querySelectorAll('[name="service"]').forEach(function (radio) { radio.addEventListener("change", renderBookingService); });
    form.elements.orderId.addEventListener("change", fillBookingContact);
    fillBookingContact();
    renderBookingService();
    renderBookingRecords();
    submit("booking-form", function (values) {
      requireText(values, ["name", "email", "phone", "address", "carId"]);
      if (values.service !== "User DIY Delivery Service") requireText(values, ["notes"]);
      if (new Date(values.date + "T" + values.time).getTime() <= Date.now()) throw new Error("Choose a requested date and time in the future.");
      store.update(function (next) {
        if (next.bookings.some(function (booking) {
          return booking.carId === values.carId && booking.service === values.service &&
            booking.date === values.date && booking.time === values.time;
        })) throw new Error("A request for this vehicle, service and time has already been saved.");
        next.bookings.push({ id: store.id("booking"), carId: values.carId, orderId: values.orderId, service: values.service, date: values.date, time: values.time, customer: customer(values), notes: values.notes });
      });
      renderBookingRecords();
      notice("Service request saved locally. This is not a confirmed appointment; contact a provider to arrange service.");
    });
  }

  renderShell();
  renderCatalogue();
  if (page === "member") initializeMember();
  if (page === "cart") renderCart();
  if (page === "rfq") initializeRfq();
  if (page === "invoice") initializeInvoice();
  if (page === "booking") initializeBooking();
  if (store.error()) notice(store.error(), true);
  window.addEventListener("drivecore:change", function () {
    document.getElementById("member-cart-count").textContent = " (" + store.count() + ")";
  });
  window.addEventListener("pageshow", function (event) {
    if (event.persisted) window.location.reload();
  });
});
