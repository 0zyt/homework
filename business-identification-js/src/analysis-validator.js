// Validate the agent's structured analysis before it can enter replay/publish.
// Enforces the field & operator whitelist, type checks and condition limits
// from MVP spec section 17.

const FIELD_TYPES = {
  tenant_id: "string", rule_id: "string", rule_category: "string",
  service_key: "string", protocol: "string", http_method: "string", url_pattern: "string",
  url_first_dir: "string", extension_category: "string", request_body_type: "string",
  response_status: "number", response_status_class: "string", response_content_type: "string",
  source_segment: "string", source_is_internal: "boolean", source_reputation: "string",
  risk_level: "string", is_confirmed_attack: "boolean", has_path_traversal: "boolean",
  has_dangerous_extension: "boolean", extraction_failed: "boolean",
};

const OPERATORS = ["eq", "neq", "in", "not_in", "contains", "not_contains", "starts_with"];
const MAX_CONDITIONS = 20;

function parseValue(valueJson) {
  if (typeof valueJson === "string") {
    try {
      return JSON.parse(valueJson);
    } catch {
      return valueJson;
    }
  }
  return valueJson;
}

function validateCondition(cond, errors) {
  if (!cond || typeof cond !== "object") {
    errors.push("condition must be an object");
    return;
  }
  const field = cond.field;
  const op = (cond.operator || "").toLowerCase();
  if (!(field in FIELD_TYPES)) errors.push(`field not allowed: ${field}`);
  if (!OPERATORS.includes(op)) errors.push(`operator not allowed: ${cond.operator}`);

  const expected = parseValue(cond.valueJson);
  const type = FIELD_TYPES[field];
  if (type === "boolean") {
    const arr = Array.isArray(expected) ? expected : [expected];
    if (!arr.every((v) => typeof v === "boolean")) errors.push(`field ${field} expects boolean value`);
  } else if (type === "number") {
    const arr = Array.isArray(expected) ? expected : [expected];
    if (!arr.every((v) => typeof v === "number")) errors.push(`field ${field} expects number value`);
  } else if (["contains", "not_contains", "starts_with"].includes(op)) {
    if (typeof expected !== "string") errors.push(`operator ${op} requires string value for ${field}`);
  }
}

export function validateAnalysis(analysis, candidateExists) {
  const errors = [];
  if (!candidateExists) errors.push("candidate_id does not exist");
  if (!analysis.businessName || !String(analysis.businessName).trim()) {
    errors.push("business_name is required");
  }
  const must = analysis.mustConditions || [];
  const veto = analysis.vetoConditions || [];
  if (!Array.isArray(must) || must.length === 0) errors.push("must_conditions must be a non-empty array");
  if (must.length > MAX_CONDITIONS) errors.push(`too many must_conditions (max ${MAX_CONDITIONS})`);
  if (veto.length > MAX_CONDITIONS) errors.push(`too many veto_conditions (max ${MAX_CONDITIONS})`);
  for (const c of must) validateCondition(c, errors);
  for (const c of veto) validateCondition(c, errors);
  // Conflict check: same field cannot have both eq and neq.
  const seen = new Map();
  for (const c of [...must, ...veto]) {
    const key = `${c.field}`;
    if (seen.has(key) && seen.get(key) !== c.operator) {
      errors.push(`conflicting operators on field ${c.field}`);
    }
    seen.set(key, c.operator);
  }
  return { accepted: errors.length === 0, errors };
}
