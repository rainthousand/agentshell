import { diagnose } from "./diagnose.js";
import { suggestChange } from "./change.js";
import { verify } from "./verify.js";
import { summarizeRun } from "./run-status.js";
import { fail } from "../core/output.js";
import { readActiveRun } from "../core/store.js";
import { createProfile } from "../core/profile.js";

const PROTOCOL_VERSION = "agentshell.fix.v1";

export async function fix(root, type, options = {}) {
  if (type !== "test") {
    return fail("INVALID_ARGUMENT", "Only `agentshell fix test` is supported");
  }

  const policy = normalizePolicy(options);
  if (!policy.ok) return policy;

  const profile = options.profile ? createProfile() : null;
  const diagnosis = profile
    ? await profile.measure("diagnose-test", () => diagnose(root, "test", { compact: true }))
    : await diagnose(root, "test", { compact: true });
  if (!diagnosis.ok) return diagnosis;

  if (diagnosis.verificationOk) {
    const output = {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      compact: Boolean(options.compact),
      dryRun: policy.dryRun,
      ...policyField(policy),
      runId: diagnosis.runId,
      status: "passed",
      diagnosis: compactDiagnosis(diagnosis),
      suggestion: null,
      finalVerification: diagnosis.verification,
      runSummary: currentRunSummary(root),
      suggestedNextActions: []
    };
    addProfile(output, profile, diagnosis, null);
    return options.compact ? compactFixOutput(output) : output;
  }

  const suggestion = profile
    ? await profile.measure(policy.dryRun ? "suggest-preview" : "suggest-apply", () => suggestChange(root, {
        apply: !policy.dryRun,
        dryRun: policy.dryRun,
        compact: true
      }))
    : await suggestChange(root, {
        apply: !policy.dryRun,
        dryRun: policy.dryRun,
        compact: true
      });

  if (!suggestion.ok) {
    return fail("FIX_SUGGESTION_UNAVAILABLE", "Diagnosis completed, but no safe automatic fix was available", {
      runId: diagnosis.runId,
      diagnosis: compactDiagnosis(diagnosis),
      suggestionError: suggestion.error,
      unsupportedReason: suggestion.error?.details?.unsupportedReason || "unsupported-pattern"
    }, [{
      command: diagnosis.changeTemplate?.path
        ? `agentshell change fill ${diagnosis.changeTemplate.path} <fill.json> --apply`
        : "agentshell log get <logRef> --tail 120",
      reason: "Fill the generated template manually or inspect logs"
    }]);
  }

  if (policy.dryRun) {
    const output = {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      compact: Boolean(options.compact),
      dryRun: true,
      ...policyField(policy),
      runId: diagnosis.runId,
      status: "previewed",
      diagnosis: compactDiagnosis(diagnosis),
      suggestion,
      finalVerification: null,
      runSummary: currentRunSummary(root),
      suggestedNextActions: [{
        command: policy.explicitPolicy === "safe"
          ? "agentshell fix test --fast --compact"
          : "agentshell fix test --compact",
        reason: "Apply the previewed suggestion and verify"
      }]
    };
    addProfile(output, profile, diagnosis, null);
    return options.compact ? compactFixOutput(output) : output;
  }

  const finalVerification = profile
    ? await profile.measure("verify-final", () => verify(root, "test", {
        relatedFiles: diagnosis.verification?.relatedFiles || []
      }))
    : await verify(root, "test", {
        relatedFiles: diagnosis.verification?.relatedFiles || []
      });
  const runSummary = currentRunSummary(root);
  const passed = finalVerification.ok === true;

  const output = {
    ok: passed,
    protocolVersion: PROTOCOL_VERSION,
    compact: Boolean(options.compact),
    dryRun: false,
    ...policyField(policy),
    runId: diagnosis.runId,
    status: passed ? "passed" : "failing",
    diagnosis: compactDiagnosis(diagnosis),
    suggestion,
    finalVerification: compactVerification(finalVerification),
    runSummary,
    suggestedNextActions: passed ? rollbackAction(runSummary) : [{
      command: finalVerification.logRef
        ? `agentshell log get ${finalVerification.logRef} --tail 120`
        : "agentshell run status --compact",
      reason: "Inspect the remaining failure"
    }]
  };
  addProfile(output, profile, diagnosis, finalVerification);
  return options.compact ? compactFixOutput(output) : output;
}

function compactFixOutput(output) {
  return {
    ok: output.ok,
    protocolVersion: output.protocolVersion,
    compact: true,
    dryRun: output.dryRun,
    ...policyField(output),
    runId: output.runId,
    status: output.status,
    target: compactTarget(output),
    preview: output.dryRun ? compactPreview(output.suggestion) : null,
    changedFiles: output.suggestion?.applied?.changedFiles || [],
    verification: compactFinalVerification(output),
    rollbackCommand: output.runSummary?.rollbackCommand || null,
    nextBestAction: output.runSummary?.nextBestAction || null,
    profile: output.profile || null,
    suggestedNextActions: output.suggestedNextActions
  };
}

function addProfile(output, profile, diagnosis, finalVerification) {
  if (!profile) return;
  output.profile = profile.report({
    subprocessMs: (diagnosis.verification?.durationMs || 0) + (finalVerification?.durationMs || 0),
    note: "fix profile measures diagnose, suggest/apply, and final verification inside the already-started CLI process. subprocessMs sums test subprocess durations reported by verification phases."
  });
}

function policyField(source) {
  return source.explicitPolicy || source.policy
    ? { policy: source.explicitPolicy || source.policy }
    : {};
}

function normalizePolicy(options) {
  if (!options.policy) {
    return { ok: true, dryRun: Boolean(options.dryRun), explicitPolicy: null };
  }
  if (options.policy === "fast") {
    return { ok: true, dryRun: Boolean(options.dryRun), explicitPolicy: "fast" };
  }
  if (options.policy === "safe") {
    return { ok: true, dryRun: true, explicitPolicy: "safe" };
  }
  return fail("INVALID_ARGUMENT", "Fix policy must be `fast` or `safe`", {
    policy: options.policy
  });
}

function compactTarget(output) {
  const target = output.diagnosis?.fixPlan?.target;
  if (!target) return null;
  return {
    file: target.file,
    range: target.range,
    confidence: output.diagnosis?.fixPlan?.confidence || "low",
    strategy: output.suggestion?.strategy || null
  };
}

function compactPreview(suggestion) {
  if (!suggestion) return null;
  return {
    file: suggestion.preview?.file,
    range: suggestion.preview?.range,
    fill: suggestion.preview?.fill || suggestion.fill,
    strategy: suggestion.strategy,
    confidence: suggestion.confidence
  };
}

function compactFinalVerification(output) {
  const verification = output.finalVerification || output.diagnosis?.verification || null;
  if (!verification) return null;
  return {
    ok: verification.ok ?? output.diagnosis?.verificationOk ?? null,
    operationId: verification.operationId || null,
    summary: verification.summary || null,
    logRef: verification.logRef || null,
    durationMs: verification.durationMs || null,
    cacheHit: verification.cacheHit === true,
    cacheKey: verification.cacheKey || null,
    verificationMode: verification.verificationMode || "full",
    fullCommand: verification.fullCommand || null,
    relatedTestFile: verification.relatedTestFile || null,
    relatedTestFileVerification: verification.relatedTestFileVerification || null
  };
}

function compactDiagnosis(diagnosis) {
  return {
    status: diagnosis.status,
    verificationOk: diagnosis.verificationOk,
    logRef: diagnosis.verification?.logRef,
    fixPlan: diagnosis.fixPlan,
    changeTemplate: diagnosis.changeTemplate
  };
}

function compactVerification(verification) {
  return {
    ok: verification.ok,
    operationId: verification.operationId,
    type: verification.type,
    exitCode: verification.exitCode,
    durationMs: verification.durationMs,
    cacheHit: verification.cacheHit === true,
    cacheKey: verification.cacheKey || null,
    summary: verification.summary,
    relatedFiles: verification.relatedFiles,
    logRef: verification.logRef
  };
}

function currentRunSummary(root) {
  const run = readActiveRun(root);
  return run ? summarizeRun(run) : null;
}

function rollbackAction(runSummary) {
  if (!runSummary?.rollbackCommand) return [];
  return [{
    command: runSummary.rollbackCommand,
    reason: "Revert the automatic fix if the result is not desired"
  }];
}
