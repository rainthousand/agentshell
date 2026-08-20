import { testCommand } from "./test-command.js";
import { configList } from "./config-list.js";
import { packageDeps } from "./package-deps.js";
import { gitStatus } from "./git-status.js";

const PROTOCOL_VERSION = "agentshell.project-health.v1";

export async function projectHealth(root, options = {}) {
  const [tests, configs, deps, git] = await Promise.all([
    testCommand(root, { compact: true }),
    configList(root, { compact: true }),
    packageDeps(root, { compact: true }),
    gitStatus(root, { compact: true })
  ]);
  const risks = collectRisks(tests, configs, deps, git);
  const summary = {
    status: risks.some((risk) => ["high", "medium"].includes(risk.severity)) ? "warning" : "ok",
    hasTestCommand: Boolean(tests.summary.primaryCommand),
    primaryTestCommand: tests.summary.primaryCommand,
    hasCi: Boolean(configs.summary.hasCi),
    dirty: Boolean(git.ok && git.summary.dirty),
    changedFiles: git.ok ? git.summary.totalFiles : 0,
    manifestCount: deps.ok ? deps.summary.manifests.length : 0,
    dependencyCount: deps.ok ? deps.summary.dependencyCount : 0,
    riskCount: risks.length
  };

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: options.compact === undefined ? true : Boolean(options.compact),
    summary,
    signals: {
      tests: tests.summary,
      configs: configs.summary,
      dependencies: deps.ok ? deps.summary : null,
      git: git.ok ? git.summary : null
    },
    risks,
    suggestedNextActions: suggestedNextActions(summary)
  };
}

function collectRisks(tests, configs, deps, git) {
  const risks = [];
  if (!tests.summary.primaryCommand) {
    risks.push({ type: "test-command-missing", severity: "medium", message: "No common test command was detected" });
  }
  if (!configs.summary.hasCi) {
    risks.push({ type: "ci-missing", severity: "low", message: "No common CI configuration was detected" });
  }
  if (git.ok && git.summary.dirty) {
    risks.push({ type: "working-tree-dirty", severity: "medium", message: "Working tree has uncommitted changes", count: git.summary.totalFiles });
  }
  if (deps.ok) {
    for (const risk of deps.risks || []) risks.push({ ...risk, source: "package-deps" });
  }
  return risks;
}

function suggestedNextActions(summary) {
  const actions = [];
  if (summary.primaryTestCommand) actions.push({ command: summary.primaryTestCommand, reason: "Run the primary detected test command when ready" });
  if (summary.dirty) actions.push({ command: "agentshell changed impact --compact", reason: "Summarize changed-file impact before verification" });
  if (!summary.hasCi) actions.push({ command: "agentshell config list --compact", reason: "Inspect project config entrypoints and confirm CI is intentionally absent" });
  if (actions.length === 0) actions.push({ command: "agentshell run status --compact", reason: "Project health did not find an immediate blocker" });
  return actions;
}
