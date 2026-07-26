// BI Web UI Server - reads SQLite + proxies OctoBus Connect API
import express from "express";
import fs from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";

const SQL = await initSqlJs();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
app.use(express.static(path.join(__dirname, "public")));

// Config from env
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "bi-store.db");
const OCTOBUS_URL = process.env.OCTOBUS_URL || "http://octobus:9000";
const CAPSET_TOKEN = process.env.CAPSET_TOKEN || "bi-capset-demo-token-0001";
const CONNECT_BASE = `${OCTOBUS_URL}/capsets/business-identification/connect/bi-prod`;

// Helper: open DB
function openDb() {
  if (!fs.existsSync(DB_PATH)) return new SQL.Database();
  const db = new SQL.Database(fs.readFileSync(DB_PATH));
  try { db.run("ALTER TABLE candidate_analyses ADD COLUMN report_json TEXT DEFAULT ''"); } catch { /* ok */ }
  return db;
}

function toCamel(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(toCamel);
  const r = {};
  for (const k of Object.keys(obj)) {
    const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    r[camel] = obj[k];
  }
  return r;
}

// ---------- API routes ----------

// List all analyses with candidate & replay info
app.get("/api/rules", (_req, res) => {
  const db = openDb();
  try {
    const rows = [];
    const stmt = db.prepare(
      "SELECT a.id, a.candidate_id, a.business_name, a.business_summary, a.confidence, a.risk_level, a.accepted, a.report_json, a.created_at FROM candidate_analyses a ORDER BY a.created_at DESC"
    );
    while (stmt.step()) {
      const row = toCamel(stmt.getAsObject());
      // Attach replay result
      const replayStmt = db.prepare("SELECT * FROM replay_results WHERE analysis_id = ? ORDER BY created_at DESC LIMIT 1");
      replayStmt.bind([row.id]);
      if (replayStmt.step()) {
        row.replay = toCamel(replayStmt.getAsObject());
      }
      replayStmt.free();

      // Check if already published
      const pubStmt = db.prepare("SELECT id, status FROM business_patterns WHERE candidate_id = ? LIMIT 1");
      pubStmt.bind([row.candidateId]);
      if (pubStmt.step()) {
        const pub = pubStmt.getAsObject();
        row.published = pub.status === "ACTIVE";
        row.patternId = pub.id;
      }
      pubStmt.free();

      // Parse report_json
      if (row.reportJson) {
        try { row.report = JSON.parse(row.reportJson); } catch {}
      }

      rows.push(row);
    }
    stmt.free();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    db.close();
  }
});

// Get full rule detail
app.get("/api/rules/:id", (req, res) => {
  const db = openDb();
  try {
    const stmt = db.prepare("SELECT * FROM candidate_analyses WHERE id = ?");
    stmt.bind([req.params.id]);
    if (!stmt.step()) { stmt.free(); db.close(); return res.status(404).json({ error: "not found" }); }
    const row = toCamel(stmt.getAsObject());
    stmt.free();

    // Parse JSON fields
    row.mustConditions = JSON.parse(row.mustConditionsJson || "[]");
    row.vetoConditions = JSON.parse(row.vetoConditionsJson || "[]");
    row.evidence = JSON.parse(row.evidenceJson || "[]");
    if (row.reportJson) {
      try { row.report = JSON.parse(row.reportJson); } catch {}
    }

    // Replay result
    const rp = db.prepare("SELECT * FROM replay_results WHERE analysis_id = ? ORDER BY created_at DESC LIMIT 1");
    rp.bind([row.id]);
    if (rp.step()) row.replay = toCamel(rp.getAsObject());
    rp.free();

    // Published check
    const pub = db.prepare("SELECT id, status FROM business_patterns WHERE candidate_id = ? LIMIT 1");
    pub.bind([row.candidateId]);
    if (pub.step()) {
      const p = pub.getAsObject();
      row.published = p.status === "ACTIVE";
      row.patternId = p.id;
    }
    pub.free();

    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    db.close();
  }
});

// Approve rule (PublishPattern)
app.post("/api/rules/:id/approve", async (req, res) => {
  const db = openDb();
  try {
    // Get the analysis to find candidate_id and replay_id
    const ana = db.prepare("SELECT candidate_id FROM candidate_analyses WHERE id = ?");
    ana.bind([req.params.id]);
    if (!ana.step()) { ana.free(); db.close(); return res.status(404).json({ error: "not found" }); }
    const candidateId = ana.getAsObject().candidate_id;
    ana.free();

    // Get replay_id
    const rp = db.prepare("SELECT id FROM replay_results WHERE analysis_id = ? LIMIT 1");
    rp.bind([req.params.id]);
    if (!rp.step()) { rp.free(); db.close(); return res.status(400).json({ error: "no replay found" }); }
    const replayId = rp.getAsObject().id;
    rp.free();
    db.close();

    const approvedBy = req.body.approved_by || "webui-operator";
    const comment = req.body.comment || "";

    const resp = await fetch(`${CONNECT_BASE}/businessidentification.v1.BusinessIdentificationService/PublishPattern`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CAPSET_TOKEN}`,
      },
      body: JSON.stringify({
        candidateId,
        analysisId: req.params.id,
        replayId,
        approvedBy,
        approvedComment: comment,
      }),
    });

    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reject rule (mark as not accepted)
app.post("/api/rules/:id/reject", async (_req, res) => {
  const db = openDb();
  try {
    db.run("UPDATE candidate_analyses SET accepted = 0 WHERE id = ?", [_req.params.id]);
    const buf = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(buf));
    res.json({ rejected: true, analysisId: _req.params.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    db.close();
  }
});

// Run verification (MatchIncomingAlerts)
app.post("/api/verify", async (req, res) => {
  try {
    const body = {
      tenantId: req.body.tenantId || "tenant-a",
    };
    if (req.body.incomingStart) body.incomingStart = req.body.incomingStart;
    if (req.body.incomingEnd) body.incomingEnd = req.body.incomingEnd;

    const resp = await fetch(`${CONNECT_BASE}/businessidentification.v1.BusinessIdentificationService/MatchIncomingAlerts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CAPSET_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
    const data = await resp.json();

    // Summarize - don't send all 813 results to the browser
    const results = data.results || [];
    const suppressed = results.filter(r => r.decision === "SUGGEST_SUPPRESS");
    const kept = results.filter(r => r.decision === "KEEP_ALERT");
    const vetoReasons = {};
    kept.forEach(r => {
      try {
        const reason = JSON.parse(r.reasonJson || "{}");
        const veto = reason.systemVeto || [];
        if (veto.length) veto.forEach(v => { vetoReasons[v] = (vetoReasons[v] || 0) + 1; });
        else vetoReasons["无匹配模式"] = (vetoReasons["无匹配模式"] || 0) + 1;
      } catch { vetoReasons["解析错误"] = (vetoReasons["解析错误"] || 0) + 1; }
    });

    res.json({
      scannedCount: data.scannedCount || 0,
      suppressCount: suppressed.length,
      keepCount: kept.length,
      suppressionRate: results.length ? (suppressed.length / results.length * 100).toFixed(1) : 0,
      vetoReasons,
      samples: {
        suppress: suppressed.slice(0, 3).map(r => ({ alertId: r.alertId, decision: r.decision, patternId: r.patternId })),
        keep: kept.slice(0, 3).map(r => {
          try {
            const reason = JSON.parse(r.reasonJson || "{}");
            return { alertId: r.alertId, decision: r.decision, veto: reason.systemVeto || ["无匹配"] };
          } catch { return { alertId: r.alertId, decision: r.decision, veto: ["解析错误"] }; }
        }),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List published patterns
app.get("/api/patterns", (_req, res) => {
  const db = openDb();
  try {
    const rows = [];
    const stmt = db.prepare("SELECT * FROM business_patterns ORDER BY created_at DESC");
    while (stmt.step()) {
      const row = toCamel(stmt.getAsObject());
      row.mustConditions = JSON.parse(row.mustConditionsJson || "[]");
      row.vetoConditions = JSON.parse(row.vetoConditionsJson || "[]");
      rows.push(row);
    }
    stmt.free();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    db.close();
  }
});

// List all candidates
app.get("/api/candidates", (_req, res) => {
  const db = openDb();
  try {
    const rows = [];
    const stmt = db.prepare("SELECT * FROM pattern_candidates ORDER BY created_at DESC");
    while (stmt.step()) rows.push(toCamel(stmt.getAsObject()));
    stmt.free();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    db.close();
  }
});

// ---------- Demo console ----------

app.post("/api/demo/reset", async (req, res) => {
  try {
    const body = {};
    const nc = parseInt(req.body.normalCount, 10);
    if (nc > 0) body.normalCount = nc;

    const resp = await fetch(`${CONNECT_BASE}/businessidentification.v1.BusinessIdentificationService/ResetDemo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CAPSET_TOKEN}` },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    // ResetDemo invalidates the DB, restart instance to pick up clean state
    if (data.importedCount) {
      execSync("docker exec octobus octobus instance restart bi-prod", { timeout: 10000, encoding: "utf-8" });
    }
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/demo/analyze", async (_req, res) => {
  try {
    // 1. 获取 project ID
    const listResp = await fetch(`http://agent-compose:7410/agentcompose.v2.ProjectService/ListProjects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5000),
    });
    const { projects } = await listResp.json();
    const projectId = projects?.[0]?.projectId;
    if (!projectId) {
      return res.status(500).json({ error: "project not found" });
    }

    // 2. 触发 Agent run
    const runResp = await fetch(`http://agent-compose:7410/agentcompose.v2.RunService/RunAgent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        agentName: "business-identification-agent",
        prompt: "请执行完整的在线训练流程：发现候选 -> 分析 -> 保存(含report_json) -> 回放验证。",
        detach: true,
      }),
      signal: AbortSignal.timeout(60000),
    });
    const runData = await runResp.json();
    const runId = runData?.run?.summary?.runId || "";
    if (runData?.code) {
      return res.status(500).json({ error: runData.message || runData.code });
    }
    res.json({ started: true, runId, message: "Agent 已触发，正在执行在线训练..." });
  } catch (e) {
    res.status(500).json({ error: e.message || "Agent trigger failed" });
  }
});

const PORT = process.env.PORT || 3456;
app.listen(PORT, () => {
  console.log(`BI WebUI running on http://0.0.0.0:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`OctoBus: ${OCTOBUS_URL}`);
});
