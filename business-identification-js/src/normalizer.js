// URL normalization and alert profile derivation (MVP spec section 12).
// Deterministic, no model/LLM involvement.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{12,}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,}$/;

function normalizeSegment(seg) {
  if (seg === "") return seg;
  if (/^\d+$/.test(seg)) return "{num}";
  if (UUID_RE.test(seg)) return "{uuid}";
  if (HEX_RE.test(seg) || TOKEN_RE.test(seg)) return "{hash}";
  // static asset version hash like app.a83f91c2.js -> app.{hash}.js
  const assetMatch = seg.match(/^([^.]+)\.([0-9a-f]{8,})\.(js|css|png|jpg|jpeg|woff2?|svg|gif|webp)$/i);
  if (assetMatch) return `${assetMatch[1]}.{hash}.${assetMatch[3].toLowerCase()}`;
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(seg) || /^\d{8}$/.test(seg)) return "{date}";
  return seg;
}

export function normalizeUrl(rawUrl) {
  let url = (rawUrl || "").trim();
  let queryString = "";
  const qIdx = url.indexOf("?");
  if (qIdx >= 0) {
    queryString = url.slice(qIdx + 1);
    url = url.slice(0, qIdx);
  }
  let pathPart = url;
  const protoIdx = url.indexOf("://");
  if (protoIdx >= 0) {
    const rest = url.slice(protoIdx + 3);
    const slash = rest.indexOf("/");
    pathPart = slash >= 0 ? rest.slice(slash) : "/";
  }

  const segments = pathPart.split("/").map((s) => decodeURIComponent(s));
  const normalizedSegments = segments.map(normalizeSegment);
  const urlPattern = normalizedSegments.join("/");

  let queryPattern = "";
  if (queryString) {
    const params = queryString
      .split("&")
      .map((p) => p.split("=")[0])
      .filter(Boolean)
      .sort();
    if (params.length) queryPattern = "?" + params.map((k) => `${k}={value}`).join("&");
  }

  const lastSeg = segments[segments.length - 1] || "";
  const dotIdx = lastSeg.lastIndexOf(".");
  const ext = dotIdx >= 0 ? lastSeg.slice(dotIdx + 1).toLowerCase() : "";

  return {
    urlPattern: urlPattern + queryPattern,
    urlFirstDir: segments[1] || "",
    extension: ext,
    extensionCategory: extensionCategory(ext),
  };
}

export function extensionCategory(ext) {
  const map = {
    js: "static_resource",
    mjs: "static_resource",
    css: "static_resource",
    png: "static_resource",
    jpg: "static_resource",
    jpeg: "static_resource",
    gif: "static_resource",
    svg: "static_resource",
    webp: "static_resource",
    woff: "static_resource",
    woff2: "static_resource",
    ttf: "static_resource",
    html: "page",
    htm: "page",
    php: "dynamic_script",
    jsp: "dynamic_script",
    asp: "dynamic_script",
    aspx: "dynamic_script",
    exe: "dangerous_executable",
    sh: "dangerous_script",
    bat: "dangerous_script",
    zip: "archive",
    pdf: "document",
    json: "api_response",
    xml: "api_response",
  };
  return map[ext] || (ext ? "other" : "none");
}

export function responseStatusClass(status) {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500) return "5xx";
  return "unknown";
}

// Build a normalized profile from a raw alert row, adding derived fields.
export function buildProfile(raw) {
  const norm = normalizeUrl(raw.url || "");
  const status = Number(raw.response_status || 0);
  return {
    id: raw.id,
    tenantId: raw.tenant_id || raw.tenantId || "tenant-a",
    ruleId: raw.rule_id || raw.ruleId || "",
    ruleCategory: raw.rule_category || raw.ruleCategory || "",
    serviceKey: raw.service_key || raw.serviceKey || "",
    protocol: raw.protocol || "HTTP",
    sourceIp: raw.source_ip || raw.sourceIp || "",
    sourceSegment: raw.source_segment || raw.sourceSegment || "",
    sourceReputation: raw.source_reputation || raw.sourceReputation || "normal",
    sourceIsInternal: Boolean(raw.source_is_internal ?? raw.sourceIsInternal ?? false),
    httpMethod: (raw.http_method || raw.httpMethod || "GET").toUpperCase(),
    url: raw.url || "",
    urlPath: raw.url_path || raw.urlPath || raw.url || "",
    urlPattern: norm.urlPattern,
    urlFirstDir: norm.urlFirstDir,
    extensionCategory: norm.extensionCategory,
    requestBodyType: raw.request_body_type || raw.requestBodyType || "empty",
    responseStatus: status,
    responseStatusClass: responseStatusClass(status),
    responseContentType: raw.response_content_type || raw.responseContentType || "",
    riskLevel: raw.risk_level || raw.riskLevel || "LOW",
    isConfirmedAttack: Boolean(raw.is_confirmed_attack ?? raw.isConfirmedAttack ?? false),
    hasPathTraversal: Boolean(raw.has_path_traversal ?? raw.hasPathTraversal ?? false),
    hasDangerousExtension: Boolean(raw.has_dangerous_extension ?? raw.hasDangerousExtension ?? false),
    extractionFailed: Boolean(raw.extraction_failed ?? raw.extractionFailed ?? false),
    expectedPattern: raw.expected_pattern || raw.expectedPattern || "",
    occurredAt: raw.occurred_at || raw.occurredAt || new Date().toISOString(),
  };
}
