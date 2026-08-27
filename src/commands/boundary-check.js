import fs from "node:fs";
import path from "node:path";

import { BOUNDARY_CHECK_PROTOCOL, evaluateBoundaryPolicy } from "../core/boundary-check.js";
import { fail } from "../core/output.js";
import { readChangedFiles } from "../core/verify-changed.js";

export function boundaryCheck(root, options = {}) {
  const policyResult = loadPolicy(root, options);
  if (!policyResult.ok) return fail(policyResult.code, policyResult.message, policyResult.details);

  const changed = readChangedFiles(root, options);
  if (!changed.ok) return fail(changed.code, changed.message);
  const checked = evaluateBoundaryPolicy(changed.files, policyResult.policy);
  if (!checked.protocolVersion) return fail(checked.code, checked.message);
  const truncationViolation = changed.truncated ? [{
    file: "<unreported-changed-files>",
    ruleId: "changed-files-truncated",
    reason: "Changed-file input was truncated, so the boundary check cannot safely pass"
  }] : [];
  const violationCount = checked.summary.violationCount + truncationViolation.length;
  const checkedViolationLimit = truncationViolation.length > 0 ? 99 : 100;
  const violations = [...checked.violations.slice(0, checkedViolationLimit), ...truncationViolation];
  const ok = checked.ok && !changed.truncated;

  return {
    ok,
    protocolVersion: BOUNDARY_CHECK_PROTOCOL,
    compact: options.compact === undefined ? true : Boolean(options.compact),
    mode: "check",
    summary: {
      ...checked.summary,
      allowedFileCount: ok ? checked.summary.allowedFileCount : Math.min(checked.summary.allowedFileCount, changed.files.length),
      violationCount,
      violationsTruncated: violationCount > violations.length,
      changedFileCount: changed.total,
      returnedChangedFileCount: changed.files.length,
      changedFilesTruncated: changed.truncated
    },
    policy: checked.policy,
    violations,
    files: checked.files,
    filesTruncated: checked.filesTruncated,
    suggestedNextActions: ok ? [] : [{
      command: "agentshell git diff --compact",
      reason: "Review boundary violations before changing the policy or source"
    }]
  };
}

function loadPolicy(root, options) {
  if (options.policy !== undefined) return { ok: true, policy: options.policy };
  if (!options.policyFile) return { ok: false, code: "BOUNDARY_POLICY_REQUIRED", message: "Provide a boundary policy object or workspace-relative JSON policy file" };

  const relative = String(options.policyFile).replaceAll("\\", "/");
  const absolute = path.resolve(root, relative);
  const rootAbsolute = path.resolve(root);
  if (absolute !== rootAbsolute && !absolute.startsWith(`${rootAbsolute}${path.sep}`)) {
    return { ok: false, code: "BOUNDARY_POLICY_PATH_INVALID", message: "Boundary policy file must be inside the workspace" };
  }
  try {
    const realRoot = fs.realpathSync(rootAbsolute);
    const realPolicy = fs.realpathSync(absolute);
    if (!isSameOrInside(realRoot, realPolicy)) {
      return { ok: false, code: "BOUNDARY_POLICY_PATH_INVALID", message: "Boundary policy file must be inside the workspace" };
    }
    const value = JSON.parse(fs.readFileSync(realPolicy, "utf8"));
    return { ok: true, policy: value };
  } catch (error) {
    return {
      ok: false,
      code: "BOUNDARY_POLICY_READ_FAILED",
      message: "Unable to read boundary policy JSON",
      details: { path: relative, reason: String(error?.message || error).slice(0, 240) }
    };
  }
}

function isSameOrInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
