"use strict";

document.addEventListener("DOMContentLoaded", function () {
  var A = window.DriveCoreAnalytics;
  var data = A.seed();
  var role = "product";
  var branch = "all";
  var preset = "30";
  var section = "executive";
  var stockFilter = "All stock";
  var chartMode = "area";
  var timer = null;
  var updatedAt = new Date();
  var colors = ["#2362d3", "#3cbca1", "#edb94c", "#9887de", "#e68597", "#53a8c8", "#617fa5", "#bf8950"];
  var names = {
    executive: ["Executive overview", "Monitor performance, spot opportunities and keep every branch moving."],
    intelligence: ["Business intelligence", "Turn transactions into a clearer view of growth, customers and demand."],
    insights: ["AI-powered insights · demo", "Explainable, rule-based summaries and baseline forecasts. No AI model is connected."],
    inventory: ["Inventory intelligence", "Track stock movement, capital tied up in inventory and replenishment signals."],
    sales: ["Sales analytics", "Explore sales by time, category, payment method and customer segment."],
    services: ["Service operations", "Monitor bookings, technician capacity and the customer experience."],
    branches: ["Branch network", "Compare performance and operational health across your permitted demo scope."],
    financial: ["Financial health", "Understand the path from gross revenue to profit and collected cash."],
    reports: ["Reports & exports", "Create scoped reports as CSV, genuine Excel workbooks or printable PDF summaries."]
  };
  var content = document.getElementById("dashboard-content");
  function el(tag, text, className) {
    var node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function svg(tag, attrs, text) {
    var node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs || {}).forEach(function (name) { node.setAttribute(name, attrs[name]); });
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, action, className) {
    var node = el("button", text, className || "button secondary");
    node.type = "button";
    node.addEventListener("click", function () { attempt(action); });
    return node;
  }
  function money(value) { return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 }).format(value / 100); }
  function exactMoney(value) { return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(value / 100); }
  function number(value, digits) { return new Intl.NumberFormat("en-GB", { maximumFractionDigits: digits || 0 }).format(value); }
  function percentage(value) { return number(value, 1) + "%"; }
  function prettyDate(date) { return new Date(date + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); }
  function period() { return A.range(data.today, preset); }
  function metrics(reportPeriod) { return A.metrics(data, role, branch, reportPeriod || period()); }
  function grouped(dimension, reportPeriod) { return A.groupSales(data, role, branch, reportPeriod || period(), dimension); }
  function notify(message, error) {
    var notice = document.getElementById("dashboard-notice");
    notice.hidden = false;
    notice.className = "notification" + (error ? " error" : "");
    notice.setAttribute("role", error ? "alert" : "status");
    notice.textContent = message;
  }
  function attempt(action) { try { action(); } catch (error) { notify(error.message, true); } }
  function badge(text, tone) { return el("span", text, "badge " + (tone || "")); }
  function statusTone(status) {
    return ["completed", "Healthy", "Fast-moving"].includes(status) ? "positive" : ["cancelled", "Out of stock"].includes(status) ? "negative" : ["Low stock", "Overstock", "pending", "ongoing"].includes(status) ? "warning" : "";
  }
  function panel(title, subtitle, tag) {
    var node = el("section", undefined, "panel");
    var head = el("div", undefined, "panel-head");
    var copy = el("div");
    copy.append(el("h2", title));
    if (subtitle) copy.append(el("p", subtitle, "panel-subtitle"));
    head.append(copy);
    if (tag) head.append(el("span", tag, "panel-tag"));
    node.append(head);
    return node;
  }
  function appendPanel(node) {
    var wrapper = el("div", undefined, "section-gap");
    wrapper.append(node);
    content.append(wrapper);
  }
  function table(headers, rows, numericColumns, caption) {
    var wrap = el("div", undefined, "table-wrap");
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", caption || "Report data");
    var node = el("table");
    var head = el("thead");
    var headRow = el("tr");
    headers.forEach(function (header, index) {
      var cell = el("th", header, numericColumns && numericColumns.includes(index) ? "numeric" : "");
      cell.scope = "col";
      headRow.append(cell);
    });
    head.append(headRow);
    var body = el("tbody");
    rows.forEach(function (row) {
      var tr = el("tr");
      row.forEach(function (value, index) {
        var cell = el("td", undefined, numericColumns && numericColumns.includes(index) ? "numeric" : "");
        if (value instanceof Node) cell.append(value);
        else cell.textContent = value === null || value === undefined ? "—" : String(value);
        tr.append(cell);
      });
      body.append(tr);
    });
    if (!rows.length) {
      var row = el("tr");
      var cell = el("td", "No records in this reporting scope.", "empty");
      cell.colSpan = headers.length;
      row.append(cell);
      body.append(row);
    }
    node.append(head, body);
    wrap.append(node);
    return wrap;
  }
  function kpi(title, value, detail, growth, accent) {
    var card = el("article", undefined, "kpi" + (accent ? " accent" : ""));
    card.append(el("p", title, "kpi-label"), el("strong", value, "kpi-value"));
    var foot = el("div", undefined, "kpi-foot");
    if (growth !== undefined) foot.append(el("span", growth === null ? "No baseline" : (growth >= 0 ? "↗ " : "↘ ") + Math.abs(growth).toFixed(1) + "%", "trend " + (growth === null ? "neutral" : growth < 0 ? "negative" : "")));
    foot.append(el("span", detail));
    card.append(foot);
    return card;
  }
  function kpis(values) {
    var grid = el("div", undefined, "kpi-grid");
    values.forEach(function (value) { grid.append(kpi.apply(null, value)); });
    return grid;
  }
  function chartBase(title, width, height) {
    var figure = el("figure", undefined, "chart");
    var canvas = svg("svg", { viewBox: "0 0 " + width + " " + height, role: "img", "aria-label": title });
    canvas.append(svg("title", {}, title));
    var tooltip = el("div", "Hover or focus chart marks for exact values.", "chart-tooltip");
    tooltip.setAttribute("aria-live", "polite");
    figure.append(canvas, tooltip);
    return { figure: figure, canvas: canvas, tooltip: tooltip };
  }
  function point(node, text, tooltip, action) {
    node.setAttribute("tabindex", "0");
    node.setAttribute("role", action ? "button" : "img");
    node.setAttribute("aria-label", text);
    node.append(svg("title", {}, text));
    node.addEventListener("mouseenter", function () { tooltip.textContent = text; });
    node.addEventListener("focus", function () { tooltip.textContent = text; });
    if (action) {
      node.addEventListener("click", function () { attempt(action); });
      node.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); attempt(action); }
      });
    }
  }
  function chartTable(figure, headers, rows) {
    var details = el("details", undefined, "chart-data");
    details.append(el("summary", "View accessible chart data"), table(headers, rows, [1], "Chart source data"));
    figure.append(details);
  }
  function lineChart(points, title, mode, predictions) {
    var chart = chartBase(title, 620, 244);
    if (!points.length) { chart.figure.replaceChildren(el("p", "No data for this chart.", "empty")); return chart.figure; }
    var all = points.concat(predictions || []);
    var max = Math.max(1, Math.max.apply(null, all.map(function (entry) { return entry.high === undefined ? entry.value : entry.high; })) * 1.14);
    var left = 56, right = 602, top = 15, bottom = 209;
    function x(index) { return left + index * (right - left) / Math.max(1, all.length - 1); }
    function y(value) { return bottom - value / max * (bottom - top); }
    for (var step = 0; step < 5; step += 1) {
      var value = max * step / 4;
      chart.canvas.append(svg("line", { x1: left, x2: right, y1: y(value), y2: y(value), class: "gridline" }), svg("text", { x: 47, y: y(value) + 3, "text-anchor": "end" }, money(value)));
    }
    var path = points.map(function (entry, index) { return (index === 0 ? "M" : "L") + x(index) + "," + y(entry.value); }).join(" ");
    if (mode === "area") chart.canvas.append(svg("path", { d: path + " L" + x(points.length - 1) + "," + bottom + " L" + x(0) + "," + bottom + " Z", class: "area" }));
    chart.canvas.append(svg("path", { d: path, class: "line" }));
    if (predictions && predictions.length) {
      var predictionPath = "M" + x(points.length - 1) + "," + y(points[points.length - 1].value) + " " + predictions.map(function (entry, index) { return "L" + x(points.length + index) + "," + y(entry.value); }).join(" ");
      var band = predictions.map(function (entry, index) { return (index ? "L" : "M") + x(points.length + index) + "," + y(entry.high); }).join(" ") + " " +
        predictions.slice().reverse().map(function (entry, index) { return "L" + x(all.length - 1 - index) + "," + y(entry.low); }).join(" ") + " Z";
      chart.canvas.append(svg("path", { d: band, class: "forecast-band" }), svg("path", { d: predictionPath, class: "forecast-line" }));
    }
    all.forEach(function (entry, index) {
      var dot = svg("circle", { cx: x(index), cy: y(entry.value), r: all.length > 45 ? 2 : 3.5, fill: index >= points.length ? "#e9b844" : "#2362d3" });
      point(dot, entry.label + ": " + exactMoney(entry.value) + (entry.low !== undefined ? " projected; illustrative range " + exactMoney(entry.low) + "–" + exactMoney(entry.high) : ""), chart.tooltip);
      chart.canvas.append(dot);
      if (index === 0 || index === all.length - 1 || index % Math.ceil(all.length / 5) === 0) chart.canvas.append(svg("text", { x: x(index), y: 230, "text-anchor": index === 0 ? "start" : index === all.length - 1 ? "end" : "middle" }, entry.label.slice(5) || entry.label));
    });
    chartTable(chart.figure, ["Date / period", "Net revenue (GBP)", "Type"], all.map(function (entry, index) { return [entry.label, exactMoney(entry.value), index >= points.length ? "Forecast, not guaranteed" : "Observed demo sales"]; }));
    return chart.figure;
  }
  function bars(entries, title, valueKey, format, click) {
    var height = Math.max(150, entries.length * 35 + 18);
    var chart = chartBase(title, 560, height);
    if (!entries.length) { chart.figure.replaceChildren(el("p", "No completed sales in this scope.", "empty")); return chart.figure; }
    var max = Math.max(1, Math.max.apply(null, entries.map(function (entry) { return Math.abs(entry[valueKey]); })));
    entries.forEach(function (entry, index) {
      var y = 12 + index * 35;
      var label = entry.name.length > 23 ? entry.name.slice(0, 22) + "…" : entry.name;
      chart.canvas.append(svg("text", { x: 0, y: y + 14 }, label), svg("rect", { x: 160, y: y, width: 315, height: 21, fill: "var(--bg)", rx: 4 }));
      var bar = svg("rect", { x: 160, y: y, width: Math.max(2, Math.abs(entry[valueKey]) / max * 315), height: 21, rx: 4, fill: entry[valueKey] < 0 ? "#ca5263" : colors[index % colors.length] });
      point(bar, entry.name + ": " + format(entry[valueKey]), chart.tooltip, click ? function () { click(entry); } : null);
      chart.canvas.append(bar, svg("text", { x: 554, y: y + 14, "text-anchor": "end" }, format(entry[valueKey])));
    });
    chartTable(chart.figure, ["Group", "Value"], entries.map(function (entry) { return [entry.name, format(entry[valueKey])]; }));
    return chart.figure;
  }
  function donut(entries, title, mode) {
    var wrapper = el("div", undefined, "donut-wrap");
    var chart = chartBase(title, 180, 180);
    var total = A.sum(entries, function (entry) { return Math.max(0, entry.value); });
    if (!total) { wrapper.append(el("p", "No data to display.", "empty")); return wrapper; }
    var angle = -.25;
    var legend = el("div", undefined, "chart-legend");
    entries.forEach(function (entry, index) {
      var part = entry.value / total;
      var color = colors[index % colors.length];
      var mark;
      if (part >= .99999) mark = svg("circle", { cx: 90, cy: 90, r: 68, fill: mode === "pie" ? color : "none", stroke: color, "stroke-width": mode === "pie" ? 0 : 22 });
      else {
        var start = angle * Math.PI * 2;
        var end = (angle + part) * Math.PI * 2;
        var x1 = 90 + Math.cos(start) * 68, y1 = 90 + Math.sin(start) * 68;
        var x2 = 90 + Math.cos(end) * 68, y2 = 90 + Math.sin(end) * 68;
        var d = mode === "pie" ? "M90,90 L" + x1 + "," + y1 + " A68,68 0 " + (part > .5 ? 1 : 0) + " 1 " + x2 + "," + y2 + " Z" : "M" + x1 + "," + y1 + " A68,68 0 " + (part > .5 ? 1 : 0) + " 1 " + x2 + "," + y2;
        mark = svg("path", { d: d, fill: mode === "pie" ? color : "none", stroke: color, "stroke-width": mode === "pie" ? 0 : 22, "data-point": index });
      }
      point(mark, entry.name + ": " + percentage(part * 100) + " · " + exactMoney(entry.value), chart.tooltip);
      chart.canvas.append(mark);
      var label = el("span");
      var swatch = el("i");
      swatch.style.background = color;
      label.append(swatch, document.createTextNode(entry.name + " · " + percentage(part * 100)));
      legend.append(label);
      angle += part;
    });
    if (mode !== "pie") {
      chart.canvas.append(svg("text", { x: 90, y: 89, "text-anchor": "middle", style: "font-size:18px;font-weight:700;fill:var(--ink)" }, money(total)), svg("text", { x: 90, y: 108, "text-anchor": "middle" }, "NET REVENUE"));
    }
    chartTable(chart.figure, ["Group", "Net revenue"], entries.map(function (entry) { return [entry.name, exactMoney(entry.value)]; }));
    wrapper.append(chart.figure, legend);
    return wrapper;
  }
  function trendPanel(title, reportPeriod, mode) {
    var node = panel(title, "Completed sales, net of discounts and refunds. Hover or keyboard-focus points.", "GBP");
    node.append(lineChart(A.series(data, role, branch, reportPeriod || period()), title, mode || chartMode));
    return node;
  }
  function rankRows(dimension) {
    return grouped(dimension).map(function (entry) { return [entry.name, number(entry.quantity), exactMoney(entry.revenue), exactMoney(entry.profit), percentage(A.divide(entry.profit, entry.revenue) * 100)]; });
  }
  function branchRanking() {
    return A.scopedBranches(role, branch).map(function (entry) {
      var result = A.metrics(data, role, entry.id, period());
      var stock = A.inventoryMetrics(data, role, entry.id, period());
      var service = A.serviceMetrics(data, role, entry.id, period());
      return { id: entry.id, name: entry.name, revenue: result.net, profit: result.netProfit, margin: result.margin, health: stock.health, services: service.completed, satisfaction: service.rating, orders: result.completed };
    }).sort(function (a, b) { return b.revenue - a.revenue; });
  }
  function drillBranch(entry) {
    branch = entry.id;
    document.getElementById("branch-filter").value = branch;
    render();
    notify("Dashboard filtered to " + entry.name + ".");
  }
  function intelligenceSummary() {
    var insight = A.insights(data, role, branch, period());
    var node = el("section", undefined, "insight-banner");
    node.append(el("span", "✦", "insight-icon"));
    var copy = el("div");
    copy.append(el("h2", "Business pulse · rule-based insight"), el("p", insight[0].text + " " + insight[1].text));
    node.append(copy);
    return node;
  }
  function executive() {
    var m = metrics();
    var prior = metrics(A.previous(period()));
    var timeKPIs = [];
    [["Today", "today"], ["This week", "week"], ["This month", "month"], ["This year", "year"]].forEach(function (entry) {
      var p = A.range(data.today, entry[1]);
      var result = metrics(p);
      var baseline = metrics(A.previous(p));
      timeKPIs.push(["Total sales · " + entry[0], money(result.net), "vs preceding " + (A.daysBetween(p.start, p.end) + 1) + " days", A.pctChange(result.net, baseline.net), true]);
    });
    content.append(kpis(timeKPIs), intelligenceSummary());
    var charts = el("div", undefined, "chart-grid");
    var revenue = trendPanel("Revenue performance");
    var modeButtons = el("div", undefined, "heading-actions");
    ["line", "area"].forEach(function (mode) {
      var control = button(mode === "line" ? "Line" : "Area", function () { chartMode = mode; render(); });
      control.setAttribute("aria-pressed", String(chartMode === mode));
      modeButtons.append(control);
    });
    revenue.querySelector(".panel-head").append(modeButtons);
    var mix = panel("Revenue mix", "Parts, accessories and service contribution.", "Selected period");
    mix.append(donut(grouped("kind").map(function (entry) { return { name: entry.name, value: entry.revenue }; }), "Revenue mix"));
    charts.append(revenue, mix);
    content.append(charts, kpis([
      ["Gross revenue", money(m.gross), "Completed orders before reductions", A.pctChange(m.gross, prior.gross)],
      ["Net revenue", money(m.net), "Gross less discounts and refunds", A.pctChange(m.net, prior.net)],
      ["Total orders", number(m.orders), "All statuses · selected period", A.pctChange(m.orders, prior.orders)],
      ["Average order value", exactMoney(m.aov), "Net / completed orders", A.pctChange(m.aov, prior.aov)],
      ["Completed orders", number(m.completed), "Revenue-recognized orders"],
      ["Pending orders", number(m.pending), "Not recognized as revenue"],
      ["Cancelled orders", number(m.cancelled), "Excluded from revenue"],
      ["Total customers", number(m.customers), "Unique completed purchasers"],
      ["Returning customers", number(m.returning), "Purchased before selected period"],
      ["New customers", number(m.newCustomers), "First observed purchase in period"],
      ["Net profit", money(m.netProfit), role === "provider" ? "Direct contribution; shared costs excluded" : "After COGS, expenses & commission", A.pctChange(m.netProfit, prior.netProfit)],
      ["Customer retention", percentage(m.retention), m.retained + "/" + m.previousCustomers + " prior-period purchasers returned"]
    ]));
    var bottom = el("div", undefined, "equal-grid");
    var leaders = panel(role === "provider" ? "Best-performing services" : "Top-selling products", "Ranked by net completed sales.");
    leaders.append(table(["Item", "Units", "Revenue", "Gross profit", "Margin"], rankRows(role === "provider" ? "service" : "product").slice(0, 5), [1, 2, 3, 4], "Top sellers"));
    var branchesPanel = panel("Branch revenue ranking", "Select a bar to drill into its branch.");
    branchesPanel.append(bars(branchRanking(), "Branch revenue comparison", "revenue", money, drillBranch));
    bottom.append(leaders, branchesPanel);
    content.append(bottom, orderTablePanel());
  }
  function intelligence() {
    var m = metrics();
    var prior = metrics(A.previous(period()));
    content.append(kpis([
      ["Sales growth", A.pctChange(m.net, prior.net) === null ? "No baseline" : percentage(A.pctChange(m.net, prior.net)), "vs previous equal-length period"],
      ["Customer retention", percentage(m.retention), m.retained + " returning from " + m.previousCustomers + " prior-period customers"],
      ["Purchase frequency", number(A.divide(m.completed, m.customers), 2), "Completed orders / active customers"],
      ["Gross profit margin", percentage(A.divide(m.grossProfit, m.net) * 100), "Net revenue less direct cost"]
    ]));
    var row = el("div", undefined, "equal-grid");
    row.append(trendPanel("Revenue trend analysis"));
    var categories = panel("Profitable categories", "Gross profit before operating expenses and commission.");
    categories.append(bars(grouped("category").sort(function (a, b) { return b.profit - a.profit; }), "Category gross profit", "profit", money));
    row.append(categories);
    content.append(row);
    var productsPanel = panel("Product & service category performance", "Observed demand and profitability, not guaranteed future sales.", "Selected period");
    productsPanel.append(table(["Category", "Units / bookings", "Net revenue", "Gross profit", "Gross margin"], rankRows("category"), [1, 2, 3, 4], "Category performance"));
    appendPanel(productsPanel);
    var seasonalPeriod = { start: A.shift(data.today, -364), end: data.today };
    var seasons = trendPanel("Seasonal sales trends · last 365 days", seasonalPeriod, "area");
    seasons.append(el("p", "Partial calendar months are shown as observed totals; do not compare them to full months without normalization.", "muted"));
    var behavior = panel("Customer purchase behaviour", "Purchases in the selected period; prior history spans the seeded two years.");
    behavior.append(donut(grouped("segment").map(function (entry) { return { name: entry.name, value: entry.revenue }; }), "Revenue by customer segment", "pie"));
    var mini = el("div", undefined, "mini-metrics");
    [["New", m.newCustomers], ["Returning", m.returning], ["Retained", m.retained]].forEach(function (entry) {
      var item = el("div");
      item.append(el("strong", number(entry[1])), el("span", entry[0] + " customers"));
      mini.append(item);
    });
    behavior.append(mini);
    var row2 = el("div", undefined, "equal-grid");
    row2.append(seasons, behavior);
    content.append(row2);
    var row3 = el("div", undefined, "equal-grid");
    var productPanel = panel("Top-selling products", "By net revenue.");
    productPanel.append(table(["Product", "Units", "Net sales", "Gross profit", "Margin"], rankRows("product"), [1, 2, 3, 4], "Product leaders"));
    var servicePanel = panel("Best-performing services", "By net revenue.");
    servicePanel.append(table(["Service", "Bookings", "Net sales", "Gross profit", "Margin"], rankRows("service"), [1, 2, 3, 4], "Service leaders"));
    if (role !== "provider") row3.append(productPanel);
    row3.append(servicePanel);
    content.append(row3);
  }
  function insightView() {
    var intro = panel("Transparent intelligence, not an AI claim", "These recommendations are calculated from demo transactions. No external model, customer profiling or production prediction service is used.", "RULE-BASED");
    intro.append(el("p", "Revenue forecast: the trailing 7-day daily average plus a capped slope against the earlier 23 days. Stock cover: units on hand / trailing 30-day unit sales per day. The ±25% forecast band is an illustrative scenario, not a statistical confidence interval.", "muted"));
    appendPanel(intro);
    var cards = el("div", undefined, "insight-cards");
    A.insights(data, role, branch, period()).forEach(function (entry) {
      var card = el("article", undefined, "insight-card");
      card.append(badge(entry.tone === "warning" ? "Review recommended" : "Data signal", entry.tone === "warning" ? "warning" : "positive"), el("h3", entry.title), el("p", entry.text));
      cards.append(card);
    });
    content.append(cards);
    var summaries = el("div", undefined, "three-grid");
    [["Daily business summary", "today"], ["Weekly performance summary", "week"], ["Monthly executive report", "month"]].forEach(function (entry) {
      var p = A.range(data.today, entry[1]);
      var m = metrics(p);
      var node = panel(entry[0], prettyDate(p.start) + " – " + prettyDate(p.end));
      node.append(el("p", number(m.completed) + " completed orders generated " + exactMoney(m.net) + " net sales. " + number(m.pending) + " remain pending. Net profit is " + exactMoney(m.netProfit) + "; outstanding payments are " + exactMoney(m.outstanding) + ".", "muted"));
      summaries.append(node);
    });
    content.append(summaries);
    var forecast = A.forecast(data, role, branch);
    var forecastPanel = panel("Seven-day revenue forecast", "Latest 14 observed days plus seven projected days. Forecast ignores the reporting-period filter but respects role and branch.", "BASELINE MODEL");
    forecastPanel.append(lineChart(forecast.history, "Revenue forecast", "area", forecast.prediction), el("p", "Blue: observed net sales. Dashed gold: forecast. Shaded gold: illustrative ±25% scenario. Actual demand can differ substantially.", "muted"));
    appendPanel(forecastPanel);
    if (role !== "provider") {
      var stock = A.inventory(data, role, branch, data.today);
      var productForecasts = new Map();
      stock.forEach(function (item) {
        if (!productForecasts.has(item.name)) productForecasts.set(item.name, { name: item.name, value: 0 });
        productForecasts.get(item.name).value += item.rate * 7;
      });
      var bestsellers = panel("Bestseller watch · baseline projections", "Estimated unit demand over the next seven days, aggregated across scoped branches. Constant trailing-30-day rate, not an AI guarantee.");
      bestsellers.append(bars(Array.from(productForecasts.values()).sort(function (a, b) { return b.value - a.value; }).slice(0, 5), "Projected bestselling products", "value", function (value) { return number(value, 1) + " units"; }));
      appendPanel(bestsellers);
      var demand = panel("Product demand & stock cover", "Trailing 30-day observations. Predicted units use a constant-rate baseline, not a fitted AI model.");
      demand.append(table(["Branch", "Product", "Sold / 30d", "Predicted / 7d", "Days cover", "Action"], stock.map(function (item) {
        return [item.branch, item.name, item.sold, number(item.rate * 7, 1), item.daysCover === null ? "No demand baseline" : number(item.daysCover, 1), badge(item.status, statusTone(item.status))];
      }), [2, 3, 4], "Demand forecast"));
      content.append(demand);
    }
  }
  function inventoryView() {
    var periodValue = period();
    var stock = A.inventory(data, role, branch, data.today);
    var m = A.inventoryMetrics(data, role, branch, { start: periodValue.start, end: data.today });
    content.append(kpis([
      ["Inventory valuation", money(m.valuation), "Current ledger quantity × unit cost", undefined, true],
      ["Units on hand", number(m.units), "Latest seeded stock positions"],
      ["Low-stock positions", number(m.low), "At or below reorder threshold"],
      ["Out-of-stock positions", number(m.out), "Zero ledger units"],
      ["Overstock positions", number(m.over), "Above maximum threshold"],
      ["Inventory turnover", number(m.turnover, 2) + "×", "Selected-period COGS / mean opening & closing value"],
      ["Count accuracy", percentage(m.accuracy), "Exact ledger/count matches; demo physical counts"],
      ["Healthy stock score", percentage(m.health), "Healthy positions / all branch-SKU positions"]
    ]));
    var row = el("div", undefined, "equal-grid");
    var valuePanel = panel("Capital by category", "Latest inventory valuation at cost.");
    var valuation = new Map();
    stock.forEach(function (item) { valuation.set(item.category, (valuation.get(item.category) || 0) + item.value); });
    valuePanel.append(donut(Array.from(valuation, function (entry) { return { name: entry[0], value: entry[1] }; }), "Inventory category valuation"));
    var aging = panel("Stock aging profile", "FIFO age of oldest remaining units, excluding empty positions. Count increases are treated as new lots.");
    var bands = [{ name: "0–30 days", value: 0 }, { name: "31–90 days", value: 0 }, { name: "91–180 days", value: 0 }, { name: "180+ days", value: 0 }];
    stock.filter(function (item) { return item.quantity > 0; }).forEach(function (item) { bands[item.age <= 30 ? 0 : item.age <= 90 ? 1 : item.age <= 180 ? 2 : 3].value += item.value; });
    aging.append(bars(bands, "Stock aging valuation", "value", money));
    row.append(valuePanel, aging);
    content.append(row);
    var stockPanel = panel("Current inventory levels", "Stock positions are current; the date filter applies to turnover and the transaction ledger.", stock.length + " demo positions");
    var toolbar = el("div", undefined, "toolbar");
    var filterWrap = el("div", undefined, "search-control");
    var label = el("label", "Stock filter");
    label.htmlFor = "stock-filter";
    var filter = el("select");
    filter.id = "stock-filter";
    ["All stock", "Low stock", "Out of stock", "Overstock", "Healthy", "Fast-moving", "Slow-moving"].forEach(function (name) {
      var option = el("option", name);
      filter.append(option);
    });
    filter.value = stockFilter;
    filter.addEventListener("change", function () { stockFilter = filter.value; render(); });
    filterWrap.append(label, filter);
    toolbar.append(filterWrap, button("Export inventory CSV", function () { exportReport("inventory", "csv"); }));
    stockPanel.append(toolbar);
    var filtered = stock.filter(function (item) { return stockFilter === "All stock" || stockFilter === item.status || stockFilter === item.speed; });
    stockPanel.append(table(["Branch / SKU", "Category", "On hand", "Counted", "Reorder", "Value", "Age", "Cover", "Movement", "Status"], filtered.map(function (item) {
      return [item.branch + " / " + item.name, item.category, item.quantity, item.counted, item.reorder, exactMoney(item.value), item.age + "d", item.daysCover === null ? "No baseline" : number(item.daysCover, 1) + "d", badge(item.speed), badge(item.status, statusTone(item.status))];
    }), [2, 3, 4, 5, 6, 7], "Current inventory"));
    appendPanel(stockPanel);
    var branchIds = A.scopedBranches(role, branch).map(function (item) { return item.id; });
    var movements = data.movements.filter(function (item) { return branchIds.includes(item.branchId) && item.date >= periodValue.start && item.date <= periodValue.end; }).slice().reverse();
    var ledger = panel("Product movement ledger", "Stock in/out, branch transfer pairs and explicit count adjustments. Search by item, reference or branch.");
    ledger.append(paginatedTable(["Date", "Branch", "Product", "Type", "Qty change", "Balance", "Reference"], movements.map(function (item) {
      return [item.date, A.branches.find(function (b) { return b.id === item.branchId; }).name, A.itemInfo(item.productId, "product").name, item.type, item.quantity > 0 ? "+" + item.quantity : String(item.quantity), item.balance, item.reference];
    }), "Inventory movement ledger", [4, 5]));
    content.append(ledger);
  }
  function heatmap() {
    var node = panel("Purchase activity heat map", "Completed-order counts by day of week and hour in the selected reporting period.");
    var orders = A.ordersIn(data, role, branch, period()).filter(function (order) { return order.status === "completed"; });
    var matrix = Array.from({ length: 7 }, function () { return Array(11).fill(0); });
    orders.forEach(function (order) {
      var day = (new Date(order.date + "T12:00:00Z").getUTCDay() + 6) % 7;
      if (order.hour >= 8 && order.hour <= 18) matrix[day][order.hour - 8] += 1;
    });
    var max = Math.max(1, Math.max.apply(null, matrix.flat()));
    var grid = el("div", undefined, "heat-grid");
    grid.append(el("span"));
    for (var hour = 8; hour <= 18; hour += 1) grid.append(el("span", String(hour), "heat-label"));
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach(function (name, index) {
      grid.append(el("span", name, "heat-label"));
      matrix[index].forEach(function (count, h) {
        var cell = button(String(count), function () { tooltip.textContent = name + " at " + (h + 8) + ":00 · " + count + " completed orders."; }, "heat-cell");
        cell.style.opacity = String(.18 + count / max * .82);
        cell.setAttribute("aria-label", name + " " + (h + 8) + ":00: " + count + " orders");
        cell.title = cell.getAttribute("aria-label");
        grid.append(cell);
      });
    });
    var tooltip = el("p", "Select a cell to view activity.", "chart-tooltip");
    tooltip.setAttribute("aria-live", "polite");
    var legend = el("div", undefined, "heat-legend");
    legend.append(document.createTextNode("Less"));
    [.2, .5, .8, 1].forEach(function (opacity) { var item = el("i"); item.style.opacity = opacity; legend.append(item); });
    legend.append(document.createTextNode("More"));
    node.append(grid, legend, tooltip);
    return node;
  }
  function salesView() {
    var row = el("div", undefined, "equal-grid");
    row.append(trendPanel("Daily sales · last 14 days", { start: A.shift(data.today, -13), end: data.today }, "line"), trendPanel("Weekly sales · last 12 weeks", { start: A.shift(data.today, -83), end: data.today }, "area"));
    content.append(row);
    var row2 = el("div", undefined, "equal-grid");
    row2.append(trendPanel("Monthly revenue · last 365 days", { start: A.shift(data.today, -364), end: data.today }, "area"), trendPanel("Annual performance · year to date", A.range(data.today, "year"), "line"));
    content.append(row2);
    var mix = el("div", undefined, "equal-grid");
    [["Sales by payment method", "payment", "donut"], ["Sales by customer segment", "segment", "pie"]].forEach(function (entry) {
      var node = panel(entry[0], "Net completed revenue in selected period.");
      node.append(donut(grouped(entry[1]).map(function (group) { return { name: group.name, value: group.revenue }; }), entry[0], entry[2]));
      mix.append(node);
    });
    content.append(mix);
    var ranks = el("div", undefined, "equal-grid");
    [["Sales by category", "category"], ["Service revenue breakdown", "service"]].forEach(function (entry) {
      var node = panel(entry[0], "Selected reporting period.");
      node.append(bars(grouped(entry[1]), entry[0], "revenue", money));
      ranks.append(node);
    });
    content.append(ranks);
    var last = el("div", undefined, "equal-grid");
    var productPanel = panel(role === "provider" ? "Service sales distribution" : "Product sales distribution", "Net revenue by item.");
    productPanel.append(bars(grouped(role === "provider" ? "service" : "product"), "Item sales distribution", "revenue", money));
    last.append(productPanel, heatmap());
    content.append(last, orderTablePanel());
  }
  function serviceView() {
    var m = A.serviceMetrics(data, role, branch, period());
    content.append(kpis([
      ["Total service bookings", number(m.total), "All service statuses in selected period", undefined, true],
      ["Completed services", number(m.completed), "Service revenue recognized"],
      ["Ongoing services", number(m.ongoing), "Work in progress"],
      ["Cancelled services", number(m.cancelled), "Excluded from service revenue"],
      ["Service revenue", money(m.revenue), "Net completed service sales"],
      ["Technician utilization", percentage(m.utilization), "Recorded working minutes / 480 min per tech/day"],
      ["Avg. completion time", number(m.duration, 1) + " min", "Completed jobs; excludes pending & cancelled"],
      ["Customer satisfaction", m.rating === null ? "No ratings" : number(m.rating, 2) + " / 5", m.ratingCount + " completed-job reviews"]
    ]));
    var row = el("div", undefined, "equal-grid");
    var top = panel("Most requested services", "Includes all bookings, not only completed jobs.");
    var counts = A.services.map(function (entry) { return { name: entry.name, value: m.bookings.filter(function (item) { return item.id === entry.id; }).length }; }).sort(function (a, b) { return b.value - a.value; });
    top.append(bars(counts, "Service requests by type", "value", number));
    var trend = panel("Service revenue & completion trends", "Completed service revenue grouped by the selected reporting period.");
    var scoped = A.ordersIn(data, role, branch, period());
    var serviceData = Object.assign({}, data, { orders: scoped.map(function (order) { return Object.assign({}, order, { items: order.items.filter(function (item) { return item.kind === "service"; }) }); }).filter(function (order) { return order.items.length; }) });
    trend.append(lineChart(A.series(serviceData, role, branch, period()), "Service revenue trend", "area"));
    row.append(top, trend);
    content.append(row);
    var tech = panel("Technician performance", "Utilization uses scheduled capacity of eight hours per calendar day per technician. This demo has no time-clock integration.");
    tech.append(table(["Technician", "Completed", "Net service revenue", "Average duration", "Utilization"], m.technicians.map(function (entry) { return [entry.name, entry.completed, exactMoney(entry.revenue), number(entry.duration, 1) + " min", percentage(entry.utilization)]; }), [1, 2, 3, 4], "Technician performance"));
    appendPanel(tech);
    var completions = panel("Service completion trends", "Daily completed, ongoing, pending and cancelled counts.");
    var countByDate = new Map();
    m.bookings.forEach(function (item) {
      if (!countByDate.has(item.date)) countByDate.set(item.date, { completed: 0, ongoing: 0, pending: 0, cancelled: 0 });
      countByDate.get(item.date)[item.serviceStatus] += 1;
    });
    completions.append(bars(Array.from(countByDate).sort(function (a, b) { return b[0].localeCompare(a[0]); }).slice(0, 14).reverse().map(function (entry) {
      return { name: entry[0], value: entry[1].completed };
    }), "Completed services by day · latest 14 recorded days", "value", number));
    completions.append(paginatedTable(["Date", "Completed", "Ongoing", "Pending", "Cancelled"], Array.from(countByDate).sort(function (a, b) { return b[0].localeCompare(a[0]); }).map(function (entry) { return [entry[0], entry[1].completed, entry[1].ongoing, entry[1].pending, entry[1].cancelled]; }), "Service completion history", [1, 2, 3, 4]));
    appendPanel(completions);
    var jobs = panel("Service booking monitor", "Sample operational statuses; unconfirmed member-page requests are not imported.");
    jobs.append(paginatedTable(["Order", "Date", "Branch", "Service", "Technician", "Status", "Net amount"], m.bookings.slice().reverse().map(function (item) {
      return [item.orderId, item.date, A.branches.find(function (b) { return b.id === item.branchId; }).name, A.itemInfo(item.id, "service").name, data.technicians.find(function (tech) { return tech.id === item.technicianId; }).name, item.serviceStatus, exactMoney(A.netLine(item))];
    }), "Service bookings", [6]));
    content.append(jobs);
  }
  function geographicMap(ranking) {
    var node = panel("Geographic performance map", "Coordinate-based schematic of demo UK locations, not a navigational map. Select a marker to filter.", "ILLUSTRATIVE");
    var chart = chartBase("Branch geographic performance", 570, 320);
    chart.canvas.append(svg("path", { d: "M170 30 L350 42 L405 80 L392 130 L465 173 L480 245 L410 291 L295 292 L245 246 L138 226 L114 169 L146 120 Z", class: "land" }));
    [51.5, 52, 52.5].forEach(function (lat) {
      var y = 288 - (lat - 51.3) / 1.35 * 254;
      chart.canvas.append(svg("line", { x1: 50, x2: 520, y1: y, y2: y, class: "gridline" }), svg("text", { x: 5, y: y + 3 }, lat + "°N"));
    });
    var max = Math.max(1, Math.max.apply(null, ranking.map(function (entry) { return entry.revenue; })));
    ranking.forEach(function (entry) {
      var info = A.branches.find(function (b) { return b.id === entry.id; });
      var x = 85 + (info.lon + 2.2) / 2.5 * 380;
      var y = 288 - (info.lat - 51.3) / 1.35 * 254;
      var dot = svg("circle", { cx: x, cy: y, r: 7 + entry.revenue / max * 10, class: "map-point" });
      point(dot, info.name + " · " + money(entry.revenue) + " net revenue · " + info.lat + "°N, " + Math.abs(info.lon) + (info.lon < 0 ? "°W" : "°E"), chart.tooltip, function () { drillBranch(entry); });
      chart.canvas.append(dot);
      chart.canvas.append(svg("text", { x: x + (info.id === "central" ? -20 : 20), y: y + (info.id === "south" ? 24 : -17), "text-anchor": info.id === "central" ? "end" : "start" }, info.name));
    });
    chartTable(chart.figure, ["Branch", "Net revenue", "Latitude", "Longitude"], ranking.map(function (entry) { var info = A.branches.find(function (b) { return b.id === entry.id; }); return [entry.name, exactMoney(entry.revenue), info.lat, info.lon]; }));
    node.append(chart.figure);
    return node;
  }
  function branchView() {
    var ranking = branchRanking();
    var m = metrics();
    var health = A.inventoryMetrics(data, role, branch, period());
    var s = A.serviceMetrics(data, role, branch, period());
    content.append(kpis([
      ["In-scope branches", String(ranking.length), role === "product" ? "Company-wide unless filtered" : "Limited by demo role"],
      ["Network net sales", money(m.net), "Sum of scoped completed sales", undefined, true],
      ["Network net profit", money(m.netProfit), "Direct costs + expenses + commissions"],
      ["Inventory health", percentage(health.health), "Healthy stock positions"],
      ["Completed services", number(s.completed), "Across in-scope technicians"],
      ["Service completion rate", percentage(A.divide(s.completed, s.total) * 100), "Completed / all bookings"],
      ["Profit margin", percentage(m.margin), "Net profit / net revenue"],
      ["Outstanding payments", money(m.outstanding), "Completed sales not marked collected"]
    ]));
    var row = el("div", undefined, "equal-grid");
    var comparison = panel("Branch revenue comparison", "Click a bar to drill into a branch.");
    comparison.append(bars(ranking, "Branch net revenue", "revenue", money, drillBranch));
    row.append(comparison, geographicMap(ranking));
    content.append(row);
    var ranks = panel("Branch performance ranking", "Revenue ranking with inventory, service and profitability context.");
    ranks.append(table(["Rank", "Branch", "Revenue", "Net profit", "Margin", "Stock health", "Services", "Rating"], ranking.map(function (entry, index) {
      return [index + 1, button(entry.name, function () { drillBranch(entry); }, "text-button"), exactMoney(entry.revenue), exactMoney(entry.profit), percentage(entry.margin), percentage(entry.health), entry.services, entry.satisfaction === null ? "No ratings" : number(entry.satisfaction, 2) + "/5"];
    }), [0, 2, 3, 4, 5, 6, 7], "Branch rankings"));
    appendPanel(ranks);
    var last = el("div", undefined, "equal-grid");
    var profit = panel("Branch profitability analysis", "Net contribution after scoped operating costs.");
    profit.append(bars(ranking.slice().sort(function (a, b) { return b.profit - a.profit; }), "Branch profitability", "profit", money));
    var service = panel("Branch service performance", "Completed automotive service jobs.");
    service.append(bars(ranking, "Branch completed services", "services", number));
    last.append(profit, service);
    content.append(last);
  }
  function financialView() {
    var m = metrics();
    content.append(kpis([
      ["Net revenue", money(m.net), "Gross minus discounts and refunds", undefined, true],
      ["Gross profit", money(m.grossProfit), "Net revenue less direct COGS"],
      ["Net profit", money(m.netProfit), role === "provider" ? "Direct contribution; shared expenses excluded" : "Gross profit less expenses & commissions"],
      ["Profit margin", percentage(m.margin), "Net profit / net revenue"],
      ["Operating expenses", money(m.expenses), role === "provider" ? "Not allocated to provider demo" : "Rent, utilities, operations & marketing"],
      ["Collected revenue", money(m.collected), "Completed orders marked paid"],
      ["Outstanding payments", money(m.outstanding), "Net sales less collected sales"],
      ["Service commissions", money(m.commission), "5% of net completed service revenue"]
    ]));
    var row = el("div", undefined, "equal-grid");
    var statement = panel("Profit & loss bridge", "Demo accrual-based view. All amounts exclude VAT.");
    var lines = el("div", undefined, "balance-lines");
    [["Gross revenue", m.gross], ["Discounts", -m.discounts], ["Refunds", -m.refunds], ["Net revenue", m.net], ["Cost of goods & direct service cost", -m.cost], ["Gross profit", m.grossProfit], ["Operational costs", -m.expenses], ["Service commission expense", -m.commission], ["Net profit", m.netProfit]].forEach(function (entry, index) {
      var line = el("div", undefined, "balance-line" + (index === 8 ? " total" : ""));
      line.append(el("span", entry[0]), el("strong", exactMoney(entry[1])));
      lines.append(line);
    });
    statement.append(lines);
    var cash = panel("Cash flow summary", "Illustrative: direct costs and expenses assumed paid; not a bank reconciliation.");
    var cashLines = el("div", undefined, "balance-lines");
    [["Cash collected", m.collected], ["Direct costs paid", -m.cost], ["Operating costs paid", -m.expenses], ["Commissions assumed paid", -m.commission], ["Illustrative net cash movement", m.cashFlow]].forEach(function (entry, index) {
      var line = el("div", undefined, "balance-line" + (index === 4 ? " total" : ""));
      line.append(el("span", entry[0]), el("strong", exactMoney(entry[1])));
      cashLines.append(line);
    });
    cash.append(cashLines, el("p", "No opening bank balance, credit terms, tax or actual bank transactions are connected.", "muted"));
    row.append(statement, cash);
    content.append(row);
    var last = el("div", undefined, "equal-grid");
    var expense = panel("Operational cost breakdown", role === "provider" ? "Shared expenses are excluded from service-provider scope." : "Expense entries in selected period.");
    var scoped = A.scopedBranches(role, branch).map(function (b) { return b.id; });
    var expenseGroups = new Map();
    if (role !== "provider") data.expenses.filter(function (entry) { return scoped.includes(entry.branchId) && entry.date >= period().start && entry.date <= period().end; }).forEach(function (entry) { expenseGroups.set(entry.category, (expenseGroups.get(entry.category) || 0) + entry.amount); });
    expense.append(bars(Array.from(expenseGroups, function (entry) { return { name: entry[0], value: entry[1] }; }), "Expenses by category", "value", money));
    var commission = panel("Commission tracking", "5% payable on completed service net revenue; illustrative policy, rounded per service line.");
    commission.append(table(["Service", "Net revenue", "Estimated commission"], grouped("service").map(function (entry) { return [entry.name, exactMoney(entry.revenue), exactMoney(entry.commission)]; }), [1, 2], "Service commissions"));
    last.append(expense, commission);
    content.append(last);
    var outstanding = panel("Outstanding payment monitor", "Completed orders that are not marked paid. Pending orders are not receivables.");
    var due = A.ordersIn(data, role, branch, period()).filter(function (order) { return order.status === "completed" && !order.paid; });
    outstanding.append(paginatedTable(["Order", "Date", "Branch", "Customer", "Payment method", "Outstanding"], due.map(function (order) { return [order.id, order.date, A.branches.find(function (b) { return b.id === order.branchId; }).name, order.customerId, order.payment, exactMoney(A.sum(order.items, A.netLine))]; }), "Outstanding payments", [5]));
    content.append(outstanding);
  }
  function paginatedTable(headers, rows, title, numericColumns) {
    var wrapper = el("div");
    var toolbar = el("div", undefined, "toolbar");
    var controls = el("div", undefined, "search-control");
    var id = "search-" + title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    var label = el("label", "Search");
    label.htmlFor = id;
    var input = el("input");
    input.id = id;
    input.type = "search";
    input.placeholder = "Search records...";
    controls.append(label, input);
    toolbar.append(controls, el("span", rows.length + " records", "muted"));
    var tableContainer = el("div");
    var pagination = el("div", undefined, "pagination");
    var status = el("span");
    var actions = el("div");
    var pageIndex = 0;
    var filtered = rows;
    var previous = button("Previous", function () { pageIndex -= 1; draw(); });
    var next = button("Next", function () { pageIndex += 1; draw(); });
    function draw() {
      var totalPages = Math.max(1, Math.ceil(filtered.length / 10));
      pageIndex = Math.max(0, Math.min(pageIndex, totalPages - 1));
      tableContainer.replaceChildren(table(headers, filtered.slice(pageIndex * 10, pageIndex * 10 + 10), numericColumns, title));
      status.textContent = filtered.length + " matches · Page " + (pageIndex + 1) + " of " + totalPages;
      previous.disabled = pageIndex === 0;
      next.disabled = pageIndex === totalPages - 1;
    }
    input.addEventListener("input", function () {
      filtered = rows.filter(function (row) { return row.join(" ").toLowerCase().includes(input.value.trim().toLowerCase()); });
      pageIndex = 0;
      draw();
    });
    actions.append(previous, next);
    pagination.append(status, actions);
    wrapper.append(toolbar, tableContainer, pagination);
    draw();
    return wrapper;
  }
  function orderTablePanel() {
    var node = panel("Order activity", "All scoped statuses. Pending and cancelled totals are not counted as revenue.");
    var orders = A.ordersIn(data, role, branch, period()).slice().reverse();
    node.append(paginatedTable(["Order", "Date", "Branch", "Customer", "Status", "Payment", "Order net value"], orders.map(function (order) { return [order.id, order.date, A.branches.find(function (b) { return b.id === order.branchId; }).name, order.customerId, order.status, order.payment, exactMoney(A.sum(order.items, A.netLine))]; }), "Order activity", [6]));
    return node;
  }
  function reportData(type) {
    var p = ["daily", "weekly", "monthly"].includes(type) ? A.range(data.today, { daily: "today", weekly: "week", monthly: "month" }[type]) : period();
    var metadata = [
      ["DriveCore " + type + " report", "SEEDED DEMO · NOT A FINANCIAL STATEMENT"],
      ["Role", A.roles[role].name],
      ["Branches", A.scopedBranches(role, branch).map(function (b) { return b.name; }).join("; ")],
      ["Reporting period", p.start + " to " + p.end],
      ["Generated at", new Date().toISOString()],
      ["Currency / revenue basis", "GBP excluding VAT; completed orders only; net of discounts and refunds"],
      []
    ];
    var rows;
    if (type === "inventory") {
      if (role === "provider") throw new Error("Inventory reports are not available to the service-provider demo role.");
      metadata[3] = ["Inventory snapshot", data.today + " (current; demand based on trailing 30 days)"];
      rows = [["Branch", "Product", "Category", "Ledger units", "Counted units", "Reorder point", "Value GBP", "Age days", "30-day unit demand", "Days cover", "Status"]];
      A.inventory(data, role, branch, data.today).forEach(function (item) { rows.push([item.branch, item.name, item.category, item.quantity, item.counted, item.reorder, item.value / 100, item.age, item.sold, item.daysCover === null ? "No baseline" : Number(item.daysCover.toFixed(2)), item.status]); });
    } else if (type === "sales") {
      rows = [["Order", "Date", "Branch", "Customer", "Status", "Payment", "Order net GBP", "Recognized revenue GBP", "Collected"]];
      A.ordersIn(data, role, branch, p).forEach(function (order) {
        var net = A.sum(order.items, A.netLine);
        rows.push([order.id, order.date, A.branches.find(function (b) { return b.id === order.branchId; }).name, order.customerId, order.status, order.payment, net / 100, order.status === "completed" ? net / 100 : 0, order.paid ? "Yes" : "No"]);
      });
    } else if (type === "services") {
      rows = [["Order", "Date", "Branch", "Service", "Technician", "Status", "Duration minutes", "Rating", "Recognized revenue GBP"]];
      A.serviceMetrics(data, role, branch, p).bookings.forEach(function (item) { rows.push([item.orderId, item.date, A.branches.find(function (b) { return b.id === item.branchId; }).name, A.itemInfo(item.id, "service").name, data.technicians.find(function (tech) { return tech.id === item.technicianId; }).name, item.serviceStatus, item.minutes, item.rating === null ? "" : item.rating, item.serviceStatus === "completed" ? A.netLine(item) / 100 : 0]); });
    } else if (type === "financial") {
      var financial = metrics(p);
      rows = [["Financial measure", "Amount GBP"]];
      [["Gross revenue", "gross"], ["Discounts", "discounts"], ["Refunds", "refunds"], ["Net revenue", "net"], ["Direct COGS", "cost"], ["Gross profit", "grossProfit"], ["Operating expenses", "expenses"], ["Service commission", "commission"], ["Net profit", "netProfit"], ["Collected", "collected"], ["Outstanding payments", "outstanding"], ["Illustrative cash movement", "cashFlow"]].forEach(function (entry) { rows.push([entry[0], financial[entry[1]] / 100]); });
      rows.push(["Net margin %", financial.margin], ["Note", "Provider scope excludes shared operating costs; cash flow assumes direct costs/expenses paid."]);
    } else {
      var m = metrics(p);
      var s = A.serviceMetrics(data, role, branch, p);
      rows = [["Business metric", "Value"]];
      [["Gross revenue GBP", m.gross / 100], ["Net revenue GBP", m.net / 100], ["Net profit GBP", m.netProfit / 100], ["Total orders", m.orders], ["Completed orders", m.completed], ["Pending orders", m.pending], ["Cancelled orders", m.cancelled], ["Average completed order value GBP", m.aov / 100], ["Customers", m.customers], ["New customers", m.newCustomers], ["Returning customers", m.returning], ["Previous-period retention %", m.retention], ["Service bookings", s.total], ["Completed services", s.completed], ["Ongoing services", s.ongoing], ["Cancelled services", s.cancelled], ["Outstanding payments GBP", m.outstanding / 100]].forEach(function (entry) { rows.push(entry); });
    }
    return { title: type.charAt(0).toUpperCase() + type.slice(1) + " business report", metadata: metadata, rows: rows };
  }
  function exportReport(type, format) {
    var report = reportData(type);
    var allRows = report.metadata.concat(report.rows);
    if (format === "pdf") {
      var print = document.getElementById("print-report");
      print.replaceChildren(el("h1", "DriveCore · " + report.title));
      report.metadata.filter(function (row) { return row.length; }).forEach(function (row) { print.append(el("p", row[0] + ": " + row[1])); });
      print.append(table(report.rows[0], report.rows.slice(1), [], report.title));
      print.hidden = false;
      window.print();
      notify("Print report prepared. Select Save as PDF in your browser's print dialog.");
      return;
    }
    var bytes = format === "xlsx" ? window.DriveCoreExports.xlsx(allRows) : window.DriveCoreExports.csv(allRows);
    var blob = new Blob([bytes], { type: format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var anchor = el("a");
    anchor.href = url;
    anchor.download = "DriveCore-" + type + "-" + data.today + "." + format;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
    notify(report.title + " exported as " + format.toUpperCase() + ". Filters and role scope are included in the file.");
  }
  function reportView() {
    var intro = panel("Export centre", "CSV and Excel files download directly. PDF uses the browser print dialog: choose Save as PDF.", "SCOPED EXPORTS");
    intro.append(el("p", "Exports include report dates, demo role, permitted branches and currency/revenue definitions. Daily, weekly and monthly reports use their named periods; sales, service and financial reports use the selected filter. Inventory exports are current snapshots. All reports contain sample data only.", "muted"));
    appendPanel(intro);
    var grid = el("div", undefined, "three-grid");
    [
      ["daily", "Daily business report", "Today's sales, order statuses, customers and service performance."],
      ["weekly", "Weekly business report", "Week-to-date business KPIs, starting Monday."],
      ["monthly", "Monthly business report", "Month-to-date executive and operational metrics."],
      ["sales", "Sales report", "Order-level records, statuses and recognized revenue."],
      ["inventory", "Inventory report", "Current stock, counts, demand, valuation and risk."],
      ["services", "Service report", "Bookings, technicians, completion times and ratings."],
      ["financial", "Financial report", "Revenue, direct costs, expenses, profit and cash movement."]
    ].forEach(function (entry) {
      if (entry[0] === "inventory" && role === "provider") return;
      var card = panel(entry[1], null, "DEMO");
      card.classList.add("report-card");
      card.append(el("p", entry[2], "muted"));
      var actions = el("div", undefined, "report-actions");
      [["CSV", "csv"], ["Excel .xlsx", "xlsx"], ["PDF / print", "pdf"]].forEach(function (format) {
        var control = button(format[0], function () { exportReport(entry[0], format[1]); });
        control.setAttribute("aria-label", "Export " + entry[1] + " as " + format[0]);
        actions.append(control);
      });
      card.append(actions);
      grid.append(card);
    });
    content.append(grid);
    var definitions = panel("Metric definitions & limitations", "Use consistent definitions before making business decisions.");
    definitions.append(table(["Metric", "Definition"], [
      ["Revenue recognition", "Completed orders only. Gross = line price × units; net = gross − discounts − refunds. VAT excluded."],
      ["Customers", "Unique completed purchasers in the selected period; new/returning based on two years of seeded history."],
      ["Retention", "Previous equal-length period purchasers who purchased again in the selected period / previous purchasers."],
      ["Growth", "Selected net sales vs previous equal-length period. A zero baseline is shown as unavailable, not 100%."],
      ["Gross and net profit", "Gross = net revenue − direct cost. Net = gross profit − scoped expenses − 5% service commission."],
      ["Inventory turnover", "Selected-period product COGS / mean opening and closing inventory valuation; not annualized."],
      ["Inventory accuracy", "Percent of branch/SKU positions whose demo physical count equals the ledger."],
      ["Stock cover / forecasts", "Trailing 30-day unit demand; no sales means no depletion baseline, not zero demand forever."],
      ["Technician utilization", "Recorded completed/ongoing job minutes / 480 scheduled minutes per technician per calendar day."],
      ["Role controls", "Client-side visibility and scope only. Not authentication or server-enforced authorization."],
      ["Demo updates", "In-memory simulation. Reloading restores seeded data; member-cart data is never modified."],
      ["Cash movement", "Collected sales less direct costs, expenses and commission, assumed paid. No bank reconciliation."]
    ], [], "Dashboard definitions"));
    content.append(definitions);
  }
  function renderBranchOptions() {
    var filter = document.getElementById("branch-filter");
    filter.replaceChildren();
    var all = el("option", role === "product" ? "All branches" : role === "hub" ? "London hub branches" : "Assigned North London");
    all.value = "all";
    filter.append(all);
    A.scopedBranches(role, "all").forEach(function (entry) { var option = el("option", entry.name); option.value = entry.id; filter.append(option); });
    filter.value = branch;
  }
  function render() {
    if (!A.roles[role].sections.includes(section)) {
      section = "executive";
      window.history.replaceState(null, "", "#executive");
    }
    document.querySelectorAll("[data-section]").forEach(function (anchor) {
      anchor.hidden = !A.roles[role].sections.includes(anchor.dataset.section);
      if (anchor.dataset.section === section) anchor.setAttribute("aria-current", "page");
      else anchor.removeAttribute("aria-current");
    });
    document.getElementById("section-title").textContent = names[section][0];
    document.getElementById("section-description").textContent = names[section][1];
    document.getElementById("breadcrumb-section").textContent = names[section][0];
    document.title = names[section][0] + " | DriveCore Owner";
    var p = period();
    document.getElementById("scope-label").textContent = A.roles[role].name + " · " + A.scopedBranches(role, branch).length + " branch(es) · " + prettyDate(p.start) + " – " + prettyDate(p.end);
    document.getElementById("refresh-time").textContent = "Snapshot " + data.today + " · Updated " + updatedAt.toLocaleTimeString("en-GB") + " · Simulation #" + data.revision;
    content.replaceChildren();
    ({ executive: executive, intelligence: intelligence, insights: insightView, inventory: inventoryView, sales: salesView, services: serviceView, branches: branchView, financial: financialView, reports: reportView })[section]();
  }
  function changeSection() {
    var requested = window.location.hash.slice(1);
    section = Object.prototype.hasOwnProperty.call(names, requested) ? requested : "executive";
    if (!A.roles[role].sections.includes(section)) notify("This section is not available to the selected demo role.", true);
    attempt(render);
    document.getElementById("dashboard-navigation").classList.remove("is-open");
    document.getElementById("nav-toggle").setAttribute("aria-expanded", "false");
  }
  function refresh() {
    if (A.iso(new Date()) !== data.today) {
      data = A.seed();
      notify("The date changed. Refreshed the seeded dataset for today; prior in-memory simulations were reset.");
    } else notify(A.simulate(data));
    updatedAt = new Date();
    render();
  }
  function autoTick() {
    if (!document.hidden && !content.contains(document.activeElement)) attempt(refresh);
  }
  function applyTheme(theme, persist) {
    document.documentElement.dataset.theme = theme;
    var control = document.getElementById("theme-toggle");
    control.textContent = theme === "dark" ? "Light theme" : "Dark theme";
    control.setAttribute("aria-pressed", String(theme === "dark"));
    control.setAttribute("aria-label", "Switch to " + (theme === "dark" ? "light" : "dark") + " theme");
    if (persist) {
      try { localStorage.setItem("drivecore-owner-theme", theme); }
      catch (error) { notify("Theme changed for this session, but your preference could not be saved: " + error.message, true); }
    }
  }
  document.getElementById("role-filter").addEventListener("change", function (event) {
    role = event.target.value;
    branch = "all";
    renderBranchOptions();
    render();
    notify("Demo role changed to " + A.roles[role].name + ". This is UI scoping, not secure authorization.");
  });
  document.getElementById("branch-filter").addEventListener("change", function (event) { branch = event.target.value; attempt(render); });
  document.getElementById("period-filter").addEventListener("change", function (event) { preset = event.target.value; attempt(render); });
  document.getElementById("refresh-button").addEventListener("click", function () { attempt(refresh); });
  document.getElementById("auto-refresh").addEventListener("change", function (event) {
    if (timer) window.clearInterval(timer);
    timer = event.target.checked ? window.setInterval(autoTick, 30000) : null;
    notify(event.target.checked ? "30-second simulation enabled. Updates pause while the tab is hidden or a dashboard control is focused." : "Automatic simulation paused.");
  });
  document.getElementById("quick-export").addEventListener("click", function () {
    attempt(function () { exportReport(section === "inventory" ? "inventory" : section === "services" ? "services" : section === "financial" ? "financial" : section === "sales" ? "sales" : "business", "csv"); });
  });
  document.getElementById("reset-demo").addEventListener("click", function () {
    attempt(function () { data = A.seed(); updatedAt = new Date(); render(); notify("Simulated changes reset. Member garage and cart data have not been changed."); });
  });
  document.getElementById("theme-toggle").addEventListener("click", function () { applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true); });
  document.getElementById("nav-toggle").addEventListener("click", function () {
    var control = document.getElementById("nav-toggle");
    var open = control.getAttribute("aria-expanded") !== "true";
    control.setAttribute("aria-expanded", String(open));
    document.getElementById("dashboard-navigation").classList.toggle("is-open", open);
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      document.getElementById("dashboard-navigation").classList.remove("is-open");
      document.getElementById("nav-toggle").setAttribute("aria-expanded", "false");
    }
  });
  window.addEventListener("hashchange", changeSection);
  window.addEventListener("afterprint", function () { document.getElementById("print-report").hidden = true; });
  window.addEventListener("pagehide", function () { if (timer) window.clearInterval(timer); });
  window.addEventListener("pageshow", function (event) { if (event.persisted && document.getElementById("auto-refresh").checked) timer = window.setInterval(autoTick, 30000); });
  renderBranchOptions();
  changeSection();
  try {
    var savedTheme = localStorage.getItem("drivecore-owner-theme");
    applyTheme(savedTheme === "dark" || (!savedTheme && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light", false);
  } catch (error) {
    applyTheme("light", false);
    notify("Theme preferences are unavailable: " + error.message, true);
  }
});
