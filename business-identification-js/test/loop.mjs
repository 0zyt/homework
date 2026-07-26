import os from "node:os";
import path from "node:path";
import * as handlers from "../src/handlers.js";

const ctx = { workdir: path.join(os.tmpdir(), "bi-test-" + Date.now()), config: {}, request: {} };

function log(...a) { console.log(...a); }

// 1. Reset
const reset = handlers.resetDemo(ctx);
log("[1] ResetDemo -> imported:", reset.importedCount, "windows:", reset.trainingWindowStart, "->", reset.liveWindowEnd);

// 2. Discover
const disc = handlers.discoverCandidatesHandler({ ...ctx, request: { tenantId: "tenant-a", algorithm: "EXACT_GROUP", discoveryStart: reset.trainingWindowStart, discoveryEnd: reset.trainingWindowEnd } });
log("[2] Discover -> run:", disc.runId, "groups:", disc.groupCount, "candidates:", disc.candidateCount, "ids:", disc.candidateIds);

// 3. List
const list = handlers.listCandidates({ ...ctx, request: { tenantId: "tenant-a" } });
const candidate = list.candidates.find((c) => c.status === "CANDIDATE") || list.candidates[0];
log("[3] List ->", list.candidates.length, "candidates; chosen:", candidate.id, candidate.candidateType, candidate.status, "alerts:", candidate.alertCount);

// 4. Context
const ctxt = handlers.getCandidateContext({ ...ctx, request: { candidateId: candidate.id } });
log("[4] Context -> rep:", ctxt.representativeSamples.length, "boundary:", ctxt.boundarySamples.length, "risk:", ctxt.riskSamples.length);

// 5. Save analysis (valid)
const analysis = handlers.saveCandidateAnalysis({
  ...ctx,
  request: {
    candidateId: candidate.id,
    businessName: "订单支付状态查询",
    businessSummary: "订单服务周期性查询订单支付状态形成的稳定业务行为。",
    evidence: ["请求集中在 order-service", "方法主要为 GET", "URL 模式稳定", "连续多天出现", "响应主要为 2xx"],
    mustConditions: [
      { field: "service_key", operator: "eq", valueJson: JSON.stringify("order-service") },
      { field: "http_method", operator: "eq", valueJson: JSON.stringify("GET") },
      { field: "url_pattern", operator: "eq", valueJson: JSON.stringify("/api/orders/{num}/payment-status") },
    ],
    vetoConditions: [
      { field: "is_confirmed_attack", operator: "eq", valueJson: JSON.stringify(true) },
      { field: "has_path_traversal", operator: "eq", valueJson: JSON.stringify(true) },
    ],
    confidence: 0.92,
    riskLevel: "LOW",
    uncertainties: [],
  },
});
log("[5] SaveAnalysis -> accepted:", analysis.accepted, "analysisId:", analysis.analysisId, "errors:", analysis.validationErrors);

// 5b. Invalid analysis rejected
const bad = handlers.saveCandidateAnalysis({
  ...ctx,
  request: { candidateId: candidate.id, businessName: "x", mustConditions: [{ field: "not_a_field", operator: "eq", valueJson: JSON.stringify("y") }] },
});
log("[5b] Invalid analysis rejected:", !bad.accepted, "errors:", bad.validationErrors);

// 6. Replay
const replay = handlers.runReplay({ ...ctx, request: { candidateId: candidate.id, analysisId: analysis.analysisId } });
log("[6] Replay -> passed:", replay.passed, "matched:", replay.patternMatchedCount, "suppress:", replay.suppressionSuggestedCount, "riskVetoed:", replay.riskVetoedCount, "precision:", replay.precision, "recall:", replay.recall);

// 7. Publish
const pub = handlers.publishPattern({ ...ctx, request: { candidateId: candidate.id, analysisId: analysis.analysisId, replayId: replay.replayId, approvedBy: "demo-audit" } });
log("[7] Publish -> published:", pub.published, "patternId:", pub.patternId, "errors:", pub.errors);

// 8. Match incoming (use testing window for verification)
const match = handlers.matchIncomingAlerts({ ...ctx, request: {
  tenantId: "tenant-a",
  incomingStart: reset.testingWindowStart,
  incomingEnd: reset.testingWindowEnd,
} });
const suppressed = match.results.filter((r) => r.decision === "SUGGEST_SUPPRESS").length;
const kept = match.results.filter((r) => r.decision === "KEEP_ALERT").length;
const riskKept = match.results.filter((r) => r.decision === "KEEP_ALERT" && JSON.parse(r.reasonJson).systemVeto.length > 0).length;
log("[8] Match -> scanned:", match.scannedCount, "suppress:", suppressed, "keep:", kept, "riskKept:", riskKept);

log("\nRESULT:", reset.importedCount > 0 && disc.candidateCount >= 1 && analysis.accepted && replay.passed && pub.published && suppressed > 0 && riskKept > 0 ? "PASS" : "FAIL");
