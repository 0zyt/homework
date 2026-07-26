#!/usr/bin/env node
/*
 * 端到端验证：直接驱动运行中的 OctoBus 守护进程，走完业务识别闭环的 8 个 RPC。
 * 传输层使用 OctoBus 的 Connect RPC（HTTP/JSON），路径：
 *   POST /capsets/<capset>/connect/<instance>/<service>/<method>
 * 鉴权：Authorization: Bearer <capset_token>
 *
 * 这与 agent-compose 经 remote MCP server 调用的是同一后端（gRPC -> Service Handler）。
 */

const BASE = (process.env.OCTOBUS_ADDR || "http://127.0.0.1:9000").replace(/\/+$/, "");
const CAPSET = process.env.CAPSET_ID || "business-identification";
const INSTANCE = process.env.INSTANCE_ID || "bi-prod";
const TOKEN = process.env.OCTOBUS_BI_CAPSET_TOKEN || "bi-capset-demo-token-0001";
const SVC = "businessidentification.v1.BusinessIdentificationService";

const TENANT = "tenant-a";

async function call(method, body) {
  const url = `${BASE}/capsets/${CAPSET}/connect/${INSTANCE}/${SVC}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`[${method}] HTTP ${res.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`[${method}] 非 JSON 响应: ${text}`);
  }
}

function assert(cond, msg) {
  if (!cond) {
    console.error("  ✗ " + msg);
    throw new Error("断言失败: " + msg);
  }
  console.log("  ✓ " + msg);
}

const main = async () => {
  console.log("== [1] ResetDemo ==");
  const reset = await call("ResetDemo", { tenantId: TENANT });
  console.log("   imported:", reset.importedCount, "discovery:", reset.discoveryWindowStart, "->", reset.discoveryWindowEnd);
  assert(Number(reset.importedCount) > 0, "导入演示数据 > 0");

  console.log("== [2] DiscoverCandidates ==");
  const disc = await call("DiscoverCandidates", {
    tenantId: TENANT,
    algorithm: "EXACT_GROUP",
    discoveryStart: reset.discoveryWindowStart,
    discoveryEnd: reset.discoveryWindowEnd,
  });
  console.log("   run:", disc.runId, "groups:", disc.groupCount, "candidates:", disc.candidateCount, "ids:", disc.candidateIds);
  assert(Number(disc.candidateCount) >= 1, "发现至少 1 个候选");

  console.log("== [3] ListCandidates ==");
  const list = await call("ListCandidates", { tenantId: TENANT });
  const candidate = (list.candidates || []).find((c) => c.status === "CANDIDATE") || list.candidates[0];
  assert(!!candidate, "存在候选对象");
  console.log("   chosen:", candidate.id, candidate.candidateType, candidate.status, "alerts:", candidate.alertCount);

  console.log("== [4] GetCandidateContext ==");
  const ctx = await call("GetCandidateContext", { candidateId: candidate.id });
  console.log("   rep:", (ctx.representativeSamples || []).length, "boundary:", (ctx.boundarySamples || []).length, "risk:", (ctx.riskSamples || []).length);

  console.log("== [5] SaveCandidateAnalysis (valid) ==");
  const analysis = await call("SaveCandidateAnalysis", {
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
  });
  console.log("   accepted:", analysis.accepted, "analysisId:", analysis.analysisId, "errors:", analysis.validationErrors);
  // 注意：accepted=true 为非默认值，protobuf JSON 会保留；accepted=false 会被省略（默认零值），故用 !== true 判断。
  assert(analysis.accepted === true, "有效分析被接受");

  console.log("== [5b] SaveCandidateAnalysis (invalid rejected) ==");
  const bad = await call("SaveCandidateAnalysis", {
    candidateId: candidate.id,
    businessName: "x",
    mustConditions: [{ field: "not_a_field", operator: "eq", valueJson: JSON.stringify("y") }],
  });
  console.log("   accepted:", bad.accepted, "errors:", bad.validationErrors);
  assert(bad.accepted !== true, "非法字段的分析被拒（accepted 非 true）");

  console.log("== [6] RunReplay ==");
  const replay = await call("RunReplay", {
    candidateId: candidate.id,
    analysisId: analysis.analysisId,
    replayStart: reset.replayWindowStart,
    replayEnd: reset.replayWindowEnd,
  });
  console.log("   passed:", replay.passed, "matched:", replay.patternMatchedCount, "suppress:", replay.suppressionSuggestedCount, "riskVetoed:", replay.riskVetoedCount, "precision:", replay.precision, "recall:", replay.recall);
  assert(replay.passed === true, "回放通过");

  console.log("== [7] PublishPattern ==");
  const pub = await call("PublishPattern", {
    candidateId: candidate.id,
    analysisId: analysis.analysisId,
    replayId: replay.replayId,
    approvedBy: "demo-audit",
  });
  console.log("   published:", pub.published, "patternId:", pub.patternId, "errors:", pub.errors);
  assert(pub.published === true, "模式发布成功");

  console.log("== [8] MatchIncomingAlerts ==");
  const match = await call("MatchIncomingAlerts", { tenantId: TENANT });
  const suppressed = (match.results || []).filter((r) => r.decision === "SUGGEST_SUPPRESS").length;
  const kept = (match.results || []).filter((r) => r.decision === "KEEP_ALERT").length;
  const riskKept = (match.results || []).filter(
    (r) => r.decision === "KEEP_ALERT" && JSON.parse(r.reasonJson || "{}").systemVeto?.length > 0
  ).length;
  console.log("   scanned:", match.scannedCount, "suppress:", suppressed, "keep:", kept, "riskKept:", riskKept);
  assert(suppressed > 0, "存在建议抑制项");
  assert(riskKept > 0, "存在因系统否决强制保留的高危项");

  console.log("\nRESULT: PASS");
};

main().catch((e) => {
  console.error("\nRESULT: FAIL");
  console.error(e.message);
  process.exit(1);
});
