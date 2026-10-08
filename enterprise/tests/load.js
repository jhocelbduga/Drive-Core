import http from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import exec from "k6/execution";
import encoding from "k6/encoding";

if (!__ENV.BASE_URL || !__ENV.TOKEN_FILE) throw new Error("BASE_URL and a private TOKEN_FILE are required.");
const tokens = new SharedArray("authorized test users", () => {
  let values;
  try { values = JSON.parse(open(__ENV.TOKEN_FILE)); }
  catch { throw new Error("Cannot read the private JSON token array."); }
  if (!Array.isArray(values) || values.length < 10000)
    throw new Error("Provide at least 10,000 distinct authorized test users.");
  const identities = new Set();
  for (const token of values) {
    if (typeof token !== "string" || token.split(".").length !== 3) throw new Error("Malformed test JWT.");
    let claims;
    try { claims = JSON.parse(encoding.b64decode(token.split(".")[1], "rawurl", "s")); }
    catch { throw new Error("Malformed test JWT claims."); }
    if (!claims.sub || !claims.tenant_id || !Number.isFinite(claims.exp) || claims.exp < Date.now() / 1000 + 31 * 60)
      throw new Error("Each token needs tenant/subject claims and at least 31 minutes of remaining validity.");
    const identity = `${claims.tenant_id}:${claims.sub}`;
    if (identities.has(identity)) throw new Error("Tokens must belong to distinct test identities, not rotations of one user.");
    identities.add(identity);
  }
  return values;
});
export const options = {
  scenarios: {
    national_read: {
      executor: "ramping-vus", startVUs: 100,
      stages: [{ duration: "2m", target: 1000 }, { duration: "5m", target: 10000 }, { duration: "20m", target: 10000 }, { duration: "3m", target: 0 }],
      gracefulRampDown: "30s"
    }
  },
  thresholds: {
    http_req_failed: ["rate<0.001"],
    http_req_duration: ["p(95)<500", "p(99)<1000"],
    checks: ["rate>0.999"]
  }
};
export default function () {
  const path = __ITER % 10 === 0 ? "/api/national" : "/api/products";
  const response = http.get(`${__ENV.BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${tokens[exec.vu.idInTest - 1]}` },
    tags: { operation: path }, timeout: "10s"
  });
  check(response, { "authorized read returns 200": response => response.status === 200 });
  sleep(4 + Math.random() * 2);
}
