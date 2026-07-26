// RPC handlers for the business-identification closed loop.
// Uses SQLite (sql.js) for persistent storage.
import { getStore, resetStore } from "./store.js";
import { buildProfile } from "./normalizer.js";
import { discoverCandidates } from "./candidate.js";
import { validateAnalysis } from "./analysis-validator.js";
import { evaluateMust, evaluateVeto } from "./condition-evaluator.js";
import { systemVeto } from "./system-veto.js";
import { generateDemoAlerts, generateVerificationSet } from "./demo-data.js";
import { grpcInvalidArgumentError, grpcNotFoundError } from "@chaitin-ai/octobus-sdk";

// sql.js returns snake_case keys; handlers need camelCase.
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

function findCandidate(store, id) {
  return toCamel(store.one("SELECT * FROM pattern_candidates WHERE id = ?", [id]));
}
function findAnalysis(store, id) {
  return toCamel(store.one("SELECT * FROM candidate_analyses WHERE id = ?", [id]));
}
function findReplay(store, id) {
  return toCamel(store.one("SELECT * FROM replay_results WHERE id = ?", [id]));
}
function findPatternByCandidate(store, candidateId) {
  return toCamel(store.one("SELECT * FROM business_patterns WHERE candidate_id = ?", [candidateId]));
}

const ALERT_COLUMNS = [
  "id","tenant_id","rule_id","rule_category","service_key","protocol",
  "source_ip","source_segment","source_reputation","source_is_internal",
  "http_method","url","url_path","url_pattern","url_first_dir","extension_category",
  "request_body_type","response_status","response_status_class","response_content_type",
  "risk_level","is_confirmed_attack","has_path_traversal","has_dangerous_extension",
  "extraction_failed","expected_pattern","occurred_at",
];

function insertAlertStmt(db) {
  if (!insertAlertStmt._s) {
    const cols = ALERT_COLUMNS.join(",");
    const ph = ALERT_COLUMNS.map(() => "?").join(",");
    insertAlertStmt._s = db.prepare(`INSERT OR REPLACE INTO alerts(${cols}) VALUES(${ph})`);
  }
  return insertAlertStmt._s;
}

// ---------------------------------------------------------------------------
// RPC handlers
// ---------------------------------------------------------------------------

export function resetDemo(ctx) {
  const store = resetStore(ctx);
  const normalCount = ctx.request.normalCount || 1000;
  const { results: generated, windows } = generateDemoAlerts(Date.now(), { normalCount });
  const boundaryIds = [];
  const riskIds = [];

  const stmt = insertAlertStmt(store.db);
  for (const { raw, kind } of generated) {
    const profile = buildProfile(raw);
    stmt.run([
      profile.id, profile.tenantId, profile.ruleId, profile.ruleCategory,
      profile.serviceKey, profile.protocol, profile.sourceIp, profile.sourceSegment,
      profile.sourceReputation, profile.sourceIsInternal ? 1 : 0,
      profile.httpMethod, profile.url, profile.urlPath, profile.urlPattern, profile.urlFirstDir,
      profile.extensionCategory, profile.requestBodyType, profile.responseStatus,
      profile.responseStatusClass, profile.responseContentType,
      profile.riskLevel, profile.isConfirmedAttack ? 1 : 0, profile.hasPathTraversal ? 1 : 0,
      profile.hasDangerousExtension ? 1 : 0, profile.extractionFailed ? 1 : 0,
      profile.expectedPattern, profile.occurredAt,
    ]);
    if (kind === "boundary") boundaryIds.push(profile.id);
    if (kind === "risk") riskIds.push(profile.id);
  }

  // Also load static labeled verification set
  const verifResults = generateVerificationSet();
  for (const { raw } of verifResults) {
    const profile = buildProfile(raw);
    stmt.run([
      profile.id, profile.tenantId, profile.ruleId, profile.ruleCategory,
      profile.serviceKey, profile.protocol, profile.sourceIp, profile.sourceSegment,
      profile.sourceReputation, profile.sourceIsInternal ? 1 : 0,
      profile.httpMethod, profile.url, profile.urlPath, profile.urlPattern, profile.urlFirstDir,
      profile.extensionCategory, profile.requestBodyType, profile.responseStatus,
      profile.responseStatusClass, profile.responseContentType,
      profile.riskLevel, profile.isConfirmedAttack ? 1 : 0, profile.hasPathTraversal ? 1 : 0,
      profile.hasDangerousExtension ? 1 : 0, profile.extractionFailed ? 1 : 0,
      profile.expectedPattern, profile.occurredAt,
    ]);
  }

  store.save();

  return {
    importedCount: generated.length,
    trainingWindowStart: windows.training[0],
    trainingWindowEnd: windows.training[1],
    testingWindowStart: windows.testing[0],
    testingWindowEnd: windows.testing[1],
    liveWindowStart: windows.live[0],
    liveWindowEnd: windows.live[1],
  };
}

export function discoverCandidatesHandler(ctx) {
  const res = discoverCandidates(ctx, ctx.request);
  return {
    runId: res.runId,
    algorithm: res.algorithm,
    scannedCount: res.scannedCount,
    groupCount: res.groupCount,
    candidateCount: res.candidateCount,
    candidateIds: res.candidateIds,
  };
}

export function listCandidates(ctx) {
  const store = getStore(ctx);
  const tenantId = ctx.request.tenantId || "tenant-a";
  let rows;
  const status = ctx.request.status;
  if (status) {
    rows = store.all("SELECT * FROM pattern_candidates WHERE tenant_id = ? AND status = ?", [tenantId, status]);
  } else {
    rows = store.all("SELECT * FROM pattern_candidates WHERE tenant_id = ?", [tenantId]);
  }
  return {
    candidates: rows.map((c) => toCamel(c)).map((c) => ({
      id: c.id,
      runId: c.runId,
      candidateType: c.candidateType,
      status: c.status,
      alertCount: c.alertCount,
      activeDays: c.activeDays,
      sourceCount: c.sourceCount,
      successRate: c.successRate,
      commonFeaturesJson: c.commonFeaturesJson,
      statisticsJson: c.statisticsJson,
      riskSummaryJson: c.riskSummaryJson,
    })),
  };
}

export function getCandidateContext(ctx) {
  const store = getStore(ctx);
  const cand = findCandidate(store, ctx.request.candidateId);
  if (!cand) throw grpcNotFoundError(`candidate not found: ${ctx.request.candidateId}`);

  const memberIds = JSON.parse(cand.memberAlertIdsJson || "[]");
  const rows = memberIds.length > 0
    ? store.all(`SELECT * FROM alerts WHERE id IN (${memberIds.map(() => "?").join(",")})`, memberIds).map(toCamel)
    : [];
  const byId = new Map(rows.map((a) => [a.id, a]));

  // Boundary samples: POST or 5xx on same URL pattern
  const boundaryRows = store.all(
    "SELECT id FROM alerts WHERE id IN (" + memberIds.map(() => "?").join(",") + ") AND (http_method != 'GET' OR response_status >= 500) LIMIT 5",
    memberIds
  );
  const boundaryIds = boundaryRows.map(r => r.id);

  // Risk samples: any alert with risk flags
  const riskRows = store.all(
    "SELECT id FROM alerts WHERE is_confirmed_attack = 1 OR has_path_traversal = 1 OR has_dangerous_extension = 1 OR source_reputation = 'malicious' OR risk_level = 'HIGH' OR extraction_failed = 1 LIMIT 5"
  );
  const riskIds = riskRows.map(r => r.id);

  const toSample = (id, note) => {
    const p = byId.get(id);
    if (!p) return null;
    return {
      alertId: p.id,
      serviceKey: p.serviceKey,
      httpMethod: p.httpMethod,
      url: p.url,
      responseStatus: p.responseStatus,
      riskLevel: p.riskLevel,
      note: note || "",
    };
  };

  const representative = memberIds.slice(0, 5).map((id) => toSample(id, "representative")).filter(Boolean);
  const boundary = boundaryIds.slice(0, 5).map((id) => toSample(id, "boundary")).filter(Boolean);
  const risk = riskIds.slice(0, 5).map((id) => toSample(id, "risk")).filter(Boolean);

  return {
    candidateId: cand.id,
    summaryJson: JSON.stringify({
      commonFeatures: JSON.parse(cand.commonFeaturesJson || "{}"),
      statistics: JSON.parse(cand.statisticsJson || "{}"),
      riskSummary: JSON.parse(cand.riskSummaryJson || "{}"),
    }),
    representativeSamples: representative,
    boundarySamples: boundary,
    riskSamples: risk,
  };
}

export function saveCandidateAnalysis(ctx) {
  const store = getStore(ctx);
  const req = ctx.request;
  const cand = findCandidate(store, req.candidateId);
  const { accepted, errors } = validateAnalysis(req, !!cand);
  if (!accepted) {
    return { accepted: false, analysisId: "", validationErrors: errors };
  }
  const id = store.nextId("analysis");
  const now = new Date().toISOString();
  store.db.run(`INSERT INTO candidate_analyses(
    id,candidate_id,business_name,business_summary,evidence_json,
    must_conditions_json,veto_conditions_json,confidence,risk_level,
    uncertainties_json,raw_agent_output,report_json,accepted,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?)`, [
    id, req.candidateId, req.businessName, req.businessSummary || "",
    JSON.stringify(req.evidence || []),
    JSON.stringify(req.mustConditions || []),
    JSON.stringify(req.vetoConditions || []),
    typeof req.confidence === "number" ? req.confidence : 0,
    req.riskLevel || "LOW",
    JSON.stringify(req.uncertainties || []),
    req.rawAgentOutput || "",
    req.reportJson || "", now,
  ]);
  store.save();
  return { accepted: true, analysisId: id, validationErrors: [] };
}

export function runReplay(ctx) {
  const store = getStore(ctx);
  const req = ctx.request;
  const candidate = findCandidate(store, req.candidateId);
  if (!candidate) throw grpcNotFoundError(`candidate not found: ${req.candidateId}`);

  const analysis = req.analysisId
    ? findAnalysis(store, req.analysisId)
    : toCamel(store.one("SELECT * FROM candidate_analyses WHERE candidate_id = ? LIMIT 1", [req.candidateId]));
  if (!analysis) throw grpcInvalidArgumentError("no saved analysis for candidate");
  if (!analysis.accepted) throw grpcInvalidArgumentError("analysis was rejected by validation");

  // Default: use labeled verification set if available, otherwise time window
  const hasVerifSet = store.one("SELECT count(*) as c FROM alerts WHERE id LIKE 'verif-%'")?.c > 0;
  const replayStart = req.replayStart || (hasVerifSet ? "1970-01-01T00:00:00Z" : "");
  const replayEnd = req.replayEnd || (hasVerifSet ? "2099-01-01T00:00:00Z" : "");
  if (!hasVerifSet && (!replayStart || !replayEnd)) {
    throw grpcInvalidArgumentError("no verification set and no replay window specified");
  }
  const useVerifSet = hasVerifSet && !req.replayStart && !req.replayEnd;
  if (!useVerifSet) {
    if (candidate.discoveryTimeStart < replayEnd && candidate.discoveryTimeEnd > replayStart) {
      throw grpcInvalidArgumentError("training window overlaps testing window (data leakage)");
    }
  }
  // Query: verification set uses label filter; time window uses occurrence filter
  const alertRows = useVerifSet
    ? store.all("SELECT * FROM alerts WHERE tenant_id = ? AND id LIKE 'verif-%'", [candidate.tenantId])
    : store.all("SELECT * FROM alerts WHERE tenant_id = ? AND occurred_at >= ? AND occurred_at <= ?", [candidate.tenantId, replayStart, replayEnd]);

  const must = JSON.parse(analysis.mustConditionsJson || "[]");
  const veto = JSON.parse(analysis.vetoConditionsJson || "[]");
  const memberIds = JSON.parse(candidate.memberAlertIdsJson || "[]");
  const memberSet = new Set(memberIds);
  const expectedMode = modeOfExpected(memberIds, store);

  let scanned = 0, matched = 0, suppression = 0, riskVetoed = 0, boundaryVetoed = 0;
  let confirmedDemoted = 0, knownRiskDemoted = 0, tp = 0, fp = 0, fn = 0;

  for (const raw of alertRows) {
    const a = toCamel(raw);
    scanned += 1;
    const sys = systemVeto(a);
    if (sys.length) {
      riskVetoed += 1;
      // defensive: if somehow matched, count demotions
      const m = evaluateMust(must, a);
      const v = evaluateVeto(veto, a);
      if (m.allPass && !v.anyVeto) {
        if (a.isConfirmedAttack) confirmedDemoted += 1;
        if (a.riskLevel === "HIGH" || a.sourceReputation === "malicious") knownRiskDemoted += 1;
      }
      continue;
    }
    const m = evaluateMust(must, a);
    const v = evaluateVeto(veto, a);
    if (m.allPass && !v.anyVeto) {
      matched += 1;
      const expected = a.expectedPattern === expectedMode && a.expectedPattern !== "";
      if (expected) { tp += 1; suppression += 1; }
      else { fp += 1; suppression += 1; }
    } else {
      if (v.anyVeto) boundaryVetoed += 1;
      if (a.expectedPattern === expectedMode && a.expectedPattern !== "") fn += 1;
    }
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const passed = matched >= 1 && suppression >= 1 && confirmedDemoted === 0 && knownRiskDemoted === 0;

  const replayId = store.nextId("replay");
  const now = new Date().toISOString();
  store.db.run(`INSERT INTO replay_results(
    id,candidate_id,analysis_id,replay_time_start,replay_time_end,
    policy_snapshot_json,policy_hash,system_veto_version,
    scanned_count,pattern_matched_count,suppression_suggested_count,
    risk_vetoed_count,boundary_vetoed_count,confirmed_attack_demoted_count,
    known_risk_demoted_count,expected_true_positive_count,expected_false_positive_count,
    precision,recall,passed,details_json,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    replayId, candidate.id, analysis.id, replayStart, replayEnd,
    JSON.stringify({ must, veto }), hashJson({ must, veto }), "v1",
    scanned, matched, suppression, riskVetoed, boundaryVetoed,
    confirmedDemoted, knownRiskDemoted, tp, fp,
    precision, recall, passed ? 1 : 0,
    JSON.stringify({ tp, fp, fn }), now,
  ]);
  store.save();
  return {
    replayId, scannedCount: scanned, patternMatchedCount: matched,
    suppressionSuggestedCount: suppression, riskVetoedCount: riskVetoed,
    boundaryVetoedCount: boundaryVetoed, confirmedAttackDemotedCount: confirmedDemoted,
    knownRiskDemotedCount: knownRiskDemoted, precision, recall, passed,
    detailsJson: JSON.stringify({ tp, fp, fn }),
  };
}

export function publishPattern(ctx) {
  const store = getStore(ctx);
  const req = ctx.request;
  const errors = [];

  const candidate = findCandidate(store, req.candidateId);
  if (!candidate) errors.push("candidate not found");

  const analysis = req.analysisId
    ? findAnalysis(store, req.analysisId)
    : toCamel(store.one("SELECT * FROM candidate_analyses WHERE candidate_id = ? LIMIT 1", [req.candidateId]));
  if (!analysis) errors.push("analysis not found");

  const replay = req.replayId
    ? findReplay(store, req.replayId)
    : toCamel(store.one("SELECT * FROM replay_results WHERE candidate_id = ? LIMIT 1", [req.candidateId]));
  if (!replay) errors.push("replay not found");

  if (analysis && !analysis.accepted) errors.push("analysis was rejected");
  if (replay && !replay.passed) errors.push("replay did not pass");
  if (findPatternByCandidate(store, req.candidateId)) errors.push("candidate already published");
  if (!req.approvedBy || !String(req.approvedBy).trim()) errors.push("approved_by is required");
  if (errors.length) return { published: false, patternId: "", errors };

  const patternId = store.nextId("pattern");
  const now = new Date().toISOString();
  store.db.run(`INSERT INTO business_patterns(
    id,candidate_id,analysis_id,replay_id,tenant_id,name,description,
    status,version,must_conditions_json,veto_conditions_json,
    system_veto_version,approved_by,approved_comment,approved_at,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    patternId, candidate.id, analysis.id, replay.id, candidate.tenantId,
    analysis.businessName, analysis.businessSummary, "ACTIVE", 1,
    analysis.mustConditionsJson, analysis.vetoConditionsJson,
    "v1", req.approvedBy, req.approvedComment || "", now, now,
  ]);
  store.save();
  return { published: true, patternId, errors: [] };
}

export function matchIncomingAlerts(ctx) {
  const store = getStore(ctx);
  const req = ctx.request;
  const tenantId = req.tenantId || "tenant-a";

  let alertRows;
  if (req.alertIds && req.alertIds.length) {
    const placeholders = req.alertIds.map(() => "?").join(",");
    alertRows = store.all(`SELECT * FROM alerts WHERE id IN (${placeholders})`, req.alertIds);
  } else {
    const s = req.incomingStart || new Date(Date.now() - 3600 * 72 * 1000).toISOString();
    const e = req.incomingEnd || new Date().toISOString();
    alertRows = store.all("SELECT * FROM alerts WHERE tenant_id = ? AND occurred_at >= ? AND occurred_at <= ?", [tenantId, s, e]);
  }

  const patternRows = store.all("SELECT * FROM business_patterns WHERE status = 'ACTIVE' AND tenant_id = ?", [tenantId]);
  const patterns = patternRows.map(toCamel);

  const results = [];
  let matched = 0, suppress = 0, keep = 0;
  for (const raw of alertRows) {
    const a = toCamel(raw);
    const sys = systemVeto(a);
    if (sys.length) {
      results.push({
        alertId: a.id, matched: false, patternId: "",
        decision: "KEEP_ALERT",
        reasonJson: JSON.stringify({ systemVeto: sys, mustResults: [], vetoResults: [] }),
      });
      keep += 1;
      continue;
    }
    let hit = null;
    let mustResults = [];
    let vetoResults = [];
    for (const p of patterns) {
      const must = JSON.parse(p.mustConditionsJson || "[]");
      const veto = JSON.parse(p.vetoConditionsJson || "[]");
      const m = evaluateMust(must, a);
      const v = evaluateVeto(veto, a);
      mustResults = m.results;
      vetoResults = v.results;
      if (m.allPass && !v.anyVeto) { hit = p; break; }
    }
    if (hit) {
      results.push({
        alertId: a.id, matched: true, patternId: hit.id,
        decision: "SUGGEST_SUPPRESS",
        reasonJson: JSON.stringify({ systemVeto: [], mustResults, vetoResults }),
      });
      matched += 1; suppress += 1;
    } else {
      results.push({
        alertId: a.id, matched: false, patternId: "",
        decision: "KEEP_ALERT",
        reasonJson: JSON.stringify({ systemVeto: [], mustResults, vetoResults }),
      });
      keep += 1;
    }
  }
  return {
    scannedCount: alertRows.length, matchedCount: matched,
    suggestSuppressCount: suppress, keepAlertCount: keep, results,
  };
}

// Helpers

function modeOfExpected(memberIds, store) {
  const counts = new Map();
  for (const id of memberIds) {
    const row = store.one("SELECT expected_pattern FROM alerts WHERE id = ?", [id]);
    if (row && row.expected_pattern) {
      counts.set(row.expected_pattern, (counts.get(row.expected_pattern) || 0) + 1);
    }
  }
  let best = "", bestN = 0;
  for (const [k, v] of counts) if (v > bestN) { best = k; bestN = v; }
  return best;
}

function hashJson(obj) {
  const s = JSON.stringify(obj);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `h${h.toString(16)}`;
}
