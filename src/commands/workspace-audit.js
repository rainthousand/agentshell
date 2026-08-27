import { auditWorkspaceRepositories } from "../core/workspace-audit.js";
import { fail } from "../core/output.js";

const PROTOCOL_VERSION = "agentshell.workspace-audit.v1";

export async function workspaceAudit(roots, options = {}) {
  const audited = await auditWorkspaceRepositories(roots, options);
  if (!audited.ok) {
    return fail(audited.code, audited.message, audited.details, correctionActions(audited.code));
  }

  const repositories = audited.repositories;
  const summary = {
    repositoryCount: repositories.length,
    cleanRepositories: repositories.filter((entry) => entry.status.clean).length,
    dirtyRepositories: repositories.filter((entry) => entry.status.dirty).length,
    changedTotal: sum(repositories.map((entry) => entry.status.changedTotal)),
    staged: sum(repositories.map((entry) => entry.status.staged)),
    unstaged: sum(repositories.map((entry) => entry.status.unstaged)),
    untracked: sum(repositories.map((entry) => entry.status.untracked)),
    conflicted: sum(repositories.map((entry) => entry.status.conflicted)),
    diffCheckProblems: sum(repositories.map((entry) => entry.diff.check.problemCount)),
    additions: sum(repositories.flatMap((entry) => [entry.diff.staged.additions, entry.diff.unstaged.additions])),
    deletions: sum(repositories.flatMap((entry) => [entry.diff.staged.deletions, entry.diff.unstaged.deletions])),
    binaryFiles: sum(repositories.flatMap((entry) => [entry.diff.staged.binaryFiles, entry.diff.unstaged.binaryFiles])),
    detachedRepositories: repositories.filter((entry) => entry.branch.detached).length,
    riskFiles: sum(repositories.map((entry) => entry.risks.riskFileCount)),
    riskCategories: sumRiskCategories(repositories),
    truncated: repositories.some((entry) => entry.status.truncated || entry.diff.truncated)
  };

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: options.compact === undefined ? true : Boolean(options.compact),
    limits: {
      maxConcurrentGitProcesses: audited.maxConcurrentGitProcesses
    },
    summary,
    repositories,
    privacy: {
      workspacePathsExposed: false,
      fileNamesExposed: false,
      rawDiffExposed: false,
      commandOutputExposed: false,
      networkUpload: false
    },
    suggestedNextActions: nextActions(summary)
  };
}

function nextActions(summary) {
  const actions = [];
  if (summary.diffCheckProblems > 0) {
    actions.push({ command: "git diff --check", reason: "Review whitespace or conflict-marker problems in each affected repository" });
  }
  if (summary.conflicted > 0) {
    actions.push({ command: "git status --short", reason: "Resolve conflicted files before coordinated verification" });
  }
  if (summary.riskFiles > 0) {
    actions.push({ command: "agentshell verify changed --compact", reason: "Validate protocol, configuration, lockfile, or generated-file changes" });
  }
  if (actions.length === 0 && summary.changedTotal > 0) {
    actions.push({ command: "agentshell verify changed --compact", reason: "Build a bounded validation plan for the audited changes" });
  }
  if (actions.length === 0) {
    actions.push({ command: "agentshell run status --compact", reason: "All audited repositories are clean" });
  }
  return actions.slice(0, 3);
}

function sumRiskCategories(repositories) {
  const result = { generated: 0, lockfile: 0, protocol: 0, configuration: 0 };
  for (const repository of repositories) {
    for (const category of Object.keys(result)) result[category] += repository.risks.categories[category];
  }
  return result;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function correctionActions(code) {
  if (code === "TOO_FEW_ROOTS") {
    return [{ command: "agentshell workspace audit --root <repo-a> --root <repo-b>", reason: "Provide at least two explicit repository roots" }];
  }
  if (code === "NOT_GIT_ROOT" || code === "WORKSPACE_AUDIT_FAILED") {
    return [{ command: "git rev-parse --show-toplevel", reason: "Resolve and pass each exact Git repository root" }];
  }
  return [];
}
