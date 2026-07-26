// End-to-end verification script: runs the full demo pipeline against
// the OctoBus-hosted service via gRPC on localhost:9000.
import initSqlJs from "sql.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INSTANCE = "bi-prod";

// Connect directly to instance (bypasses capset routing)
const INSTANCE_PORT = await getInstancePort();
const ADDR = `127.0.0.1:${INSTANCE_PORT}`;
const CAPSET = "business-identification";
const TOKEN = "bi-capset-demo-token-0001";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const protoPath = path.join(__dirname, "..", "proto", "business_identification.proto");

async function getInstancePort() {
  const res = await fetch("http://127.0.0.1:9000/admin/v1/instances");
  const data = await res.json();
  const inst = data.instances?.find(i => i.ID === INSTANCE);
  if (!inst) throw new Error(`instance ${INSTANCE} not found`);
  return inst.ListenAddr?.split(":")[1] || "9000";
}

// Simple gRPC client using @grpc/grpc-js + @grpc/proto-loader
async function main() {
  const grpc = await import("@grpc/grpc-js");
  const loader = await import("@grpc/proto-loader");

  const pkgDef = loader.loadSync(protoPath, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
  const proto = grpc.loadPackageDefinition(pkgDef);
  const svc = proto.businessidentification.v1.BusinessIdentificationService;
  const client = new svc(ADDR, grpc.credentials.createInsecure());

  const call = (method, req) => new Promise((resolve, reject) => {
    client[method](req, (err, res) => err ? reject(err) : resolve(res));
  });

  function log(...args) { console.log(...args); }

  log("=== Step 1: DiscoverCandidates ===");
  try {
    const disc = await call("DiscoverCandidates", {
      tenant_id: "tenant-a",
      algorithm: "EXACT_GROUP",
    });
    log(`  runId: ${disc.run_id}, groups: ${disc.group_count}, candidates: ${disc.candidate_count}`);
    log(`  candidateIds: ${JSON.stringify(disc.candidate_ids)}`);
    if (disc.candidate_count === 0) { log("  FAIL: no candidates found"); return; }
  } catch (e) { log("  ERROR:", e.message); return; }

  log("\n=== Step 2: ListCandidates ===");
  const list = await call("ListCandidates", { tenant_id: "tenant-a" });
  const candidates = list.candidates.filter(c => c.status === "CANDIDATE");
  log(`  total: ${list.candidates.length}, CANDIDATE: ${candidates.length}`);
  const cand = candidates[0];
  log(`  first: ${cand.id} type=${cand.candidate_type} alerts=${cand.alert_count}`);

  log("\n=== Step 3: GetCandidateContext ===");
  const ctx = await call("GetCandidateContext", { candidate_id: cand.id });
  log(`  candidateId: ${ctx.candidate_id}`);
  log(`  rep samples: ${ctx.representative_samples.length}, boundary: ${ctx.boundary_samples.length}, risk: ${ctx.risk_samples.length}`);

  log("\n=== Step 4: SaveCandidateAnalysis ===");
  const analysisRes = await call("SaveCandidateAnalysis", {
    candidate_id: cand.id,
    business_name: "订单支付状态查询",
    business_summary: "订单服务周期性查询订单支付状态形成的稳定业务行为。请求集中在 order-service，方法主要为 GET，URL 模式稳定，连续多天出现，响应主要为 2xx。",
    evidence: ["请求集中在 order-service", "方法主要为 GET", "URL 模式稳定", "连续多天出现", "响应主要为 2xx"],
    must_conditions: [
      { field: "service_key", operator: "eq", value_json: JSON.stringify("order-service") },
      { field: "http_method", operator: "eq", value_json: JSON.stringify("GET") },
      { field: "url_pattern", operator: "eq", value_json: JSON.stringify("/api/orders/{num}/payment-status") },
    ],
    veto_conditions: [
      { field: "is_confirmed_attack", operator: "eq", value_json: JSON.stringify(true) },
      { field: "has_path_traversal", operator: "eq", value_json: JSON.stringify(true) },
    ],
    confidence: 0.92,
    risk_level: "LOW",
    uncertainties: [],
  });
  log(`  accepted: ${analysisRes.accepted}, analysisId: ${analysisRes.analysis_id}`);
  if (!analysisRes.accepted) { log("  FAIL:", analysisRes.validation_errors); return; }

  log("\n=== Step 5: RunReplay ===");
  const replay = await call("RunReplay", {
    candidate_id: cand.id,
    analysis_id: analysisRes.analysis_id,
  });
  log(`  passed: ${replay.passed}`);
  log(`  scanned: ${replay.scanned_count}, matched: ${replay.pattern_matched_count}`);
  log(`  suppress: ${replay.suppression_suggested_count}, riskVetoed: ${replay.risk_vetoed_count}`);
  log(`  precision: ${replay.precision}, recall: ${replay.recall}`);
  if (!replay.passed) { log("  FAIL: replay did not pass"); return; }

  log("\n=== Step 6: PublishPattern ===");
  const pub = await call("PublishPattern", {
    candidate_id: cand.id,
    analysis_id: analysisRes.analysis_id,
    replay_id: replay.replay_id,
    approved_by: "demo-operator",
    approved_comment: "回放通过，降噪效果显著，批准发布",
  });
  log(`  published: ${pub.published}, patternId: ${pub.pattern_id}`);
  if (!pub.published) { log("  FAIL:", pub.errors); return; }

  log("\n=== Step 7: MatchIncomingAlerts ===");
  const match = await call("MatchIncomingAlerts", { tenant_id: "tenant-a" });
  log(`  scanned: ${match.scanned_count}, matched: ${match.matched_count}`);
  log(`  suggest_suppress: ${match.suggest_suppress_count}, keep_alert: ${match.keep_alert_count}`);
  const suppressed = match.results.filter(r => r.decision === "SUGGEST_SUPPRESS").length;
  const kept = match.results.filter(r => r.decision === "KEEP_ALERT").length;
  log(`  SUP SUGGEST: ${suppressed}, KEEP_ALERT: ${kept}`);

  if (suppressed > 0) {
    const sample = match.results.find(r => r.decision === "SUGGEST_SUPPRESS");
    log(`  sample suppress: ${JSON.stringify(sample).slice(0, 200)}`);
  }
  if (kept > 0) {
    const sample = match.results.find(r => r.decision === "KEEP_ALERT");
    log(`  sample keep: ${JSON.stringify(sample).slice(0, 300)}`);
  }

  log("\n=== RESULT: PASS ===");
  client.close();
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
