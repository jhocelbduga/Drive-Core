"use strict";

const http = require("node:http");
const { randomBytes, createHash, scrypt, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");
const { readFileSync, existsSync } = require("node:fs");
const path = require("node:path");
const { openDatabase, bootstrap, passwordHash } = require("./database");
const { Problem, fail, identity, transact, snapshot, requirePermission, date } = require("./operations");
const exportsHelper = require("../owner-export");
const deriveKey = promisify(scrypt);
const root = path.resolve(__dirname, "..");
const hash = value => createHash("sha256").update(value).digest("hex");
const reportRules = {
  sales: ["sales.view", "orders"], inventory: ["inventory.view", "movements"],
  services: ["tickets.view", "tickets"], attendance: ["attendance.manage", "attendance"],
  bookings: ["bookings.view", "bookings"], customers: ["customers.view", "customers"],
  settlement: ["settlement.view", "payments"]
};
function createServer(db, { origin, secure = false } = {}) {
  if (!origin || new URL(origin).origin !== origin) throw new Error("An exact application origin without a path or trailing slash is required.");
  const attempts = new Map();
  const dummyHash = passwordHash(randomBytes(32).toString("hex"));
  function send(res, status, value, headers = {}) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
    res.end(JSON.stringify(value));
  }
  async function body(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) fail("Request body exceeds 64 KB.", 413);
      chunks.push(chunk);
    }
    if (!(req.headers["content-type"] || "").startsWith("application/json")) fail("JSON content type is required.", 415);
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!input || Array.isArray(input) || typeof input !== "object") fail("JSON object required.");
      return input;
    } catch (e) { if (e instanceof Problem) throw e; fail("Malformed JSON request."); }
  }
  function session(req) {
    const cookie = /(?:^|;\s*)drivecore_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || "");
    if (!cookie) fail("Sign in to continue.", 401);
    const s = db.prepare("SELECT * FROM sessions WHERE token=? AND expires>?").get(hash(cookie[1]), Date.now());
    if (!s) fail("Session expired. Sign in again.", 401);
    return { ...s, user: identity(db, s.user_id) };
  }
  function cookie(token, age) { return `drivecore_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure ? "; Secure" : ""}`; }
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    try {
      const url = new URL(req.url, origin);
      if (!["GET", "POST"].includes(req.method)) fail("Method not allowed.", 405);
      if (req.method === "POST" && req.headers.origin !== origin) fail("Request origin is not authorized.", 403);
      if (url.pathname === "/api/health" && req.method === "GET") return send(res, 200, { status: "ok", storage: "sqlite" });
      if (url.pathname === "/api/login" && req.method === "POST") {
        const ip = req.socket.remoteAddress;
        const time = Date.now(), previous = attempts.get(ip);
        const counter = previous && previous.until > time ? previous : { count: 0, until: time + 60000 };
        counter.count++; attempts.set(ip, counter);
        if (attempts.size > 5000) for (const [key, value] of attempts) if (value.until < time) attempts.delete(key);
        if (counter.count > 10) fail("Too many sign-in attempts. Try again after one minute.", 429);
        const input = await body(req);
        if (typeof input.email !== "string" || input.email.length > 150 || typeof input.password !== "string" || input.password.length > 200) fail("Invalid credentials.", 401);
        const u = db.prepare("SELECT * FROM users WHERE email=?").get(input.email.trim().toLowerCase());
        const [salt, digest] = (u ? u.password : dummyHash).split(":");
        const valid = timingSafeEqual(await deriveKey(input.password, salt, 64), Buffer.from(digest, "hex"));
        // Re-read after asynchronous hashing so deactivation or password reset cannot race login.
        const current = u && db.prepare("SELECT * FROM users WHERE id=?").get(u.id);
        if (!current || !current.active || current.locked_until > time || current.password !== u.password || !valid) {
          if (current && current.active && current.locked_until <= time) db.prepare("UPDATE users SET failures=failures+1,locked_until=CASE WHEN failures+1>=5 THEN ? ELSE 0 END WHERE id=?").run(time + 15 * 60000, current.id);
          fail("Invalid credentials or temporarily locked account.", 401);
        }
        db.prepare("UPDATE users SET failures=0,locked_until=0 WHERE id=?").run(current.id);
        db.prepare("DELETE FROM sessions WHERE expires<?").run(time);
        const token = randomBytes(32).toString("hex"), csrf = randomBytes(24).toString("hex");
        db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(hash(token), current.id, csrf, time + 8 * 3600000);
        return send(res, 200, { user: identity(db, current.id), csrf }, { "Set-Cookie": cookie(token, 8 * 3600) });
      }
      if (url.pathname.startsWith("/api/")) {
        const s = session(req);
        if (req.method === "POST" && req.headers["x-csrf-token"] !== s.csrf) fail("Invalid CSRF token. Sign in again.", 403);
        if (url.pathname === "/api/me" && req.method === "GET") return send(res, 200, { user: s.user, csrf: s.csrf });
        if (url.pathname === "/api/logout" && req.method === "POST") {
          db.prepare("DELETE FROM sessions WHERE token=?").run(s.token);
          return send(res, 200, { signedOut: true }, { "Set-Cookie": cookie("", 0) });
        }
        if (url.pathname === "/api/state" && req.method === "GET") return send(res, 200, snapshot(db, s.user, url.searchParams.get("branch") || undefined));
        if (url.pathname === "/api/action" && req.method === "POST") {
          const input = await body(req);
          if (!input.input || typeof input.input !== "object" || Array.isArray(input.input)) fail("Operation input is required.");
          const result = transact(db, s.user.id, input.action, input.input, req.headers["idempotency-key"]);
          return send(res, 200, result);
        }
        if (url.pathname === "/api/report" && req.method === "GET") {
          requirePermission(s.user, "reports.view");
          const type = url.searchParams.get("type"), rules = reportRules[type];
          if (!rules) fail("Unknown report.");
          requirePermission(s.user, rules[0]);
          const state = snapshot(db, s.user, url.searchParams.get("branch") || undefined);
          const start = url.searchParams.get("start") || "1970-01-01", end = url.searchParams.get("end") || "9999-12-31";
          date(start); date(end);
          if (end < start) fail("Invalid report range.");
          const format = url.searchParams.get("format") || "csv";
          if (!["csv", "xlsx"].includes(format)) fail("Reports support CSV or Excel.");
          const data = (type === "inventory" ? state.movements : state.records[rules[1]] || [])
            .filter(r => (r.created || r.in).slice(0, 10) >= start && (r.created || r.in).slice(0, 10) <= end);
          const keys = [...new Set(data.flatMap(row => Object.keys(row)))];
          const rows = [
            ["DriveCore", `${type} report`], ["Staff", s.user.name], ["Role", s.user.role],
            ["Branches", state.branches.filter(b => state.scope.includes(b.id)).map(b => b.name).join(", ")], ["Dates (UTC record creation)", `${start} to ${end}`],
            ["Generated", state.generated], ["Money", "GBP integer pennies, excluding VAT; payments are externally settled records"], [],
            keys, ...data.map(row => keys.map(key => typeof row[key] === "object" ? JSON.stringify(row[key]) : row[key] ?? ""))
          ];
          const excel = format === "xlsx";
          res.writeHead(200, {
            "Content-Type": excel ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="DriveCore-${type}.${excel ? "xlsx" : "csv"}"`
          });
          return res.end(excel ? Buffer.from(exportsHelper.xlsx(rows)) : exportsHelper.csv(rows));
        }
        fail("API route not found.", 404);
      }
      if (req.method !== "GET") fail("Not found.", 404);
      const name = url.pathname === "/" ? "hubAdministration.html" : decodeURIComponent(url.pathname.slice(1));
      // Only top-level public assets are served; database, source, tests and environment files never are.
      const publicAsset = /^[\w-]+\.(html|css|js)$/.test(name) && !name.endsWith(".test.js");
      const publicImage = /^images\/[\w-]+\.(png|jpg|jpeg|svg|webp)$/i.test(name);
      if ((!publicAsset && !publicImage) || !existsSync(path.join(root, name))) fail("Not found.", 404);
      const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp" };
      res.writeHead(200, { "Content-Type": `${mime[path.extname(name)]}; charset=utf-8` });
      res.end(readFileSync(path.join(root, name)));
    } catch (error) {
      const constraint = error.code === "ERR_SQLITE_ERROR" && (error.errcode & 255) === 19;
      const status = error instanceof Problem ? error.status : constraint ? 409 : 500;
      if (status === 500) console.error("Hub request failed:", error);
      if (!res.headersSent) send(res, status, { error: status === 500 ? "Internal operation error. Check server logs." : status === 409 && !(error instanceof Problem) ? "Database conflict: a unique value or data constraint was violated." : error.message });
      else res.destroy();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
if (require.main === module) {
  const port = Number(process.env.PORT || 8787), host = process.env.HUB_HOST || "127.0.0.1";
  const publicOrigin = process.env.HUB_ORIGIN || process.env.RENDER_EXTERNAL_URL;
  const origin = publicOrigin || `http://127.0.0.1:${port}`;
  if (host !== "127.0.0.1" && (!publicOrigin || !origin.startsWith("https://"))) throw new Error("Remote hosting requires HUB_ORIGIN (or RENDER_EXTERNAL_URL) with HTTPS and a TLS reverse proxy.");
  const db = openDatabase(process.env.HUB_DB || path.join(__dirname, "data", "hub.sqlite"));
  if (bootstrap(db, process.env.HUB_ADMIN_EMAIL, process.env.HUB_ADMIN_PASSWORD)) console.log("Initial administrator created. Remove bootstrap credentials from your environment.");
  const server = createServer(db, { origin, secure: origin.startsWith("https://") });
  server.listen(port, host, () => console.log(`DriveCore Hub Administration: ${origin}`));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
}
module.exports = { createServer };
