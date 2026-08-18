import { spawnSync } from "node:child_process";

import { fail } from "../core/output.js";

const PROTOCOL_VERSION = "agentshell.git-branch.v1";
const DEFAULT_MAX_BRANCHES = 40;

export async function gitBranch(root, options = {}) {
  const compact = options.compact === undefined ? true : Boolean(options.compact);
  const maxBranches = normalizeMaxBranches(options.maxBranches);

  if (!isGitRepository(root)) {
    return fail("NOT_GIT_REPOSITORY", "Current directory is not inside a git repository", {
      command: "git rev-parse --is-inside-work-tree"
    });
  }

  const current = currentBranch(root);
  const allBranches = localBranches(root, current.name);
  const branches = allBranches.slice(0, maxBranches);
  const remotes = remoteSummaries(root);
  const summary = {
    localBranchCount: allBranches.length,
    returnedBranchCount: branches.length,
    truncatedBranches: branches.length < allBranches.length,
    remoteCount: remotes.length,
    detached: current.detached,
    hasUpstream: Boolean(current.upstream),
    ahead: current.ahead,
    behind: current.behind
  };

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact,
    current,
    branches,
    remotes,
    summary,
    suggestedNextActions: suggestedNextActions(current, summary)
  };
}

function isGitRepository(root) {
  const result = runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  return result.status === 0 && result.stdout.trim() === "true";
}

function currentBranch(root) {
  const nameResult = runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const detached = nameResult.status !== 0;
  const name = detached ? null : nameResult.stdout.trim();
  const commitResult = runGit(root, ["rev-parse", "--short", "HEAD"]);
  const upstreamResult = runGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const upstream = upstreamResult.status === 0 ? upstreamResult.stdout.trim() || null : null;
  const counts = upstream ? aheadBehind(root, "HEAD...@{upstream}") : { ahead: 0, behind: 0 };

  return {
    name,
    detached,
    commit: commitResult.status === 0 ? commitResult.stdout.trim() : null,
    upstream,
    ahead: counts.ahead,
    behind: counts.behind
  };
}

function localBranches(root, currentName) {
  const result = runGit(root, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)\t%(objectname:short)\t%(upstream:short)\t%(upstream:track)",
    "refs/heads"
  ]);
  if (result.status !== 0) return [];

  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, commit, upstream, track] = line.split("\t");
      const counts = parseTrack(track);
      return {
        name,
        current: name === currentName,
        commit: commit || null,
        upstream: upstream || null,
        ahead: counts.ahead,
        behind: counts.behind
      };
    });
}

function remoteSummaries(root) {
  const result = runGit(root, ["remote", "-v"]);
  if (result.status !== 0) return [];

  const byName = new Map();
  for (const rawLine of result.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match || match[3] !== "fetch" || byName.has(match[1])) continue;
    byName.set(match[1], {
      name: match[1],
      ...remoteHostHint(match[2])
    });
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function aheadBehind(root, range) {
  const result = runGit(root, ["rev-list", "--left-right", "--count", range]);
  if (result.status !== 0) return { ahead: 0, behind: 0 };
  const [ahead, behind] = result.stdout.trim().split(/\s+/).map((value) => Number(value));
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0
  };
}

export function parseTrack(track) {
  const text = String(track || "");
  const ahead = text.match(/ahead\s+(\d+)/);
  const behind = text.match(/behind\s+(\d+)/);
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0
  };
}

export function remoteHostHint(rawUrl) {
  const host = hostFromRemoteUrl(rawUrl);
  return {
    host,
    provider: providerForHost(host)
  };
}

function hostFromRemoteUrl(rawUrl) {
  const text = String(rawUrl || "");
  const scpLike = text.match(/^[^@]+@([^:]+):/);
  if (scpLike) return scpLike[1].toLowerCase();

  try {
    const parsed = new URL(text);
    return parsed.hostname ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function providerForHost(host) {
  if (!host) return "local";
  if (host.includes("github.")) return "github";
  if (host.includes("gitlab.")) return "gitlab";
  if (host.includes("bitbucket.")) return "bitbucket";
  if (host.includes("dev.azure.") || host.includes("visualstudio.")) return "azure-devops";
  return "git";
}

function suggestedNextActions(current, summary) {
  if (current.detached) {
    return [{
      command: "git switch -",
      reason: "Repository is in detached HEAD state"
    }];
  }
  const actions = [];
  if (!current.upstream) {
    actions.push({
      command: `git push -u origin ${shellQuote(current.name || "HEAD")}`,
      reason: "Current branch has no upstream tracking branch"
    });
  }
  if (summary.behind > 0) {
    actions.push({
      command: "git pull --ff-only",
      reason: "Current branch is behind its upstream"
    });
  }
  if (summary.truncatedBranches) {
    actions.push({
      command: "agentshell git branch --compact --max-branches 100",
      reason: "Local branch list was truncated"
    });
  }
  if (actions.length === 0) {
    actions.push({
      command: "agentshell git status --compact",
      reason: "Branch state is ready; inspect working tree status next"
    });
  }
  return actions;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function normalizeMaxBranches(value) {
  const parsed = Number(value || DEFAULT_MAX_BRANCHES);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_BRANCHES;
  return Math.min(Math.floor(parsed), 200);
}

function runGit(root, args) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 4
  });
}
