import { filesChanged } from "./files-changed.js";
import { testCommand } from "./test-command.js";

const PROTOCOL_VERSION = "agentshell.changed-impact.v1";

export async function changedImpact(root, options = {}) {
  const changed = await filesChanged(root, { compact: true });
  if (!changed.ok) return changed;
  const tests = await testCommand(root, { compact: true });
  const impacts = summarizeImpacts(changed.files);
  const summary = {
    clean: changed.summary.clean,
    changedFiles: changed.summary.totalFiles,
    returnedFiles: changed.summary.returnedFiles,
    highRiskFiles: changed.files.filter((file) => file.risk === "high").length,
    categories: changed.summary.categories,
    recommendedCommandCount: tests.summary.commandCount
  };

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: options.compact === undefined ? true : Boolean(options.compact),
    summary,
    impacts,
    files: changed.files,
    recommendedCommands: tests.commands,
    risks: risksFor(changed),
    suggestedNextActions: suggestedNextActions(summary, tests)
  };
}

function summarizeImpacts(files) {
  const categories = new Set(files.map((file) => file.category));
  const impacts = [];
  if (categories.has("source")) impacts.push({ area: "runtime-behavior", confidence: "medium", reason: "Source files changed" });
  if (categories.has("test")) impacts.push({ area: "test-behavior", confidence: "high", reason: "Test files changed" });
  if (categories.has("config")) impacts.push({ area: "tooling-or-build", confidence: "high", reason: "Configuration files changed" });
  if (categories.has("lockfile")) impacts.push({ area: "dependency-resolution", confidence: "high", reason: "Lockfiles changed" });
  if (categories.has("docs")) impacts.push({ area: "documentation", confidence: "high", reason: "Documentation files changed" });
  return impacts;
}

function risksFor(changed) {
  const risks = [];
  if (changed.summary.risks.high) {
    risks.push({ type: "high-risk-files", severity: "high", message: "High-risk changed files are present", count: changed.summary.risks.high });
  }
  if (changed.summary.categories.lockfile) {
    risks.push({ type: "lockfile-changed", severity: "medium", message: "Dependency lockfile changes may affect install or runtime behavior", count: changed.summary.categories.lockfile });
  }
  if (changed.summary.truncated) {
    risks.push({ type: "changed-files-truncated", severity: "low", message: "Compact changed-file list was truncated" });
  }
  return risks;
}

function suggestedNextActions(summary, tests) {
  if (summary.clean) return [{ command: "agentshell run status --compact", reason: "No changed files detected" }];
  const actions = [{ command: "agentshell git diff --compact", reason: "Inspect compact diff hunks for the changed files" }];
  if (tests.summary.primaryCommand) {
    actions.push({ command: tests.summary.primaryCommand, reason: "Run the primary detected test command for changed-file validation" });
  } else {
    actions.push({ command: "agentshell test command --compact", reason: "Find a runnable test command before verification" });
  }
  return actions;
}
