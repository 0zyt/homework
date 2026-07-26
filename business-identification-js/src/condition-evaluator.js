// Condition evaluation against a normalized alert profile.
// Used by testing and live matching to apply agent-supplied boundaries.

function parseValue(valueJson) {
  if (valueJson === undefined || valueJson === null) return undefined;
  if (typeof valueJson === "string") {
    try {
      return JSON.parse(valueJson);
    } catch {
      return valueJson;
    }
  }
  return valueJson;
}

function asArray(v) {
  return Array.isArray(v) ? v : [v];
}

function snakeToCamel(s) {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function evalCondition(condition, profile) {
  const field = condition.field;
  const op = (condition.operator || "").toLowerCase();
  const expected = parseValue(condition.valueJson);
  const actual = profile[snakeToCamel(field)];

  switch (op) {
    case "eq":
      if (typeof expected === "boolean") return actual === expected;
      // numeric-aware loose compare
      if (typeof expected === "number" && typeof actual === "number") return actual === expected;
      return String(actual) === String(expected);
    case "neq":
      if (typeof expected === "boolean") return actual !== expected;
      if (typeof expected === "number" && typeof actual === "number") return actual !== expected;
      return String(actual) !== String(expected);
    case "in":
      return asArray(expected).some((e) => String(e) === String(actual));
    case "not_in":
      return !asArray(expected).some((e) => String(e) === String(actual));
    case "contains":
      return String(actual == null ? "" : actual).includes(String(expected));
    case "not_contains":
      return !String(actual == null ? "" : actual).includes(String(expected));
    case "starts_with":
      return String(actual == null ? "" : actual).startsWith(String(expected));
    default:
      throw new Error(`unsupported operator: ${condition.operator}`);
  }
}

// Must conditions: all must pass.
export function evaluateMust(conditions, profile) {
  const results = [];
  for (const c of conditions || []) {
    const passed = evalCondition(c, profile);
    results.push({ field: c.field, operator: c.operator, passed });
  }
  return { allPass: results.every((r) => r.passed), results };
}

// Veto conditions: if ANY passes, the alert is vetoed (keep alert).
export function evaluateVeto(conditions, profile) {
  const results = [];
  for (const c of conditions || []) {
    const passed = evalCondition(c, profile);
    results.push({ field: c.field, operator: c.operator, passed });
  }
  return { anyVeto: results.some((r) => r.passed), results };
}
