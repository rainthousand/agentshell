import { runBoundedProcess } from "../core/bounded-process.js";
import { redactCommandOutput } from "../core/compact-command-output.js";
import { fail } from "../core/output.js";
import { planChangedVerification, VERIFY_CHANGED_PROTOCOL } from "../core/verify-changed.js";

const MAX_ERROR_LENGTH = 400;

export async function verifyChanged(root, options = {}) {
  const planned = planChangedVerification(root, options);
  if (!planned.ok) return fail(planned.code, planned.message);

  const execute = options.execute === true;
  const executions = [];
  if (execute) {
    for (let index = 0; index < planned.plan.length; index += 1) {
      const entry = planned.plan[index];
      const result = options.runCommand
        ? await options.runCommand(entry.argv, root, options)
        : await runBoundedProcess(entry.argv, root, options);
      executions.push(compactExecution(index, entry, result));
      if (result.exitCode !== 0 && options.continueOnError !== true) break;
    }
  }

  const failed = executions.filter((entry) => !entry.ok).length;
  const output = {
    ok: failed === 0,
    protocolVersion: VERIFY_CHANGED_PROTOCOL,
    compact: options.compact === undefined ? true : Boolean(options.compact),
    includeDependents: planned.includeDependents,
    mode: execute ? "execute" : "plan",
    summary: {
      ...planned.summary,
      executedStepCount: executions.length,
      failedStepCount: failed
    },
    ecosystems: planned.ecosystems,
    changedFiles: planned.changedFiles,
    plan: planned.plan,
    executions,
    reasons: planned.reasons,
    suggestedNextActions: nextActions(execute, failed, planned.includeDependents)
  };
  return output;
}

function compactExecution(index, entry, result) {
  const combined = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
  return {
    step: index + 1,
    kind: entry.kind,
    ecosystem: entry.ecosystem,
    ok: result.exitCode === 0,
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : 127,
    durationMs: Math.max(0, Number(result.durationMs) || 0),
    timedOut: Boolean(result.timedOut),
    outputTruncated: Boolean(result.truncated),
    mainError: result.exitCode === 0
      ? null
      : compactText(redactCommandOutput(combined || result.spawnError || "Verification step failed"))
  };
}

function nextActions(execute, failed, includeDependents) {
  const dependentFlag = includeDependents ? " --include-dependents" : "";
  if (!execute) return [{ command: `agentshell verify changed --execute${dependentFlag} --compact`, reason: "Execute the reviewed conservative verification plan" }];
  if (failed > 0) return [{ command: `agentshell verify changed${dependentFlag} --compact`, reason: "Review the plan and failing step before retrying" }];
  return [{ command: "agentshell run status --compact", reason: "Inspect final task evidence" }];
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_LENGTH);
}
