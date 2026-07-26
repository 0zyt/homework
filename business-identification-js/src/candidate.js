// Candidate discovery: MVP-0 exact grouping + MVP-1 similarity clustering.
// Queries alerts from SQLite and persists candidates via SQL.
import { getStore } from "./store.js";

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

function exactGroupKey(p) {
  return [
    p.tenantId, p.ruleId, p.serviceKey, p.protocol, p.httpMethod,
    p.urlPattern, p.requestBodyType, p.responseStatusClass,
  ].join("|");
}

function dayOf(iso) {
  return (iso || "").slice(0, 10);
}

function computeStats(members) {
  const days = new Set();
  const sources = new Set();
  let success = 0, confirmedAttack = 0, malicious = 0, extractionFail = 0;
  for (const m of members) {
    days.add(dayOf(m.occurredAt));
    if (m.sourceSegment) sources.add(m.sourceSegment);
    if (["2xx", "3xx"].includes(m.responseStatusClass)) success += 1;
    if (m.isConfirmedAttack) confirmedAttack += 1;
    if (m.sourceReputation === "malicious") malicious += 1;
    if (m.extractionFailed) extractionFail += 1;
  }
  return {
    alertCount: members.length,
    activeDays: days.size,
    sourceCount: sources.size,
    successRate: members.length ? success / members.length : 0,
    confirmedAttackCount: confirmedAttack,
    maliciousSourceCount: malicious,
    extractionFailureCount: extractionFail,
  };
}

function passesRiskFilter(stats) {
  return (
    stats.confirmedAttackCount === 0 &&
    stats.maliciousSourceCount === 0 &&
    stats.extractionFailureCount === 0
  );
}

function passesPolicy(stats, policy) {
  return (
    stats.alertCount >= policy.minAlertCount &&
    stats.activeDays >= policy.minActiveDays &&
    stats.sourceCount >= policy.minSourceCount &&
    stats.successRate >= policy.minSuccessRate
  );
}

function defaultPolicy(req) {
  return {
    minAlertCount: req.minAlertCount && req.minAlertCount > 0 ? req.minAlertCount : 50,
    minActiveDays: req.minActiveDays && req.minActiveDays > 0 ? req.minActiveDays : 2,
    minSourceCount: req.minSourceCount && req.minSourceCount > 0 ? req.minSourceCount : 2,
    minSuccessRate: typeof req.minSuccessRate === "number" && req.minSuccessRate > 0 ? req.minSuccessRate : 0.7,
  };
}

function inWindow(iso, start, end) {
  if (start && iso < start) return false;
  if (end && iso > end) return false;
  return true;
}

function insertCandidate(store, runId, type, keyFields, members, stats) {
  const id = store.nextId("candidate");
  const now = new Date().toISOString();
  const discStart = members.map((m) => m.occurredAt).sort()[0];
  const discEnd = members.map((m) => m.occurredAt).sort().reverse()[0];
  const status = passesRiskFilter(stats)
    ? (passesPolicy(stats, defaultPolicy({})) ? "CANDIDATE" : "BELOW_THRESHOLD")
    : "REJECTED_BY_RISK";

  store.db.run(`INSERT INTO pattern_candidates(
    id,run_id,tenant_id,discovery_time_start,discovery_time_end,
    candidate_type,status,version,alert_count,active_days,source_count,
    success_rate,common_features_json,statistics_json,risk_summary_json,
    member_alert_ids_json,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?)`, [
    id, runId, members[0].tenantId, discStart, discEnd,
    type, status,
    stats.alertCount, stats.activeDays, stats.sourceCount,
    stats.successRate,
    JSON.stringify(keyFields),
    JSON.stringify(stats),
    JSON.stringify({
      confirmedAttackCount: stats.confirmedAttackCount,
      maliciousSourceCount: stats.maliciousSourceCount,
      extractionFailureCount: stats.extractionFailureCount,
    }),
    JSON.stringify(members.map((m) => m.id)),
    now, now,
  ]);
  return { id, status };
}

export function discoverCandidates(ctx, req) {
  const store = getStore(ctx);
  const tenantId = req.tenantId || "tenant-a";
  const policy = defaultPolicy(req);
  const algorithm = (req.algorithm || "EXACT_GROUP").toUpperCase();

  // Query alerts from SQLite for the training window.
  let alertRows;
  // Default: training window (24h-now), non-overlapping with labeled testing data
  const discStart = req.discoveryStart || new Date(Date.now() - 86400000).toISOString();
  const discEnd = req.discoveryEnd || new Date().toISOString();
  alertRows = store.all(
    "SELECT * FROM alerts WHERE tenant_id = ? AND occurred_at >= ? AND occurred_at <= ?",
    [tenantId, discStart, discEnd]
  );
  const alerts = alertRows.map(toCamel);

  const runId = store.nextId("run");

  // Group by exact key
  const groups = new Map();
  for (const a of alerts) {
    const key = exactGroupKey(a);
    if (!groups.has(key)) {
      const parts = key.split("|");
      groups.set(key, {
        keyFields: {
          tenantId: parts[0], ruleId: parts[1], serviceKey: parts[2], protocol: parts[3],
          httpMethod: parts[4], urlPattern: parts[5], requestBodyType: parts[6], responseStatusClass: parts[7],
        },
        members: [],
      });
    }
    groups.get(key).members.push(a);
  }

  let candidateIds = [];
  if (algorithm === "SIMILARITY") {
    candidateIds = clusterSimilarity(store, runId, groups, policy);
  } else {
    for (const g of groups.values()) {
      const stats = computeStats(g.members);
      const c = insertCandidate(store, runId, "EXACT_GROUP", g.keyFields, g.members, stats);
      if (c.status === "CANDIDATE") candidateIds.push(c.id);
    }
  }

  store.save();
  return {
    runId, algorithm,
    scannedCount: alerts.length,
    groupCount: groups.size,
    candidateCount: candidateIds.length,
    candidateIds,
  };
}

// MVP-1: conservative similarity clustering.
function clusterSimilarity(store, runId, groups, policy) {
  const buckets = new Map();
  for (const g of groups.values()) {
    const stats = computeStats(g.members);
    if (!passesRiskFilter(stats)) continue;
    const kf = g.keyFields;
    const bucketKey = `${kf.tenantId}|${kf.ruleId}|${kf.serviceKey}|${kf.protocol}`;
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
    buckets.get(bucketKey).push({ keyFields: kf, members: g.members, stats });
  }

  const ids = [];
  const THRESHOLD = 0.78;
  for (const list of buckets.values()) {
    const clusters = [];
    for (const g of list) {
      let merged = false;
      for (const c of clusters) {
        const rep = c.reps[0];
        const score = prefixSimilarity(rep.urlPattern, g.keyFields.urlPattern);
        if (
          rep.urlFirstDirShare === firstDir(g.keyFields.urlPattern) &&
          rep.httpMethod === g.keyFields.httpMethod &&
          score >= THRESHOLD
        ) {
          c.members.push(...g.members);
          c.reps.push(g.keyFields);
          merged = true;
          break;
        }
      }
      if (!merged) {
        clusters.push({
          members: [...g.members],
          reps: [g.keyFields],
          urlFirstDirShare: firstDir(g.keyFields.urlPattern),
          httpMethod: g.keyFields.httpMethod,
        });
      }
    }
    for (const c of clusters) {
      const stats = computeStats(c.members);
      const keyFields = {
        tenantId: c.reps[0].tenantId,
        ruleId: c.reps[0].ruleId,
        serviceKey: c.reps[0].serviceKey,
        protocol: c.reps[0].protocol,
        httpMethod: c.reps[0].httpMethod,
        urlPattern: `<cluster:${c.reps.map((r) => r.urlPattern).join("|")}>`,
        requestBodyType: c.reps[0].requestBodyType,
        responseStatusClass: c.reps[0].responseStatusClass,
      };
      const cand = insertCandidate(store, runId, "SIMILARITY_CLUSTER", keyFields, c.members, stats);
      if (cand.status === "CANDIDATE") ids.push(cand.id);
    }
  }
  return ids;
}

function firstDir(urlPattern) {
  const segs = urlPattern.split("/");
  return segs[1] || "";
}

function prefixSimilarity(a, b) {
  const sa = a.split("/").filter(Boolean);
  const sb = b.split("/").filter(Boolean);
  let common = 0;
  const n = Math.min(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    if (sa[i] === sb[i]) common += 1;
    else break;
  }
  return n ? common / n : 0;
}
