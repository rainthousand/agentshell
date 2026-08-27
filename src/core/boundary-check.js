import path from "node:path";

const MAX_RULES = 100;
const MAX_PATTERNS = 100;
const MAX_VIOLATIONS = 100;

export const BOUNDARY_CHECK_PROTOCOL = "agentshell.boundary-check.v1";

export function evaluateBoundaryPolicy(changedFiles, policy = {}) {
  const normalized = normalizePolicy(policy);
  if (!normalized.ok) return normalized;

  const files = normalizeFiles(changedFiles);
  const violations = [];
  let violationCount = 0;
  const checked = [];
  for (const file of files) {
    const decision = evaluateFile(file, normalized.policy);
    checked.push({ file, allowed: decision.allowed, matchedRuleIds: decision.matchedRuleIds.slice(0, 12) });
    if (!decision.allowed) {
      violationCount += 1;
      if (violations.length < MAX_VIOLATIONS) {
        violations.push({
          file,
          ruleId: decision.ruleId,
          reason: decision.reason
        });
      }
    }
  }

  return {
    ok: violationCount === 0,
    protocolVersion: BOUNDARY_CHECK_PROTOCOL,
    policy: {
      name: normalized.policy.name,
      defaultEffect: normalized.policy.defaultEffect,
      ruleCount: normalized.policy.rules.length
    },
    summary: {
      checkedFileCount: files.length,
      allowedFileCount: files.length - violationCount,
      violationCount,
      violationsTruncated: violationCount > violations.length
    },
    violations,
    files: checked.slice(0, 200),
    filesTruncated: checked.length > 200
  };
}

export function normalizeBoundaryPolicy(input = {}) {
  return normalizePolicy(input);
}

function normalizePolicy(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid("BOUNDARY_POLICY_INVALID", "Boundary policy must be an object");
  const defaultEffect = input.defaultEffect ?? "allow";
  if (!["allow", "deny"].includes(defaultEffect)) return invalid("BOUNDARY_POLICY_INVALID", "defaultEffect must be allow or deny");

  const rules = [];
  if (input.allow !== undefined) rules.push(...legacyRules("allow", input.allow));
  if (input.deny !== undefined) rules.push(...legacyRules("deny", input.deny));
  if (Array.isArray(input.rules)) rules.push(...input.rules);
  if (rules.length > MAX_RULES) return invalid("BOUNDARY_POLICY_TOO_LARGE", `Boundary policy supports at most ${MAX_RULES} rules`);

  const normalizedRules = [];
  const ids = new Set();
  for (let index = 0; index < rules.length; index += 1) {
    const result = normalizeRule(rules[index], index);
    if (!result.ok) return result;
    if (ids.has(result.rule.id)) return invalid("BOUNDARY_POLICY_INVALID", `Duplicate boundary rule id: ${result.rule.id}`);
    ids.add(result.rule.id);
    normalizedRules.push(result.rule);
  }

  return {
    ok: true,
    policy: {
      name: compactText(input.name || "boundary-policy", 80),
      defaultEffect,
      rules: normalizedRules
    }
  };
}

function normalizeRule(rule, index) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return invalid("BOUNDARY_POLICY_INVALID", `Rule ${index + 1} must be an object`);
  const effect = rule.effect;
  if (!["allow", "deny"].includes(effect)) return invalid("BOUNDARY_POLICY_INVALID", `Rule ${index + 1} effect must be allow or deny`);
  const globs = normalizePatterns(rule.globs ?? rule.glob, "glob");
  if (!globs.ok) return globs;
  const prefixes = normalizePatterns(rule.prefixes ?? rule.prefix, "prefix");
  if (!prefixes.ok) return prefixes;
  if (globs.values.length + prefixes.values.length === 0) return invalid("BOUNDARY_POLICY_INVALID", `Rule ${index + 1} needs at least one glob or prefix`);
  return {
    ok: true,
    rule: {
      id: compactText(rule.id || `${effect}-${index + 1}`, 80),
      effect,
      globs: globs.values,
      prefixes: prefixes.values,
      reason: compactText(rule.reason || `${effect} boundary matched`, 240)
    }
  };
}

function normalizePatterns(value, type) {
  const values = value === undefined ? [] : (Array.isArray(value) ? value : [value]);
  if (values.length > MAX_PATTERNS) return invalid("BOUNDARY_POLICY_TOO_LARGE", `A rule supports at most ${MAX_PATTERNS} ${type} patterns`);
  const normalized = [];
  for (const raw of values) {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 300) return invalid("BOUNDARY_POLICY_INVALID", `Invalid ${type} pattern`);
    const pattern = normalizePath(raw);
    if (!pattern || pattern.startsWith("../") || path.posix.isAbsolute(pattern)) return invalid("BOUNDARY_POLICY_INVALID", `${type} patterns must be workspace-relative`);
    normalized.push(type === "prefix" ? pattern.replace(/\/+$/, "") : pattern);
  }
  return { ok: true, values: [...new Set(normalized)] };
}

function legacyRules(effect, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [{ effect, globs: value }];
  return [{ id: `${effect}-policy`, effect, globs: value.globs ?? [], prefixes: value.prefixes ?? [], reason: value.reason }];
}

function evaluateFile(file, policy) {
  const matches = policy.rules.filter((rule) => matchesRule(file, rule));
  const denied = matches.find((rule) => rule.effect === "deny");
  if (denied) return { allowed: false, ruleId: denied.id, reason: denied.reason, matchedRuleIds: matches.map((rule) => rule.id) };

  const allowRules = policy.rules.filter((rule) => rule.effect === "allow");
  const allowed = matches.find((rule) => rule.effect === "allow");
  if (allowed) return { allowed: true, ruleId: allowed.id, reason: allowed.reason, matchedRuleIds: matches.map((rule) => rule.id) };
  if (allowRules.length > 0) return { allowed: false, ruleId: "allow-scope", reason: "Changed file is outside every configured allow boundary", matchedRuleIds: [] };
  return {
    allowed: policy.defaultEffect === "allow",
    ruleId: "default-effect",
    reason: `Boundary policy default effect is ${policy.defaultEffect}`,
    matchedRuleIds: []
  };
}

function matchesRule(file, rule) {
  return rule.prefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`))
    || rule.globs.some((glob) => globToRegExp(glob).test(file));
}

function globToRegExp(glob) {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      index += 1;
      if (glob[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else source += ".*";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

function normalizeFiles(files) {
  if (!Array.isArray(files)) return [];
  return [...new Set(files.map(normalizePath).filter((file) => file && !file.startsWith("../") && !path.posix.isAbsolute(file)))].sort();
}

function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "/").replace(/^\//, "").replace(/\/+/g, "/");
}

function invalid(code, message) {
  return { ok: false, code, message };
}

function compactText(value, limit) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}
