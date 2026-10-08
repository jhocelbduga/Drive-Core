"use strict";

(function (root) {
  var DAY = 86400000;
  var branches = [
    { id: "north", name: "North London", hub: "london", city: "London", lat: 51.59, lon: -0.12 },
    { id: "south", name: "South London", hub: "london", city: "London", lat: 51.43, lon: -0.07 },
    { id: "central", name: "Birmingham Central", hub: "midlands", city: "Birmingham", lat: 52.49, lon: -1.9 },
    { id: "west", name: "Coventry West", hub: "midlands", city: "Coventry", lat: 52.4, lon: -1.51 }
  ];
  var products = [
    { id: "oil", name: "5W-30 Engine Oil", category: "Engine care", price: 3499, cost: 1900, reorder: 12, max: 90 },
    { id: "pads", name: "Ceramic Brake Pads", category: "Brake parts", price: 4599, cost: 2500, reorder: 10, max: 80 },
    { id: "filter", name: "Air Filter", category: "Filters", price: 1599, cost: 680, reorder: 15, max: 75 },
    { id: "wipers", name: "Wiper Blade Set", category: "Visibility", price: 1899, cost: 840, reorder: 10, max: 70 },
    { id: "battery", name: "12V Car Battery", category: "Electrical", price: 11999, cost: 8200, reorder: 5, max: 35 },
    { id: "wash", name: "Detailing Wash Kit", category: "Car care", price: 2499, cost: 1120, reorder: 8, max: 65 },
    { id: "bulbs", name: "LED Headlight Pair", category: "Electrical", price: 2999, cost: 1500, reorder: 10, max: 60 },
    { id: "tools", name: "Mechanic Tool Set", category: "Tools", price: 6999, cost: 4100, reorder: 6, max: 45 }
  ];
  var services = [
    { id: "pms", name: "Preventive maintenance", category: "Maintenance", price: 12999, cost: 5800, duration: 120 },
    { id: "alignment", name: "Tyre alignment", category: "Wheel services", price: 5499, cost: 2100, duration: 45 },
    { id: "installation", name: "Home installation", category: "Installation", price: 7999, cost: 3900, duration: 75 },
    { id: "towing", name: "Planned towing", category: "Recovery", price: 11999, cost: 7200, duration: 90 }
  ];
  var roles = {
    product: { name: "Product Owner", branches: ["north", "south", "central", "west"], sections: ["executive", "intelligence", "insights", "inventory", "sales", "services", "branches", "financial", "reports"] },
    hub: { name: "Hub Owner", branches: ["north", "south"], sections: ["executive", "intelligence", "insights", "inventory", "sales", "services", "branches", "financial", "reports"] },
    branch: { name: "Branch Owner", branches: ["north"], sections: ["executive", "intelligence", "insights", "inventory", "sales", "services", "branches", "financial", "reports"] },
    provider: { name: "Service Provider", branches: ["north"], technician: "north-tech-1", sections: ["executive", "intelligence", "insights", "sales", "services", "financial", "reports"] }
  };
  function iso(date) {
    return typeof date === "string" ? date : date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
  }
  function shift(date, days) { return new Date(Date.parse(date + "T00:00:00Z") + days * DAY).toISOString().slice(0, 10); }
  function daysBetween(start, end) { return Math.round((Date.parse(end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / DAY); }
  function range(today, preset) {
    var start;
    if (preset === "today") start = today;
    else if (preset === "week") {
      var day = new Date(today + "T12:00:00Z").getUTCDay();
      start = shift(today, -(day === 0 ? 6 : day - 1));
    } else if (preset === "month") start = today.slice(0, 7) + "-01";
    else if (preset === "year") start = today.slice(0, 4) + "-01-01";
    else start = shift(today, -(Number(preset) - 1));
    return { start: start, end: today };
  }
  function previous(period) {
    var days = daysBetween(period.start, period.end) + 1;
    return { start: shift(period.start, -days), end: shift(period.start, -1) };
  }
  function sum(list, selector) { return list.reduce(function (total, item) { return total + selector(item); }, 0); }
  function divide(numerator, denominator) { return denominator ? numerator / denominator : 0; }
  function pctChange(current, prior) { return prior === 0 ? null : (current - prior) / prior * 100; }
  function itemInfo(id, kind) { return (kind === "service" ? services : products).find(function (item) { return item.id === id; }); }
  function netLine(item) { return item.price * item.quantity - item.discount - item.refund; }
  function scopedBranches(role, branchId) {
    if (!roles[role]) throw new Error("Unknown dashboard role.");
    if (branchId !== "all" && !roles[role].branches.includes(branchId)) throw new Error("That branch is outside the selected demo role's scope.");
    return branches.filter(function (branch) { return roles[role].branches.includes(branch.id) && (branchId === "all" || branch.id === branchId); });
  }
  function scopeOrders(data, role, branchId) {
    var ids = scopedBranches(role, branchId).map(function (branch) { return branch.id; });
    return data.orders.filter(function (order) { return ids.includes(order.branchId); }).map(function (order) {
      var items = order.items.filter(function (item) { return !roles[role].technician || item.technicianId === roles[role].technician; });
      return Object.assign({}, order, { items: items });
    }).filter(function (order) { return order.items.length; });
  }
  function inRange(date, period) { return date >= period.start && date <= period.end; }
  function ordersIn(data, role, branchId, period) { return scopeOrders(data, role, branchId).filter(function (order) { return inRange(order.date, period); }); }

  function seed(today) {
    today = today || iso(new Date());
    var seedNumber = 59131;
    function random() { seedNumber = (seedNumber * 1664525 + 1013904223) >>> 0; return seedNumber / 4294967296; }
    function integer(min, max) { return min + Math.floor(random() * (max - min + 1)); }
    var data = { today: today, start: shift(today, -729), orders: [], expenses: [], movements: [], technicians: [], revision: 0 };
    var balances = {};
    function movement(date, branchId, productId, quantity, type, reference) {
      var key = branchId + ":" + productId;
      balances[key] = (balances[key] || 0) + quantity;
      data.movements.push({ id: "movement-" + (data.movements.length + 1), date: date, branchId: branchId, productId: productId, quantity: quantity, type: type, reference: reference, balance: balances[key] });
    }
    branches.forEach(function (branch) {
      for (var t = 1; t <= 2; t += 1) data.technicians.push({ id: branch.id + "-tech-" + t, branchId: branch.id, name: ["Alex", "Jamie"][t - 1] + " · " + branch.name, minutesPerDay: 480 });
      products.forEach(function (product) { movement(data.start, branch.id, product.id, integer(35, 80), "Opening balance", "Demo opening inventory"); });
    });
    for (var offset = 0; offset <= 729; offset += 1) {
      var date = shift(data.start, offset);
      branches.forEach(function (branch, branchIndex) {
        var volume = 1 + integer(0, 2) + (offset > 640 ? 1 : 0) + (branchIndex === 0 ? 1 : 0);
        for (var n = 0; n < volume; n += 1) {
          var status = date > shift(today, -4) ? ["completed", "completed", "pending", "cancelled"][integer(0, 3)] : random() < .08 ? "cancelled" : "completed";
          var order = { id: "DC-" + String(data.orders.length + 10001), date: date, hour: integer(8, 18), branchId: branch.id, customerId: "customer-" + integer(1, 820), segment: "", status: status, payment: ["Card", "Bank transfer", "Cash", "Wallet"][integer(0, 3)], paid: status === "completed" && random() > .12, items: [] };
          var isService = random() < .38;
          var info = isService ? services[integer(0, services.length - 1)] : products[integer(0, 5)];
          var quantity = isService ? 1 : integer(1, 3);
          var line = { kind: isService ? "service" : "product", id: info.id, price: info.price, cost: info.cost, quantity: quantity, discount: random() < .25 ? Math.round(info.price * quantity * .07) : 0, refund: status === "completed" && random() < .025 ? Math.round(info.price * quantity * .2) : 0 };
          if (isService) {
            line.technicianId = branch.id + "-tech-" + integer(1, 2);
            line.serviceStatus = status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : random() < .55 ? "ongoing" : "pending";
            line.minutes = info.duration + integer(-10, 35);
            line.rating = status === "completed" && random() < .7 ? integer(3, 5) : null;
          }
          order.items.push(line);
          order.segment = Number(order.customerId.split("-")[1]) % 3 === 0 ? "Fleet" : "Retail";
          data.orders.push(order);
          if (!isService && status === "completed") {
            if (balances[branch.id + ":" + info.id] < quantity + info.reorder) movement(date, branch.id, info.id, 45, "Stock in", "Supplier replenishment");
            movement(date, branch.id, info.id, -quantity, "Stock out", order.id);
          }
        }
        data.expenses.push({ id: "expense-" + data.expenses.length, date: date, branchId: branch.id, category: ["Rent & utilities", "Operations", "Marketing"][offset % 3], amount: integer(1800, 5500) });
      });
    }
    products.forEach(function (product, index) {
      var amount = 4 + index;
      movement(today, "north", product.id, amount, "Transfer in", "TRANSFER-" + index + " from South London");
      movement(today, "south", product.id, -amount, "Transfer out", "TRANSFER-" + index + " to North London");
    });
    branches.forEach(function (branch, branchIndex) {
      products.forEach(function (product, index) {
        var target = [0, 4, 11, 34, 8, 110, 65, 43][(index + branchIndex) % 8];
        var difference = target - balances[branch.id + ":" + product.id];
        if (difference) movement(today, branch.id, product.id, difference, "Count adjustment", "Demo inventory reconciliation");
      });
    });
    return data;
  }

  function metrics(data, role, branchId, period) {
    var history = scopeOrders(data, role, branchId);
    var orders = history.filter(function (order) { return inRange(order.date, period); });
    var completed = orders.filter(function (order) { return order.status === "completed"; });
    var lines = completed.flatMap(function (order) { return order.items; });
    var customers = new Set(completed.map(function (order) { return order.customerId; }));
    var priorCustomers = new Set(history.filter(function (order) { return order.date < period.start && order.status === "completed"; }).map(function (order) { return order.customerId; }));
    var previousPeriod = previous(period);
    var previousCustomers = new Set(history.filter(function (order) { return inRange(order.date, previousPeriod) && order.status === "completed"; }).map(function (order) { return order.customerId; }));
    var returning = Array.from(customers).filter(function (id) { return priorCustomers.has(id); }).length;
    var retained = Array.from(previousCustomers).filter(function (id) { return customers.has(id); }).length;
    var branchIds = scopedBranches(role, branchId).map(function (branch) { return branch.id; });
    var gross = sum(lines, function (item) { return item.price * item.quantity; });
    var discounts = sum(lines, function (item) { return item.discount; });
    var refunds = sum(lines, function (item) { return item.refund; });
    var cost = sum(lines, function (item) { return item.cost * item.quantity; });
    var net = gross - discounts - refunds;
    var commission = sum(lines.filter(function (item) { return item.kind === "service"; }), function (item) { return Math.round(netLine(item) * .05); });
    var expenses = roles[role].technician ? 0 : sum(data.expenses.filter(function (entry) { return branchIds.includes(entry.branchId) && inRange(entry.date, period); }), function (entry) { return entry.amount; });
    var collected = sum(completed.filter(function (order) { return order.paid; }), function (order) { return sum(order.items, netLine); });
    return {
      orders: orders.length, completed: completed.length, pending: orders.filter(function (order) { return order.status === "pending"; }).length,
      cancelled: orders.filter(function (order) { return order.status === "cancelled"; }).length,
      gross: gross, discounts: discounts, refunds: refunds, net: net, cost: cost,
      grossProfit: net - cost, expenses: expenses, commission: commission, netProfit: net - cost - expenses - commission,
      margin: divide(net - cost - expenses - commission, net) * 100, aov: divide(net, completed.length),
      customers: customers.size, returning: returning, newCustomers: customers.size - returning,
      retention: divide(retained, previousCustomers.size) * 100, retained: retained, previousCustomers: previousCustomers.size,
      collected: collected, outstanding: net - collected, cashFlow: collected - cost - expenses - commission
    };
  }
  function groupSales(data, role, branchId, period, dimension) {
    var groups = new Map();
    ordersIn(data, role, branchId, period).filter(function (order) { return order.status === "completed"; }).forEach(function (order) {
      order.items.forEach(function (item) {
        var info = itemInfo(item.id, item.kind);
        var key = dimension === "category" ? info.category : dimension === "payment" ? order.payment : dimension === "segment" ? order.segment : dimension === "kind" ? (item.kind === "product" ? "Parts & accessories" : "Services") : info.name;
        if ((dimension === "product" && item.kind !== "product") || (dimension === "service" && item.kind !== "service")) return;
        if (!groups.has(key)) groups.set(key, { name: key, revenue: 0, profit: 0, commission: 0, quantity: 0, orders: new Set() });
        var group = groups.get(key);
        group.revenue += netLine(item);
        group.profit += netLine(item) - item.cost * item.quantity;
        group.commission += item.kind === "service" ? Math.round(netLine(item) * .05) : 0;
        group.quantity += item.quantity;
        group.orders.add(order.id);
      });
    });
    return Array.from(groups.values()).map(function (group) { return Object.assign({}, group, { orders: group.orders.size }); }).sort(function (a, b) { return b.revenue - a.revenue; });
  }
  function series(data, role, branchId, period, interval) {
    var days = daysBetween(period.start, period.end) + 1;
    interval = interval || (days > 120 ? "month" : days > 35 ? "week" : "day");
    var groups = new Map();
    function bucket(date) {
      return interval === "month" ? date.slice(0, 7) : interval === "week" ? shift(period.start, Math.floor(daysBetween(period.start, date) / 7) * 7) : date;
    }
    for (var i = 0; i < days; i += 1) {
      var key = bucket(shift(period.start, i));
      if (!groups.has(key)) groups.set(key, { label: key, value: 0 });
    }
    ordersIn(data, role, branchId, period).filter(function (order) { return order.status === "completed"; }).forEach(function (order) {
      groups.get(bucket(order.date)).value += sum(order.items, netLine);
    });
    return Array.from(groups.values());
  }
  function inventory(data, role, branchId, end) {
    if (roles[role].technician) return [];
    end = end || data.today;
    var selected = scopedBranches(role, branchId);
    var sold = ordersIn(data, role, branchId, { start: shift(end, -29), end: end }).filter(function (order) { return order.status === "completed"; });
    return selected.flatMap(function (branch) {
      return products.map(function (product, index) {
        var movements = data.movements.filter(function (entry) { return entry.branchId === branch.id && entry.productId === product.id && entry.date <= end; });
        var lots = [];
        movements.forEach(function (entry) {
          if (entry.quantity > 0) lots.push({ date: entry.date, quantity: entry.quantity });
          else {
            var remaining = -entry.quantity;
            while (remaining > 0 && lots.length) {
              var used = Math.min(remaining, lots[0].quantity);
              remaining -= used;
              lots[0].quantity -= used;
              if (lots[0].quantity === 0) lots.shift();
            }
          }
        });
        var quantity = sum(movements, function (entry) { return entry.quantity; });
        var soldUnits = sum(sold.filter(function (order) { return order.branchId === branch.id; }).flatMap(function (order) { return order.items.filter(function (item) { return item.kind === "product" && item.id === product.id; }); }), function (item) { return item.quantity; });
        var rate = soldUnits / 30;
        var counted = Math.max(0, quantity + (index % 4 === 0 ? 2 : 0));
        return {
          branchId: branch.id, branch: branch.name, id: product.id, name: product.name, category: product.category,
          quantity: quantity, counted: counted, value: quantity * product.cost, cost: product.cost, reorder: product.reorder, max: product.max,
          sold: soldUnits, rate: rate, daysCover: rate ? quantity / rate : null, age: lots.length ? daysBetween(lots[0].date, end) : 0,
          status: quantity === 0 ? "Out of stock" : quantity <= product.reorder ? "Low stock" : quantity > product.max ? "Overstock" : "Healthy",
          speed: rate >= 1 ? "Fast-moving" : rate < .2 ? "Slow-moving" : "Steady"
        };
      });
    });
  }
  function inventoryMetrics(data, role, branchId, period) {
    var stock = inventory(data, role, branchId, period.end);
    var opening = inventory(data, role, branchId, shift(period.start, -1));
    var productCost = sum(ordersIn(data, role, branchId, period).filter(function (order) { return order.status === "completed"; }).flatMap(function (order) { return order.items.filter(function (item) { return item.kind === "product"; }); }), function (item) { return item.cost * item.quantity; });
    var valuation = sum(stock, function (item) { return item.value; });
    var average = (valuation + sum(opening, function (item) { return item.value; })) / 2;
    return { valuation: valuation, units: sum(stock, function (item) { return item.quantity; }), low: stock.filter(function (item) { return item.status === "Low stock"; }).length,
      out: stock.filter(function (item) { return item.status === "Out of stock"; }).length, over: stock.filter(function (item) { return item.status === "Overstock"; }).length,
      turnover: divide(productCost, average), accuracy: divide(stock.filter(function (item) { return item.counted === item.quantity; }).length, stock.length) * 100,
      health: divide(stock.filter(function (item) { return item.status === "Healthy"; }).length, stock.length) * 100 };
  }
  function serviceMetrics(data, role, branchId, period) {
    var selected = scopedBranches(role, branchId).map(function (branch) { return branch.id; });
    var bookings = ordersIn(data, role, branchId, period).flatMap(function (order) { return order.items.filter(function (item) { return item.kind === "service"; }).map(function (item) { return Object.assign({}, item, { orderId: order.id, date: order.date, branchId: order.branchId }); }); });
    var completed = bookings.filter(function (item) { return item.serviceStatus === "completed"; });
    var technicians = data.technicians.filter(function (tech) { return selected.includes(tech.branchId) && (!roles[role].technician || tech.id === roles[role].technician); });
    var workingDays = 0;
    for (var date = period.start; date <= period.end; date = shift(date, 1)) workingDays += 1;
    var ratings = completed.filter(function (item) { return item.rating !== null; });
    return { total: bookings.length, completed: completed.length, ongoing: bookings.filter(function (item) { return item.serviceStatus === "ongoing"; }).length,
      pending: bookings.filter(function (item) { return item.serviceStatus === "pending"; }).length,
      cancelled: bookings.filter(function (item) { return item.serviceStatus === "cancelled"; }).length,
      revenue: sum(completed, netLine), duration: divide(sum(completed, function (item) { return item.minutes; }), completed.length),
      rating: ratings.length ? sum(ratings, function (item) { return item.rating; }) / ratings.length : null, ratingCount: ratings.length,
      utilization: divide(sum(bookings.filter(function (item) { return item.serviceStatus === "completed" || item.serviceStatus === "ongoing"; }), function (item) { return item.minutes; }), technicians.length * workingDays * 480) * 100,
      bookings: bookings, technicians: technicians.map(function (tech) {
        var own = bookings.filter(function (item) { return item.technicianId === tech.id; });
        var done = own.filter(function (item) { return item.serviceStatus === "completed"; });
        return { name: tech.name, completed: done.length, revenue: sum(done, netLine), duration: divide(sum(done, function (item) { return item.minutes; }), done.length),
          utilization: divide(sum(own.filter(function (item) { return ["completed", "ongoing"].includes(item.serviceStatus); }), function (item) { return item.minutes; }), workingDays * tech.minutesPerDay) * 100 };
      }) };
  }
  function forecast(data, role, branchId) {
    var points = series(data, role, branchId, { start: shift(data.today, -29), end: data.today }, "day");
    var older = sum(points.slice(0, 23), function (point) { return point.value; }) / 23;
    var recent = sum(points.slice(-7), function (point) { return point.value; }) / 7;
    var dailyChange = Math.max(-recent * .03, Math.min(recent * .03, (recent - older) / 23));
    var result = [];
    for (var day = 1; day <= 7; day += 1) {
      var value = Math.max(0, Math.round(recent + dailyChange * day));
      result.push({ label: shift(data.today, day), value: value, low: Math.round(value * .75), high: Math.round(value * 1.25) });
    }
    return { history: points.slice(-14), prediction: result };
  }
  function insights(data, role, branchId, period) {
    var current = metrics(data, role, branchId, period);
    var prior = metrics(data, role, branchId, previous(period));
    var growth = pctChange(current.net, prior.net);
    var top = groupSales(data, role, branchId, period, roles[role].technician ? "service" : "product")[0];
    var stock = inventory(data, role, branchId, data.today);
    var low = stock.filter(function (item) { return item.status === "Out of stock" || item.status === "Low stock"; });
    var over = stock.filter(function (item) { return item.status === "Overstock"; });
    var messages = [
      { title: "Selected-period performance", tone: growth !== null && growth < 0 ? "warning" : "positive", text: growth === null ? "No comparable prior-period revenue. A growth percentage cannot be calculated." : "Net sales " + (growth >= 0 ? "grew " : "fell ") + Math.abs(growth).toFixed(1) + "% versus the previous equal-length period. Compare product mix and completed-order volume before changing prices." },
      { title: "Sales opportunity", tone: "positive", text: top ? top.name + " leads the selected period with " + top.quantity + " units or bookings. Review availability and consider relevant bundles; this is an observed leader, not a guaranteed future bestseller." : "No completed sales in this scope. Review pending orders and follow up with customers." },
      { title: "Customer retention", tone: "neutral", text: current.retained + " of " + current.previousCustomers + " customers from the previous equal-length period returned (" + current.retention.toFixed(1) + "%). Consider follow-up maintenance reminders with customer consent." }
    ];
    if (stock.length) {
      var urgent = low.slice().sort(function (a, b) { return (a.daysCover === null ? Infinity : a.daysCover) - (b.daysCover === null ? Infinity : b.daysCover); })[0];
      messages.push({ title: "Replenishment watch", tone: "warning", text: urgent ? urgent.name + " at " + urgent.branch + " has " + urgent.quantity + " units remaining. " + (urgent.daysCover === null ? "No sales in the trailing 30 days; depletion time cannot be estimated." : "At its trailing 30-day rate, stock cover is approximately " + urgent.daysCover.toFixed(1) + " days.") + " Validate supplier lead times before replenishing." : "No low or out-of-stock SKUs in the current inventory scope." });
      messages.push({ title: "Overstock opportunity", tone: "neutral", text: over.length ? over.length + " branch/SKU positions exceed their maximum stock threshold. Review transfers and measured demand before ordering more." : "All stock positions are below their maximum thresholds." });
    }
    var ranking = scopedBranches(role, branchId).map(function (branch) { return { name: branch.name, result: metrics(data, role, branch.id, period) }; }).sort(function (a, b) { return b.result.netProfit - a.result.netProfit; });
    messages.push({ title: "Profitability action", tone: current.netProfit < 0 ? "warning" : "positive", text: ranking.length ? ranking[0].name + " has the highest in-scope net profit. Review operating costs, discounting and uncollected balances; revenue alone is not a measure of branch health." : "No branch data available." });
    return messages;
  }
  function simulate(data) {
    var pending = data.orders.find(function (order) { return order.status === "pending" && order.items[0].kind === "service"; });
    if (pending) {
      pending.status = "completed";
      pending.paid = true;
      pending.items.forEach(function (item) { item.serviceStatus = "completed"; item.rating = 4; });
    }
    data.revision += 1;
    var info = services[data.revision % services.length];
    var branch = branches[data.revision % branches.length];
    data.orders.push({ id: "LIVE-" + data.revision, date: data.today, hour: new Date().getHours(), branchId: branch.id,
      customerId: "demo-live-" + data.revision, segment: "Retail", status: "pending", payment: "Card", paid: false,
      items: [{ id: info.id, kind: "service", quantity: 1, price: info.price, cost: info.cost, discount: 0, refund: 0, technicianId: branch.id + "-tech-1", serviceStatus: "ongoing", minutes: info.duration, rating: null }] });
    return "Added a simulated service order at " + branch.name + (pending ? " and completed " + pending.id + "." : ".");
  }
  var api = { branches: branches, products: products, services: services, roles: roles, iso: iso, shift: shift, daysBetween: daysBetween,
    range: range, previous: previous, sum: sum, divide: divide, pctChange: pctChange, itemInfo: itemInfo, netLine: netLine,
    scopedBranches: scopedBranches, scopeOrders: scopeOrders, ordersIn: ordersIn, seed: seed, metrics: metrics,
    groupSales: groupSales, series: series, inventory: inventory, inventoryMetrics: inventoryMetrics,
    serviceMetrics: serviceMetrics, forecast: forecast, insights: insights, simulate: simulate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DriveCoreAnalytics = api;
})(typeof window !== "undefined" ? window : globalThis);
