// System permanent veto rules (MVP spec section 18).
// Agent and human reviewers can never remove these. Any trigger forces KEEP_ALERT.

export function systemVeto(profile) {
  const reasons = [];
  if (profile.isConfirmedAttack) reasons.push("is_confirmed_attack=true");
  if (profile.riskLevel === "HIGH") reasons.push("risk_level=HIGH");
  if (profile.sourceReputation === "malicious") reasons.push("source_reputation=malicious");
  if (profile.extractionFailed) reasons.push("extraction_failed=true");
  if (profile.hasPathTraversal) reasons.push("has_path_traversal=true");
  if (profile.hasDangerousExtension) reasons.push("has_dangerous_extension=true");
  return reasons;
}
