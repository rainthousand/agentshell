import { doctor } from "./doctor.js";
import { understand } from "./understand.js";
import { runNext } from "./run-status.js";
import { createProfile } from "../core/profile.js";
import { getProjectInfo } from "../core/project.js";

const PROTOCOL_VERSION = "agentshell.start.v1";

export async function start(root, options = {}) {
  const profile = options.profile ? createProfile() : null;
  const project = profile
    ? profile.measureSync("project", () => getProjectInfo(root))
    : getProjectInfo(root);
  const doctorResult = profile
    ? await profile.measure("doctor", () => doctor(root, { project }))
    : await doctor(root, { project });
  const understandResult = profile
    ? await profile.measure("understand-compact", () => understand(root, { compact: true, project }))
    : await understand(root, { compact: true, project });
  const nextResult = profile
    ? profile.measureSync("run-next", () => runNext(root))
    : runNext(root);
  const suggestedNextActions = mergeSuggestedNextActions([
    nextResult.command ? {
      command: nextResult.command,
      reason: nextResult.reason
    } : null,
    ...doctorResult.suggestedNextActions,
    understandResult.nextAction ? {
      command: understandResult.nextAction,
      reason: "Compact understand next action"
    } : null
  ]);

  const steps = {
    doctor: "agentshell doctor",
    understand: "agentshell understand --compact",
    next: "agentshell run next"
  };
  const summary = {
    status: doctorResult.status,
    workspace: doctorResult.workspace,
    packageManager: understandResult.stack.packageManager,
    languages: understandResult.stack.languages,
    frameworks: understandResult.stack.frameworks,
    scripts: understandResult.scripts,
    activeRunPresent: doctorResult.activeRun.present,
    nextCommand: nextResult.command,
    errorCount: doctorResult.summary.errorCount,
    warningCount: doctorResult.summary.warningCount
  };
  const compactSummary = {
    ...summary,
    workspace: {
      name: doctorResult.workspace.name
    }
  };

  if (options.compact) {
    const result = {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      compact: true,
      steps,
      summary: compactSummary,
      suggestedNextActions
    };
    if (profile) result.profile = profile.report({
      note: "Measured inside the already-started Node.js process; cold start is measured by benchmark:cold-start."
    });
    return result;
  }

  const result = {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    steps,
    doctor: doctorResult,
    understand: understandResult,
    next: nextResult,
    summary,
    suggestedNextActions
  };
  if (profile) result.profile = profile.report({
    note: "Measured inside the already-started Node.js process; cold start is measured by benchmark:cold-start."
  });
  return result;
}

function mergeSuggestedNextActions(actions) {
  const seen = new Set();
  const merged = [];
  for (const action of actions) {
    if (!action?.command || seen.has(action.command)) continue;
    seen.add(action.command);
    merged.push(action);
  }
  return merged;
}
