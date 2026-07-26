// Deterministic demo alert generator. Produces three time-window-isolated
// batches (training / testing / live) covering the MVP sample taxonomy.
// Windows are computed dynamically relative to current time.

const MS_HOUR = 3600_000;
const MS_DAY = 86_400_000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildWindows(now = Date.now()) {
  const end = (d) => new Date(d).toISOString();
  // training: 24h ago → now (recent data for discovery)
  // testing:  48h ago → 24h ago (labeled verification set for replay)
  return {
    training: [end(now - 24 * MS_HOUR), end(now)],
    testing: [end(now - 48 * MS_HOUR), end(now - 24 * MS_HOUR)],
    live: [end(now), end(now + MS_HOUR)],
  };
}

const SEGMENTS = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"];

function tsIn(window, rng) {
  const [s, e] = window;
  const start = Date.parse(s);
  const end = Date.parse(e);
  return new Date(start + Math.floor(rng() * (end - start))).toISOString();
}

function ipIn(seg, rng) {
  const base = seg.split("/")[0].split(".").slice(0, 3).join(".");
  return `${base}.${1 + Math.floor(rng() * 254)}`;
}

let counter = 0;
let idPrefix = "alert-";
function nextId() {
  counter += 1;
  return `${idPrefix}${String(counter).padStart(5, "0")}`;
}

function setIdPrefix(prefix) { idPrefix = prefix; counter = 0; }

function normalAlert(window, rng) {
  const num = 10000 + Math.floor(rng() * 90000);
  const status = rng() < 0.85 ? 200 : 304;
  const seg = SEGMENTS[Math.floor(rng() * SEGMENTS.length)];
  return {
    raw: {
      id: nextId(),
      tenant_id: "tenant-a",
      rule_id: "RULE_ORDER",
      rule_category: "business_api",
      service_key: "order-service",
      protocol: "HTTP",
      source_ip: ipIn(seg, rng),
      source_segment: seg,
      source_reputation: "normal",
      source_is_internal: true,
      http_method: "GET",
      url: `/api/orders/${num}/payment-status`,
      request_body_type: "empty",
      response_status: status,
      response_content_type: "application/json",
      risk_level: "LOW",
      is_confirmed_attack: false,
      has_path_traversal: false,
      has_dangerous_extension: false,
      extraction_failed: false,
      expected_pattern: "order-payment-status",
      occurred_at: tsIn(window, rng),
    },
    kind: "normal",
  };
}

function boundaryAlert(window, rng) {
  const num = 10000 + Math.floor(rng() * 90000);
  const status = rng() < 0.5 ? 200 : 503;
  const seg = SEGMENTS[Math.floor(rng() * SEGMENTS.length)];
  return {
    raw: {
      id: nextId(),
      tenant_id: "tenant-a",
      rule_id: "RULE_ORDER",
      rule_category: "business_api",
      service_key: "order-service",
      protocol: "HTTP",
      source_ip: ipIn(seg, rng),
      source_segment: seg,
      source_reputation: "normal",
      source_is_internal: true,
      http_method: "POST",
      url: `/api/orders/${num}/payment-status`,
      request_body_type: "json",
      response_status: status,
      response_content_type: "application/json",
      risk_level: "LOW",
      is_confirmed_attack: false,
      has_path_traversal: false,
      has_dangerous_extension: false,
      extraction_failed: false,
      expected_pattern: "",
      occurred_at: tsIn(window, rng),
    },
    kind: "boundary",
  };
}

const RISK_TEMPLATES = [
  (rng) => ({ is_confirmed_attack: true, risk_level: "HIGH", url: "/api/admin/export", http_method: "GET" }),
  (rng) => ({ source_reputation: "malicious", risk_level: "MEDIUM", url: "/api/data", http_method: "GET" }),
  (rng) => ({ has_path_traversal: true, risk_level: "HIGH", url: "/static/../../etc/passwd", http_method: "GET" }),
  (rng) => ({ has_dangerous_extension: true, risk_level: "HIGH", url: "/uploads/shell.php", http_method: "GET" }),
  (rng) => ({ risk_level: "HIGH", url: "/api/debug", http_method: "GET" }),
  (rng) => ({ extraction_failed: true, risk_level: "LOW", url: "/weird/binary", http_method: "GET" }),
];

function riskAlert(window, rng) {
  const tpl = RISK_TEMPLATES[Math.floor(rng() * RISK_TEMPLATES.length)](rng);
  const seg = SEGMENTS[Math.floor(rng() * SEGMENTS.length)];
  return {
    raw: {
      id: nextId(),
      tenant_id: "tenant-a",
      rule_id: "RULE_EXPLOIT",
      rule_category: "exploit",
      service_key: "external-edge",
      protocol: "HTTP",
      source_ip: ipIn(seg, rng),
      source_segment: seg,
      source_reputation: tpl.source_reputation || "normal",
      source_is_internal: false,
      http_method: tpl.http_method,
      url: tpl.url,
      request_body_type: "empty",
      response_status: 200,
      response_content_type: "text/plain",
      risk_level: tpl.risk_level,
      is_confirmed_attack: !!tpl.is_confirmed_attack,
      has_path_traversal: !!tpl.has_path_traversal,
      has_dangerous_extension: !!tpl.has_dangerous_extension,
      extraction_failed: !!tpl.extraction_failed,
      expected_pattern: "",
      occurred_at: tsIn(window, rng),
    },
    kind: "risk",
  };
}

// Generate alerts with dynamic windows. Called by the service at startup.
// Returns { results, windows } where results is [{ raw, kind }].
export function generateDemoAlerts(seed = Date.now(), opts = {}) {
  setIdPrefix("alert-");
  const normalCount = opts.normalCount || 1000;
  const boundaryCount = Math.max(5, Math.floor(normalCount * 0.05));
  const riskCount = Math.max(5, Math.floor(normalCount * 0.06));
  const rng = mulberry32(seed);
  const windows = buildWindows();
  const out = [];
  const plan = [
    [windows.training, "normal", normalCount],
    [windows.training, "boundary", boundaryCount],
    [windows.training, "risk", riskCount],
  ];
  for (const [w, kind, n] of plan) {
    for (let i = 0; i < n; i++) {
      if (kind === "normal") out.push(normalAlert(w, rng));
      else if (kind === "boundary") out.push(boundaryAlert(w, rng));
      else out.push(riskAlert(w, rng));
    }
  }
  return { results: out, windows };
}

// Generate a static labeled verification set (one-time, not regenerated).
// Timestamps are set to a fixed point to avoid time-window dependency.
export function generateVerificationSet(seed = Date.now()) {
  const prev = idPrefix;
  setIdPrefix("verif-");
  const rng = mulberry32(seed);
  const out = [];
  const base = Date.now() - 48 * MS_HOUR;
  const plan = [["normal", 210], ["boundary", 12], ["risk", 16]];
  for (const [kind, n] of plan) {
    for (let i = 0; i < n; i++) {
      const ts = new Date(base + Math.floor(rng() * 12 * MS_HOUR)).toISOString();
      const w = [ts, ts];
      if (kind === "normal") out.push(normalAlert(w, rng));
      else if (kind === "boundary") out.push(boundaryAlert(w, rng));
      else out.push(riskAlert(w, rng));
    }
  }
  return out;
}

// Legacy: fixed-window export for ResetDemo backward compatibility.
export const DEMO_WINDOWS = (() => {
  const w = buildWindows();
  // Provide training window as defaults; handler code still uses these keys.
  w.tenantId = "tenant-a";
  return w;
})();
