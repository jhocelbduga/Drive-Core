"use strict";

const { DatabaseSync } = require("node:sqlite");
const { randomUUID, scryptSync, randomBytes, timingSafeEqual } = require("node:crypto");
const { mkdirSync } = require("node:fs");
const { dirname } = require("node:path");

const permissions = [
  "sales.view", "sales.create", "payments.manage", "settlement.view",
  "inventory.view", "inventory.locate", "inventory.move", "inventory.manage",
  "catalogue.manage", "transfers.manage", "approvals.manage",
  "attendance.self", "attendance.manage", "employees.manage",
  "bookings.view", "bookings.manage", "tickets.view", "tickets.manage",
  "queue.view", "queue.manage", "queue.priority", "customers.view", "customers.manage",
  "operations.view", "announcements.manage", "reports.view", "audit.view", "roles.manage"
];
const basics = ["inventory.view", "inventory.locate", "attendance.self"];
const front = ["customers.view", "bookings.view", "queue.view", "tickets.view"];
const service = [...front, "bookings.manage", "queue.manage", "tickets.manage", "customers.manage"];
const stock = ["inventory.move", "transfers.manage"];
const oversight = ["approvals.manage", "attendance.manage", "operations.view", "reports.view", "queue.priority", "announcements.manage", "audit.view"];
const roles = {
  "Sales Clerk": { level: 1, grants: [...basics, "sales.view", "sales.create", "customers.view"] },
  "Cashier": { level: 1, grants: [...basics, "sales.view", "payments.manage", "settlement.view", "customers.view"] },
  "Service Receptionist": { level: 1, grants: [...basics, ...front, "bookings.manage", "queue.manage", "customers.manage"] },
  "Customer Service Representative": { level: 1, grants: [...basics, ...front, "customers.manage", "sales.view"] },
  "Stock Custodian": { level: 2, grants: [...basics, ...stock] },
  "Inventory Controller": { level: 2, grants: [...basics, ...stock, "inventory.manage", "catalogue.manage", "reports.view"] },
  "Warehouse Coordinator": { level: 2, grants: [...basics, ...stock, "operations.view"] },
  "Service Coordinator": { level: 2, grants: [...basics, ...service, "operations.view"] },
  "Hub Supervisor": { level: 3, grants: [...basics, ...stock, ...service, ...oversight, "sales.view"] },
  "Operations Supervisor": { level: 3, grants: [...basics, ...stock, ...service, ...oversight, "sales.view"] },
  "Service Supervisor": { level: 3, grants: [...basics, ...service, ...oversight] },
  "Hub Manager": { level: 4, grants: permissions.filter(p => p !== "roles.manage") },
  "Branch Manager": { level: 4, grants: permissions.filter(p => p !== "roles.manage") },
  "Regional Manager": { level: 5, grants: permissions.filter(p => p !== "roles.manage") },
  "Corporate Operations Manager": { level: 5, grants: permissions }
};
function passwordHash(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
function passwordMatches(password, hash) {
  const [salt, digest] = hash.split(":");
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(digest, "hex"));
}
function openDatabase(filename) {
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS branches(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, lat REAL, lon REAL);
    CREATE TABLE IF NOT EXISTS roles(name TEXT PRIMARY KEY, level INTEGER NOT NULL, grants TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      password TEXT NOT NULL, role TEXT NOT NULL REFERENCES roles(name), branches TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, failures INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY, name TEXT NOT NULL, sku TEXT UNIQUE NOT NULL,
      price INTEGER NOT NULL, cost INTEGER NOT NULL, reorder INTEGER NOT NULL, shelf TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS stock(branch TEXT REFERENCES branches(id), product TEXT REFERENCES products(id),
      quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0), reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved >= 0 AND reserved <= quantity),
      quarantine INTEGER NOT NULL DEFAULT 0 CHECK(quarantine >= 0), PRIMARY KEY(branch,product));
    CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, kind TEXT NOT NULL, branch TEXT NOT NULL REFERENCES branches(id),
      body TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS record_scope ON records(kind,branch);
    CREATE UNIQUE INDEX IF NOT EXISTS attendance_open ON records(json_extract(body,'$.employee'))
      WHERE kind='attendance' AND json_extract(body,'$.out') IS NULL;
    CREATE TABLE IF NOT EXISTS movements(id TEXT PRIMARY KEY, branch TEXT NOT NULL, product TEXT NOT NULL,
      quantity INTEGER NOT NULL, reason TEXT NOT NULL, reference TEXT NOT NULL, actor TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL,
      branch TEXT, action TEXT NOT NULL, target TEXT NOT NULL, details TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests(user_id TEXT NOT NULL, request_id TEXT NOT NULL, input TEXT NOT NULL,
      response TEXT NOT NULL, PRIMARY KEY(user_id,request_id));
  `);
  if (!db.prepare("SELECT name FROM pragma_table_info('products') WHERE name='version'").get()) db.exec("ALTER TABLE products ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
  if (!db.prepare("SELECT name FROM pragma_table_info('products') WHERE name='kind'").get()) db.exec("ALTER TABLE products ADD COLUMN kind TEXT NOT NULL DEFAULT 'Part'");
  if (!db.prepare("SELECT name FROM pragma_table_info('stock') WHERE name='shelf'").get()) db.exec("ALTER TABLE stock ADD COLUMN shelf TEXT NOT NULL DEFAULT ''");
  for (const [name, value] of Object.entries(roles)) {
    db.prepare("INSERT OR IGNORE INTO roles VALUES(?,?,?)").run(name, value.level, JSON.stringify(value.grants));
  }
  const branches = [
    ["north", "North London Hub", "Service centre", 51.58, -0.12],
    ["south", "South London Branch", "Service centre", 51.45, -0.1],
    ["central", "Birmingham Warehouse", "Warehouse", 52.48, -1.9],
    ["west", "Coventry Branch", "Service centre", 52.41, -1.51]
  ];
  for (const row of branches) db.prepare("INSERT OR IGNORE INTO branches VALUES(?,?,?,?,?)").run(...row);
  // Catalogue fixtures carry no sales or stock balances.
  for (const row of [
    ["oil", "5W-30 Engine Oil 5L", "DC-OIL-5", 3499, 2200, 10, "A-01"],
    ["pads", "Brake Pad Set", "DC-BRK-01", 4599, 2900, 8, "B-02"],
    ["filter", "Air Filter", "DC-AIR-01", 1899, 1000, 12, "A-03"],
    ["wiper", "Wiper Blades", "DC-WIP-01", 1899, 1000, 8, "C-01"]
  ]) db.prepare("INSERT OR IGNORE INTO products(id,name,sku,price,cost,reorder,shelf) VALUES(?,?,?,?,?,?,?)").run(...row);
  db.prepare("INSERT OR IGNORE INTO products(id,name,sku,price,cost,reorder,shelf,kind) VALUES(?,?,?,?,?,?,?,?)")
    .run("labour", "General Service Labour (hour)", "DC-SVC-HR", 6000, 3000, 0, "Service desk", "Service");
  for (const b of branches) for (const p of db.prepare("SELECT id FROM products WHERE kind!='Service'").all()) {
    db.prepare("INSERT OR IGNORE INTO stock(branch,product) VALUES(?,?)").run(b[0], p.id);
  }
  return db;
}
function bootstrap(db, email, password, name = "Corporate Administrator") {
  if (db.prepare("SELECT COUNT(*) AS n FROM users").get().n) return false;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) || !password || password.length < 14 || password.length > 200) {
    throw new Error("First startup requires a valid HUB_ADMIN_EMAIL and HUB_ADMIN_PASSWORD (14-200 characters).");
  }
  db.prepare("INSERT INTO users(id,email,name,password,role,branches) VALUES(?,?,?,?,?,?)")
    .run(randomUUID(), email.trim().toLowerCase(), name, passwordHash(password), "Corporate Operations Manager",
      JSON.stringify(db.prepare("SELECT id FROM branches").all().map(b => b.id)));
  return true;
}
module.exports = { openDatabase, bootstrap, passwordHash, passwordMatches, permissions, roles };
