#!/usr/bin/env node
// Generate demo alerts directly into the SQLite database.
//
// Usage:
//   node scripts/generate-alerts.mjs --db bi-store.db --mode training --normal 500 --boundary 25 --risk 30
//   node scripts/generate-alerts.mjs --db bi-store.db --mode verification --normal 210 --boundary 12 --risk 16
//   node scripts/generate-alerts.mjs --db bi-store.db --mode live --normal 100 --boundary 10 --risk 10
//
// Modes:
//   training     — 最近24h原始告警，用于 DiscoverCandidates
//   verification — 独立打标验证集，ID=verif-前缀，带expected_pattern标签，用于RunReplay
//   live         — 最近1h告警，用于 MatchIncomingAlerts

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";
import { buildProfile } from "../src/normalizer.js";

const SQL = await initSqlJs();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.join(__dirname, "..");

// ---- CLI args ----

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { mode: "training", normal: 100, boundary: 10, risk: 10 };
  for (let i = 0; i < args.length; i++) {
    const val = args[i + 1];
    switch (args[i]) {
      case "--db": opts.db = val; i++; break;
      case "--mode": opts.mode = val; i++; break;
      case "--normal": opts.normal = parseInt(val, 10); i++; break;
      case "--boundary": opts.boundary = parseInt(val, 10); i++; break;
      case "--risk": opts.risk = parseInt(val, 10); i++; break;
      case "--help": printHelp(); process.exit(0);
    }
  }
  if (!opts.db) {
    console.error("--db <path> is required");
    process.exit(1);
  }
  return opts;
}

function printHelp() {
  console.log(`
Usage: node scripts/generate-alerts.mjs --db <path> [options]

Options:
  --db <path>       Path to bi-store.db (required)
  --mode <mode>     training | verification | live (default: training)
  --normal <n>      Number of normal alerts (default: 100)
  --boundary <n>    Number of boundary alerts (default: 10)
  --risk <n>        Number of risk alerts (default: 10)
  --help            Show this help
`);
}

// ---- alert templates (same as demo-data.js) ----

const MS_HOUR = 3600000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const SEGMENTS = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"];

function ipIn(seg, rng) {
  const base = seg.split("/")[0].split(".").slice(0, 3).join(".");
  return `${base}.${1 + Math.floor(rng() * 254)}`;
}

function tsBetween(start, end, rng) {
  const s = Date.parse(start);
  const e = Date.parse(end);
  return new Date(s + Math.floor(rng() * (e - s))).toISOString();
}

let counter = 0;
let prefix = "alert-";
function nextId() { counter += 1; return prefix + String(counter).padStart(5, "0"); }

function normalAlert(rng, winStart, winEnd) {
  const num = 10000 + Math.floor(rng() * 90000);
  const status = rng() < 0.85 ? 200 : 304;
  const seg = SEGMENTS[Math.floor(rng() * SEGMENTS.length)];
  return { id: nextId(), tenant_id: "tenant-a", rule_id: "RULE_ORDER", rule_category: "business_api", service_key: "order-service", protocol: "HTTP", source_ip: ipIn(seg, rng), source_segment: seg, source_reputation: "normal", source_is_internal: true, http_method: "GET", url: `/api/orders/${num}/payment-status`, request_body_type: "empty", response_status: status, response_content_type: "application/json", risk_level: "LOW", is_confirmed_attack: false, has_path_traversal: false, has_dangerous_extension: false, extraction_failed: false, expected_pattern: "order-payment-status", occurred_at: tsBetween(winStart, winEnd, rng) };
}

function boundaryAlert(rng, winStart, winEnd) {
  const num = 10000 + Math.floor(rng() * 90000);
  const status = rng() < 0.5 ? 200 : 503;
  const seg = SEGMENTS[Math.floor(rng() * SEGMENTS.length)];
  return { id: nextId(), tenant_id: "tenant-a", rule_id: "RULE_ORDER", rule_category: "business_api", service_key: "order-service", protocol: "HTTP", source_ip: ipIn(seg, rng), source_segment: seg, source_reputation: "normal", source_is_internal: true, http_method: "POST", url: `/api/orders/${num}/payment-status`, request_body_type: "json", response_status: status, response_content_type: "application/json", risk_level: "LOW", is_confirmed_attack: false, has_path_traversal: false, has_dangerous_extension: false, extraction_failed: false, expected_pattern: "", occurred_at: tsBetween(winStart, winEnd, rng) };
}

const RISK_TEMPLATES = [
  { is_confirmed_attack: true, risk_level: "HIGH", url: "/api/admin/export", http_method: "GET" },
  { source_reputation: "malicious", risk_level: "MEDIUM", url: "/api/data", http_method: "GET" },
  { has_path_traversal: true, risk_level: "HIGH", url: "/static/../../etc/passwd", http_method: "GET" },
  { has_dangerous_extension: true, risk_level: "HIGH", url: "/uploads/shell.php", http_method: "GET" },
  { risk_level: "HIGH", url: "/api/debug", http_method: "GET" },
  { extraction_failed: true, risk_level: "LOW", url: "/weird/binary", http_method: "GET" },
];

function riskAlert(rng, winStart, winEnd) {
  const tpl = RISK_TEMPLATES[Math.floor(rng() * RISK_TEMPLATES.length)];
  const seg = SEGMENTS[Math.floor(rng() * SEGMENTS.length)];
  return { id: nextId(), tenant_id: "tenant-a", rule_id: "RULE_EXPLOIT", rule_category: "exploit", service_key: "external-edge", protocol: "HTTP", source_ip: ipIn(seg, rng), source_segment: seg, source_reputation: tpl.source_reputation || "normal", source_is_internal: false, http_method: tpl.http_method, url: tpl.url, request_body_type: "empty", response_status: 200, response_content_type: "text/plain", risk_level: tpl.risk_level, is_confirmed_attack: !!tpl.is_confirmed_attack, has_path_traversal: !!tpl.has_path_traversal, has_dangerous_extension: !!tpl.has_dangerous_extension, extraction_failed: !!tpl.extraction_failed, expected_pattern: "", occurred_at: tsBetween(winStart, winEnd, rng) };
}

// ---- main ----

function buildWindow(mode) {
  const now = Date.now();
  const end = (d) => new Date(d).toISOString();
  switch (mode) {
    case "training":     return [end(now - 24 * MS_HOUR), end(now)];
    case "verification": return [end(now - 48 * MS_HOUR), end(now - 24 * MS_HOUR)];
    case "live":         return [end(now), end(now + MS_HOUR)];
    default:             return [end(now - 24 * MS_HOUR), end(now)];
  }
}

const opts = parseArgs();
console.log(`Generating alerts: mode=${opts.mode} normal=${opts.normal} boundary=${opts.boundary} risk=${opts.risk}`);
console.log(`Database: ${opts.db}`);

// Resolve db path (relative to cwd)
const dbPath = path.resolve(opts.db);
const dbDir = path.dirname(dbPath);
fs.mkdirSync(dbDir, { recursive: true });

let db;
if (fs.existsSync(dbPath)) {
  db = new SQL.Database(fs.readFileSync(dbPath));
} else {
  db = new SQL.Database();
}

// Ensure schema exists (use same as store.js, but minimal to work standalone)
db.run("CREATE TABLE IF NOT EXISTS alerts ("
  + "id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, rule_id TEXT DEFAULT '', rule_category TEXT DEFAULT '',"
  + "service_key TEXT DEFAULT '', protocol TEXT DEFAULT 'HTTP',"
  + "source_ip TEXT DEFAULT '', source_segment TEXT DEFAULT '', source_reputation TEXT DEFAULT 'normal',"
  + "source_is_internal INTEGER DEFAULT 0,"
  + "http_method TEXT DEFAULT '', url TEXT DEFAULT '', url_path TEXT DEFAULT '', url_pattern TEXT DEFAULT '',"
  + "url_first_dir TEXT DEFAULT '', extension_category TEXT DEFAULT '', request_body_type TEXT DEFAULT 'empty',"
  + "response_status INTEGER DEFAULT 0, response_status_class TEXT DEFAULT '', response_content_type TEXT DEFAULT '',"
  + "risk_level TEXT DEFAULT 'LOW', is_confirmed_attack INTEGER DEFAULT 0, has_path_traversal INTEGER DEFAULT 0,"
  + "has_dangerous_extension INTEGER DEFAULT 0, extraction_failed INTEGER DEFAULT 0,"
  + "expected_pattern TEXT DEFAULT '', occurred_at TEXT NOT NULL"
  + ")");

// Set ID prefix based on mode
const isVerification = opts.mode === "verification";
prefix = isVerification ? "verif-" : "alert-";

// Determine next alert ID to avoid conflicts with existing data.
const maxRow = db.exec(`SELECT MAX(CAST(SUBSTR(id, ${isVerification ? 7 : 7}) AS INTEGER)) FROM alerts WHERE id LIKE '${prefix}%'`);
counter = (maxRow[0] && maxRow[0].values[0][0]) || 0;

const [winStart, winEnd] = buildWindow(opts.mode);
console.log(`Time window: ${winStart} — ${winEnd}`);

const rng = mulberry32(Date.now());
const alerts = [];
for (let i = 0; i < opts.normal; i++) {
  const a = normalAlert(rng, winStart, winEnd);
  if (isVerification) a.expected_pattern = "order-payment-status";
  alerts.push(a);
}
for (let i = 0; i < opts.boundary; i++) alerts.push(boundaryAlert(rng, winStart, winEnd));
for (let i = 0; i < opts.risk; i++) alerts.push(riskAlert(rng, winStart, winEnd));

// Insert with profile normalization
const cols = "id,tenant_id,rule_id,rule_category,service_key,protocol,source_ip,source_segment,source_reputation,source_is_internal,http_method,url,url_path,url_pattern,url_first_dir,extension_category,request_body_type,response_status,response_status_class,response_content_type,risk_level,is_confirmed_attack,has_path_traversal,has_dangerous_extension,extraction_failed,expected_pattern,occurred_at".split(",");
const ph = cols.map(() => "?").join(",");
const insert = db.prepare(`INSERT INTO alerts(${cols.join(",")}) VALUES(${ph})`);

let boundaryCount = 0, riskCount = 0, normalCount = 0;
for (const raw of alerts) {
  const p = buildProfile(raw);
  insert.run([p.id, p.tenantId, p.ruleId, p.ruleCategory, p.serviceKey, p.protocol, p.sourceIp, p.sourceSegment, p.sourceReputation, p.sourceIsInternal ? 1 : 0, p.httpMethod, p.url, p.urlPath, p.urlPattern, p.urlFirstDir, p.extensionCategory, p.requestBodyType, p.responseStatus, p.responseStatusClass, p.responseContentType, p.riskLevel, p.isConfirmedAttack ? 1 : 0, p.hasPathTraversal ? 1 : 0, p.hasDangerousExtension ? 1 : 0, p.extractionFailed ? 1 : 0, p.expectedPattern, p.occurredAt]);
  if (p.httpMethod === "POST" || p.url.includes("/api/orders/")) { // boundary pattern
    if (p.httpMethod === "POST" || p.responseStatusClass === "5xx") boundaryCount++;
    else normalCount++;
  } else {
    riskCount++;
  }
}
insert.free();

fs.mkdirSync(dbDir, { recursive: true });
fs.writeFileSync(dbPath, Buffer.from(db.export()), { mode: 0o600 });
db.close();

console.log(`Inserted: ${alerts.length} alerts (est. normal: ${normalCount}, boundary: ${boundaryCount}, risk: ${riskCount})`);
console.log(`Database saved: ${dbPath}`);
