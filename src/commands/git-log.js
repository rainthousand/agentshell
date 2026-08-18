import { spawnSync } from "node:child_process";

import { fail } from "../core/output.js";

const PROTOCOL_VERSION = "agentshell.git-log.v1";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const FIELD_SEPARATOR = "\x1f";
const RECORD_SEPARATOR = "\x1e";

export async function gitLog(root, options = {}) {
  const limit = normalizeLimit(options.limit);
  const compact = options.compact === undefined ? true : Boolean(options.compact);

  const repo = runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (repo.error && repo.error.code === "ENOENT") {
    return fail("GIT_NOT_AVAILABLE", "git is not available on PATH");
  }
  if (repo.status !== 0 || repo.stdout.trim() !== "true") {
    return fail("NOT_GIT_REPOSITORY", "Current directory is not inside a git repository", {
      command: "git rev-parse --is-inside-work-tree",
      stderr: (repo.stderr || "").trim()
    });
  }

  const requested = limit + 1;
  const result = runGit(root, [
    "log",
    `--max-count=${requested}`,
    "--date=iso-strict",
    `--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%cr%x1e`
  ]);

  if (result.error && result.error.code === "ENOENT") {
    return fail("GIT_NOT_AVAILABLE", "git is not available on PATH");
  }

  if (result.status !== 0) {
    if (isEmptyRepositoryError(result.stderr)) {
      return okResponse(compact, limit, [], false);
    }
    return fail("GIT_LOG_FAILED", "Unable to summarize git log", {
      command: `git log --max-count=${requested} --pretty=format:<compact>`,
      stderr: (result.stderr || "").trim()
    });
  }

  const parsed = parseGitLog(result.stdout);
  const commits = parsed.slice(0, limit);
  return okResponse(compact, limit, commits, parsed.length > commits.length);
}

export function parseGitLog(output) {
  return String(output || "")
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, shortHash, subject, authorName, authorDate, relativeAge] = record.split(FIELD_SEPARATOR);
      return {
        hash: hash || "",
        shortHash: shortHash || "",
        subject: subject || "",
        authorName: authorName || "",
        authorDate: authorDate || null,
        relativeAge: relativeAge || null
      };
    });
}

function okResponse(compact, limit, commits, truncated) {
  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact,
    summary: {
      requestedLimit: limit,
      returnedCommits: commits.length,
      hasCommits: commits.length > 0,
      truncated
    },
    commits,
    suggestedNextActions: suggestedNextActions(commits, truncated)
  };
}

function suggestedNextActions(commits, truncated) {
  if (commits.length === 0) {
    return [{
      command: "agentshell git status --compact",
      reason: "No commits were found; inspect the working tree instead"
    }];
  }

  const actions = [{
    command: "agentshell git status --compact",
    reason: "Compare recent history with the current working tree"
  }];

  if (truncated) {
    actions.push({
      command: "agentshell git log --compact --limit 50",
      reason: "More commits are available; request the maximum compact history window if needed"
    });
  }

  return actions;
}

function normalizeLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(number)), MAX_LIMIT);
}

function runGit(root, args) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 4
  });
}

function isEmptyRepositoryError(stderr) {
  return /does not have any commits yet|ambiguous argument 'HEAD'|your current branch .* does not have any commits/i.test(String(stderr || ""));
}
