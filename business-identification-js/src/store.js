// SQLite-backed persistent store using sql.js (WASM, no native deps).
// Data persists across service restarts because the instance workdir
// lives under OctoBus's data volume.

import fs from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";
import { generateDemoAlerts, generateVerificationSet } from "./demo-data.js";
import { buildProfile } from "./normalizer.js";

// Top-level await ensures sql.js WASM is loaded before any handler calls.
const SQL = await initSqlJs();

let instance = null;

// Schema DDL matching 实施方案 section 11.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS alerts (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  rule_id               TEXT DEFAULT '',
  rule_category         TEXT DEFAULT '',
  service_key           TEXT DEFAULT '',
  protocol              TEXT DEFAULT 'HTTP',
  source_ip             TEXT DEFAULT '',
  source_segment        TEXT DEFAULT '',
  source_reputation     TEXT DEFAULT 'normal',
  source_is_internal    INTEGER DEFAULT 0,
  http_method           TEXT DEFAULT '',
  url                   TEXT DEFAULT '',
  url_path              TEXT DEFAULT '',
  url_pattern           TEXT DEFAULT '',
  url_first_dir         TEXT DEFAULT '',
  extension_category    TEXT DEFAULT '',
  request_body_type     TEXT DEFAULT 'empty',
  response_status       INTEGER DEFAULT 0,
  response_status_class TEXT DEFAULT '',
  response_content_type TEXT DEFAULT '',
  risk_level            TEXT DEFAULT 'LOW',
  is_confirmed_attack   INTEGER DEFAULT 0,
  has_path_traversal    INTEGER DEFAULT 0,
  has_dangerous_extension INTEGER DEFAULT 0,
  extraction_failed     INTEGER DEFAULT 0,
  expected_pattern      TEXT DEFAULT '',
  occurred_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pattern_candidates (
  id                     TEXT PRIMARY KEY,
  run_id                 TEXT NOT NULL,
  tenant_id              TEXT NOT NULL,
  discovery_time_start   TEXT,
  discovery_time_end     TEXT,
  candidate_type         TEXT NOT NULL DEFAULT 'EXACT_GROUP',
  status                 TEXT NOT NULL DEFAULT 'CANDIDATE',
  version                INTEGER DEFAULT 1,
  alert_count            INTEGER NOT NULL DEFAULT 0,
  active_days            INTEGER NOT NULL DEFAULT 0,
  source_count           INTEGER NOT NULL DEFAULT 0,
  success_rate           REAL NOT NULL DEFAULT 0,
  common_features_json   TEXT NOT NULL DEFAULT '{}',
  statistics_json        TEXT NOT NULL DEFAULT '{}',
  risk_summary_json      TEXT NOT NULL DEFAULT '{}',
  member_alert_ids_json  TEXT NOT NULL DEFAULT '[]',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS candidate_analyses (
  id                   TEXT PRIMARY KEY,
  candidate_id         TEXT NOT NULL,
  business_name        TEXT NOT NULL,
  business_summary     TEXT DEFAULT '',
  evidence_json        TEXT DEFAULT '[]',
  must_conditions_json TEXT DEFAULT '[]',
  veto_conditions_json TEXT DEFAULT '[]',
  confidence           REAL DEFAULT 0,
  risk_level           TEXT DEFAULT 'LOW',
  uncertainties_json   TEXT DEFAULT '[]',
  raw_agent_output     TEXT DEFAULT '',
  accepted             INTEGER DEFAULT 1,
  report_json          TEXT DEFAULT '',
  created_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS replay_results (
  id                             TEXT PRIMARY KEY,
  candidate_id                   TEXT NOT NULL,
  analysis_id                    TEXT NOT NULL,
  replay_time_start              TEXT NOT NULL,
  replay_time_end                TEXT NOT NULL,
  policy_snapshot_json           TEXT NOT NULL,
  policy_hash                    TEXT NOT NULL,
  system_veto_version            TEXT NOT NULL DEFAULT 'v1',
  scanned_count                  INTEGER NOT NULL DEFAULT 0,
  pattern_matched_count          INTEGER NOT NULL DEFAULT 0,
  suppression_suggested_count    INTEGER NOT NULL DEFAULT 0,
  risk_vetoed_count              INTEGER NOT NULL DEFAULT 0,
  boundary_vetoed_count          INTEGER NOT NULL DEFAULT 0,
  confirmed_attack_demoted_count INTEGER NOT NULL DEFAULT 0,
  known_risk_demoted_count       INTEGER NOT NULL DEFAULT 0,
  expected_true_positive_count   INTEGER,
  expected_false_positive_count  INTEGER,
  precision                      REAL,
  recall                         REAL,
  passed                         INTEGER NOT NULL DEFAULT 0,
  details_json                   TEXT NOT NULL DEFAULT '{}',
  created_at                     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS business_patterns (
  id                   TEXT PRIMARY KEY,
  candidate_id         TEXT NOT NULL,
  analysis_id          TEXT NOT NULL,
  replay_id            TEXT NOT NULL,
  tenant_id            TEXT NOT NULL,
  name                 TEXT NOT NULL,
  description          TEXT DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'ACTIVE',
  version              INTEGER NOT NULL DEFAULT 1,
  must_conditions_json TEXT DEFAULT '[]',
  veto_conditions_json TEXT DEFAULT '[]',
  system_veto_version  TEXT NOT NULL DEFAULT 'v1',
  approved_by          TEXT DEFAULT '',
  approved_comment     TEXT DEFAULT '',
  approved_at          TEXT NOT NULL,
  created_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS match_results (
  id            TEXT PRIMARY KEY,
  alert_id      TEXT NOT NULL,
  pattern_id    TEXT,
  matched       INTEGER NOT NULL DEFAULT 0,
  decision      TEXT NOT NULL DEFAULT 'KEEP_ALERT',
  system_vetoed INTEGER NOT NULL DEFAULT 0,
  must_passed   INTEGER NOT NULL DEFAULT 0,
  veto_passed   INTEGER NOT NULL DEFAULT 0,
  reason_json   TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seq (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_alerts_tenant_occurred ON alerts(tenant_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_candidates_tenant_status ON pattern_candidates(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_patterns_tenant_status ON business_patterns(tenant_id, status);
`;

// ---- helpers ----

function resolveDataDir(ctx) {
  const cfg = ctx && ctx.config && typeof ctx.config === "object" ? ctx.config : {};
  if (typeof cfg.dataDir === "string" && cfg.dataDir.length > 0) return cfg.dataDir;
  const workdir = ctx && ctx.workdir ? ctx.workdir : process.cwd();
  return path.join(workdir, "data");
}

function openDb(dbPath) {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  let db;
  if (fs.existsSync(dbPath)) {
    db = new SQL.Database(fs.readFileSync(dbPath));
  } else {
    db = new SQL.Database();
  }
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA foreign_keys=ON");
  db.exec(SCHEMA);
  // Migration: add report_json column if missing
  try { db.run("ALTER TABLE candidate_analyses ADD COLUMN report_json TEXT DEFAULT ''"); } catch { /* already exists */ }
  return db;
}

function makeStore(db, dbPath) {
  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    if (params.length) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }
  function one(sql, params = []) {
    const stmt = db.prepare(sql);
    if (params.length) stmt.bind(params);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row;
  }
  return {
    db, dbPath, all, one,
    save() {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.writeFileSync(dbPath, Buffer.from(db.export()), { mode: 0o600 });
    },
    nextId(prefix) {
      const row = one("SELECT value FROM seq WHERE name = ?", [prefix]);
      const n = (row ? row.value : 0) + 1;
      db.run(row
        ? "UPDATE seq SET value = ? WHERE name = ?"
        : "INSERT INTO seq(name,value) VALUES(?,?)",
        row ? [n, prefix] : [prefix, n]);
      return `${prefix}-${String(n).padStart(4, "0")}`;
    },
  };
}

// ---- auto-load demo data on first startup ----

function insertAlerts(db, results) {
  const cols = "id,tenant_id,rule_id,rule_category,service_key,protocol,source_ip,source_segment,source_reputation,source_is_internal,http_method,url,url_path,url_pattern,url_first_dir,extension_category,request_body_type,response_status,response_status_class,response_content_type,risk_level,is_confirmed_attack,has_path_traversal,has_dangerous_extension,extraction_failed,expected_pattern,occurred_at".split(",");
  const ph = cols.map(() => "?").join(",");
  const insert = db.prepare(`INSERT INTO alerts(${cols.join(",")}) VALUES(${ph})`);

  for (const { raw } of results) {
    const p = buildProfile(raw);
    insert.run([
      p.id, p.tenantId, p.ruleId, p.ruleCategory, p.serviceKey, p.protocol,
      p.sourceIp, p.sourceSegment, p.sourceReputation, p.sourceIsInternal ? 1 : 0,
      p.httpMethod, p.url, p.urlPath, p.urlPattern, p.urlFirstDir, p.extensionCategory,
      p.requestBodyType, p.responseStatus, p.responseStatusClass, p.responseContentType,
      p.riskLevel, p.isConfirmedAttack ? 1 : 0, p.hasPathTraversal ? 1 : 0,
      p.hasDangerousExtension ? 1 : 0, p.extractionFailed ? 1 : 0,
      p.expectedPattern, p.occurredAt,
    ]);
  }
  insert.free();
}

function autoLoad(db) {
  const { results } = generateDemoAlerts();
  insertAlerts(db, results);
  // Load static labeled verification set
  const verifResults = generateVerificationSet();
  insertAlerts(db, verifResults);
}

// ---- public API ----

export function getStore(ctx) {
  if (instance) return instance;
  const dbPath = path.join(resolveDataDir(ctx), "bi-store.db");
  const db = openDb(dbPath);

  // Auto-load demo data if DB is empty (first startup).
  const countRow = db.prepare("SELECT count(*) as c FROM alerts");
  countRow.step();
  const alertCount = countRow.getAsObject().c;
  countRow.free();
  if (alertCount === 0) {
    autoLoad(db);
  }

  instance = makeStore(db, dbPath);
  if (alertCount === 0) instance.save();
  return instance;
}

export function resetStore(ctx) {
  if (instance) { instance.db.close(); instance = null; }
  const dbPath = path.join(resolveDataDir(ctx), "bi-store.db");
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  try { fs.unlinkSync(dbPath + "-wal"); } catch { /* ignore */ }
  try { fs.unlinkSync(dbPath + "-shm"); } catch { /* ignore */ }
  const db = openDb(dbPath);
  instance = makeStore(db, dbPath);
  return instance;
}
