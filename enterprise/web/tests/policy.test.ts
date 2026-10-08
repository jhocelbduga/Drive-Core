import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedRoute, sameOrigin, validKey } from "../lib/policy";
import { totals, can } from "../lib/models";

test("BFF allows only fixed operational routes and methods", () => {
  const id = "9356c23b-46e0-45fa-8441-7fca493218a7";
  assert.ok(allowedRoute(`orders/${id}/settle`, "POST"));
  assert.ok(allowedRoute(`stock/${id}`, "GET"));
  for (const path of ["https://evil.invalid", "../national", "graphql", "orders/x/settle", "health/ready"])
    assert.equal(allowedRoute(path, "GET"), false);
  assert.equal(allowedRoute("national", "POST"), false);
});
test("mutation origin is exact and cannot trust hostile host headers", () => {
  sameOrigin(new Request("https://internal/", { headers: { origin: "https://drivecore.test" } }), "https://drivecore.test");
  for (const origin of ["https://drivecore.test.evil", "http://drivecore.test", "null", ""])
    assert.throws(() => sameOrigin(new Request("https://internal/", { headers: { origin } }), "https://drivecore.test"));
});
test("commands require nonempty UUID keys", () => {
  assert.equal(validKey("9356c23b-46e0-45fa-8441-7fca493218a7"), "9356c23b-46e0-45fa-8441-7fca493218a7");
  for (const key of [null, "hello", "00000000-0000-0000-0000-000000000000"]) assert.throws(() => validKey(key));
});
test("dashboard totals never combine currencies", () => {
  const hubs = [{ revenue: [{ currency: "PHP", today: 12500, week: 25000, month: 50000, year: 60000 }, { currency: "GBP", today: 900, week: 1500, month: 3000, year: 4000 }] }];
  assert.equal(totals(hubs, "PHP").today, 12500);
  assert.equal(totals(hubs, "GBP").today, 900);
  assert.equal(totals([], "PHP").year, 0);
});
test("navigation permissions do not inherit management from cashier", () => {
  assert.equal(can({ tenant: "t", subject: "s", roles: ["Cashier"], hubs: [] }, "Hub Manager"), false);
  assert.ok(can({ tenant: "t", subject: "s", roles: ["Corporate Administrator"], hubs: [] }, "Hub Manager"));
});
