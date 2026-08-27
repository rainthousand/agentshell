import { inspectWorkspaceRepositories } from "../core/workspace-guard.js";
import { fail } from "../core/output.js";

const PROTOCOL_VERSION = "agentshell.workspace-guard.v1";

export async function workspaceGuard(roots, options = {}) {
  const inspected = await inspectWorkspaceRepositories(roots, options);
  if (!inspected.ok) {
    return fail(inspected.code, inspected.message, inspected.details, correctionActions(inspected.code));
  }

  const repositories = inspected.repositories;
  const branchNames = new Set(repositories.map((repository) => (
    repository.branch.detached ? "(detached)" : repository.branch.current
  )));
  const summary = {
    repositoryCount: repositories.length,
    cleanRepositories: repositories.filter((repository) => repository.status.clean).length,
    dirtyRepositories: repositories.filter((repository) => repository.status.dirty).length,
    changedFiles: sum(repositories.map((repository) => repository.status.changedFiles)),
    untrackedFiles: sum(repositories.map((repository) => repository.status.untrackedFiles)),
    aheadCommits: sumKnown(repositories.map((repository) => repository.branch.ahead)),
    behindCommits: sumKnown(repositories.map((repository) => repository.branch.behind)),
    trackingRepositories: repositories.filter((repository) => repository.branch.trackingAvailable).length,
    branchesAligned: branchNames.size <= 1,
    truncated: repositories.some((repository) => repository.status.truncated)
  };

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: options.compact === undefined ? true : Boolean(options.compact),
    summary,
    repositories,
    privacy: {
      workspacePathsExposed: false,
      fileNamesExposed: false,
      commandOutputExposed: false,
      networkUpload: false
    },
    suggestedNextActions: nextActions(summary, repositories)
  };
}

function nextActions(summary, repositories) {
  const actions = [];
  if (summary.dirtyRepositories > 0) {
    actions.push({
      command: "agentshell git status --compact",
      reason: "Run from each dirty root to inspect bounded changed-file details"
    });
  }
  if (summary.behindCommits > 0) {
    actions.push({
      command: "git fetch --dry-run",
      reason: "One or more tracked branches are behind; review remote changes without modifying worktrees"
    });
  }
  if (!summary.branchesAligned) {
    actions.push({
      command: "git branch --show-current",
      reason: `Confirm branch intent across ${repositories.length} repositories before coordinated edits`
    });
  }
  if (actions.length === 0) {
    actions.push({
      command: "agentshell run status --compact",
      reason: "All inspected repositories are clean and branch-aligned"
    });
  }
  return actions.slice(0, 3);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function sumKnown(values) {
  return sum(values.filter((value) => Number.isInteger(value)));
}

function correctionActions(code) {
  if (code === "TOO_FEW_ROOTS") {
    return [{ command: "agentshell workspace guard --root <repo-a> --root <repo-b>", reason: "Provide at least two explicit repository roots" }];
  }
  if (code === "NOT_GIT_ROOT") {
    return [{ command: "git rev-parse --show-toplevel", reason: "Resolve and pass the exact Git repository root" }];
  }
  return [];
}
