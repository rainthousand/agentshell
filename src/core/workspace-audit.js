import path from "node:path";

import { runBoundedProcess } from "./bounded-process.js";
import { resolveExplicitRoots } from "./workspace-guard.js";

const HARD_MAX_ROOTS = 32;
const GIT_OUTPUT_LIMIT_BYTES = 512 * 1024;
const MAX_BRANCH_CHARS = 160;
const DEFAULT_MAX_CONCURRENCY = 4;
const HARD_MAX_CONCURRENCY = 8;
const UNMERGED_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const RISK_CATEGORIES = ["generated", "lockfile", "protocol", "configuration"];

export async function auditWorkspaceRepositories(roots, options = {}) {
  const resolved = resolveExplicitRoots(roots, {
    ...options,
    maxRoots: options.maxRoots ?? HARD_MAX_ROOTS
  });
  if (!resolved.ok) return resolved;

  const maxConcurrentGitProcesses = boundedInteger(
    options.maxConcurrency,
    DEFAULT_MAX_CONCURRENCY,
    1,
    HARD_MAX_CONCURRENCY
  );
  const processRunner = typeof options.runProcess === "function" ? options.runProcess : runBoundedProcess;
  const limiter = createConcurrencyLimiter(maxConcurrentGitProcesses);
  const runGit = (args, cwd, processOptions) => limiter(() => processRunner(args, cwd, processOptions));
  const inspected = await Promise.all(resolved.roots.map((root) => auditRepository(root, options, runGit)));
  const failures = inspected.filter((entry) => !entry.ok).map((entry) => entry.failure);
  if (failures.length > 0) {
    return inputFailure("WORKSPACE_AUDIT_FAILED", "One or more repositories could not be audited", {
      failedRepositories: failures,
      failedRepositoryCount: failures.length,
      repositoryCount: resolved.roots.length
    });
  }

  return {
    ok: true,
    maxRoots: resolved.maxRoots,
    maxConcurrentGitProcesses,
    repositories: inspected.map((entry) => entry.value)
  };
}

async function auditRepository(root, options, runGit) {
  const processOptions = {
    timeoutMs: options.timeoutMs,
    maxOutputBytes: GIT_OUTPUT_LIMIT_BYTES
  };
  const topLevel = await runGit(["git", "rev-parse", "--show-toplevel"], root.path, processOptions);
  if (topLevel.spawnError === "ENOENT") {
    return repositoryFailure(root, "GIT_NOT_AVAILABLE", false);
  }
  if (topLevel.exitCode !== 0 || canonicalText(topLevel.stdout) !== canonicalText(root.path)) {
    return repositoryFailure(root, "NOT_GIT_ROOT", topLevel.timedOut);
  }

  const commands = {
    branch: ["git", "branch", "--show-current"],
    status: ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    unstagedCheck: ["git", "diff", "--check"],
    stagedCheck: ["git", "diff", "--cached", "--check"],
    unstagedNumstat: ["git", "diff", "--numstat", "-z"],
    stagedNumstat: ["git", "diff", "--cached", "--numstat", "-z"]
  };
  const names = Object.keys(commands);
  const results = await Promise.all(names.map((name) => (
    runGit(commands[name], root.path, processOptions)
  )));
  const byName = Object.fromEntries(names.map((name, index) => [name, results[index]]));

  const failedCommand = names.find((name) => !acceptableResult(name, byName[name]));
  if (failedCommand) {
    return repositoryFailure(
      root,
      byName[failedCommand].timedOut ? "GIT_AUDIT_TIMEOUT" : "GIT_AUDIT_COMMAND_FAILED",
      byName[failedCommand].timedOut,
      failedCommand
    );
  }

  const status = parsePorcelainStatus(byName.status.stdout);
  const branch = parseCurrentBranch(byName.branch.stdout, byName.branch.truncated);
  const unstaged = parseNumstat(byName.unstagedNumstat.stdout);
  const staged = parseNumstat(byName.stagedNumstat.stdout);
  const risks = classifyRiskFiles(status.files);
  const check = {
    passed: countCheckProblems(byName.unstagedCheck) + countCheckProblems(byName.stagedCheck) === 0,
    problemCount: countCheckProblems(byName.unstagedCheck) + countCheckProblems(byName.stagedCheck),
    truncated: byName.unstagedCheck.truncated || byName.stagedCheck.truncated
  };

  return {
    ok: true,
    value: {
      rootId: root.id,
      name: root.name,
      branch,
      status: {
        clean: status.changedTotal === 0,
        dirty: status.changedTotal > 0,
        changedTotal: status.changedTotal,
        staged: status.staged,
        unstaged: status.unstaged,
        untracked: status.untracked,
        conflicted: status.conflicted,
        truncated: byName.status.truncated
      },
      diff: {
        staged,
        unstaged,
        check,
        truncated: byName.stagedNumstat.truncated || byName.unstagedNumstat.truncated || check.truncated
      },
      risks
    }
  };
}

export function parseCurrentBranch(output, sourceTruncated = false) {
  const sanitized = String(output || "")
    .split(/\r?\n/, 1)[0]
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (!sanitized) {
    return { current: null, detached: true, truncated: Boolean(sourceTruncated) };
  }
  return {
    current: sanitized.slice(0, MAX_BRANCH_CHARS),
    detached: false,
    truncated: Boolean(sourceTruncated || sanitized.length > MAX_BRANCH_CHARS)
  };
}

export function parsePorcelainStatus(output) {
  const tokens = String(output || "").split("\0");
  const files = [];
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.length < 4) continue;
    const code = token.slice(0, 2);
    const file = token.slice(3);
    if (code === "??") {
      untracked += 1;
    } else if (code !== "!!") {
      if (code[0] !== " ") staged += 1;
      if (code[1] !== " ") unstaged += 1;
      if (UNMERGED_CODES.has(code)) conflicted += 1;
    }
    if (code !== "!!") files.push(file);
    if (/[RC]/.test(code) && tokens[index + 1]) index += 1;
  }

  return { changedTotal: files.length, staged, unstaged, untracked, conflicted, files };
}

export function parseNumstat(output) {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  let binaryFiles = 0;
  for (const token of String(output || "").split("\0")) {
    const match = token.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!match) continue;
    files += 1;
    if (match[1] === "-" || match[2] === "-") {
      binaryFiles += 1;
    } else {
      additions += Number(match[1]);
      deletions += Number(match[2]);
    }
  }
  return { files, additions, deletions, binaryFiles };
}

export function classifyRiskFiles(files) {
  const categories = Object.fromEntries(RISK_CATEGORIES.map((category) => [category, 0]));
  let riskFileCount = 0;
  for (const file of files) {
    const category = classifyRiskFile(file);
    if (!category) continue;
    categories[category] += 1;
    riskFileCount += 1;
  }
  return { riskFileCount, categories };
}

function classifyRiskFile(file) {
  const normalized = String(file || "").replaceAll("\\", "/").toLowerCase();
  const base = path.posix.basename(normalized);
  if (/(^|\/)(generated|gen)(\/|$)/.test(normalized)
      || /(?:\.generated\.|_generated\.|\.g\.)/.test(base)
      || /(?:\.pb\.go|\.pb\.cc|\.pb\.h|\.designer\.cs)$/.test(base)) return "generated";
  if (/^(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|go\.sum|cargo\.lock|composer\.lock|poetry\.lock|pipfile\.lock|gradle\.lockfile)$/.test(base)) return "lockfile";
  if (/\.(?:proto|thrift|avsc|graphqls?|wsdl|xsd)$/.test(base)
      || /(?:^|[-_.])(openapi|swagger)(?:[-_.]|$)/.test(base)
      || /(^|\/)idl(\/|$)/.test(normalized)) return "protocol";
  if (/^(?:dockerfile|makefile|\.env(?:\..+)?|tsconfig(?:\..+)?\.json|pyproject\.toml|go\.mod)$/.test(base)
      || /\.(?:ya?ml|toml|ini|conf|cfg|properties)$/.test(base)
      || /(^|\/)(?:config|configs|\.github)(\/|$)/.test(normalized)) return "configuration";
  return null;
}

function acceptableResult(name, result) {
  if (result.spawnError || result.timedOut) return false;
  if (name.endsWith("Check")) return result.exitCode === 0 || result.exitCode === 2;
  return result.exitCode === 0;
}

function countCheckProblems(result) {
  const lines = `${result.stdout || ""}\n${result.stderr || ""}`.split(/\r?\n/).filter(Boolean);
  const issueLines = lines.filter((line) => /:\d+:(?:\d+:)?\s/.test(line));
  return issueLines.length || (result.exitCode === 0 ? 0 : Math.min(1, lines.length));
}

function repositoryFailure(root, code, timedOut, operation = null) {
  return {
    ok: false,
    failure: {
      rootId: root.id,
      name: root.name,
      code,
      timedOut: Boolean(timedOut),
      ...(operation ? { operation } : {})
    }
  };
}

function canonicalText(value) {
  return path.resolve(String(value || "").trim());
}

function inputFailure(code, message, details = {}) {
  return { ok: false, code, message, details };
}

export function createConcurrencyLimiter(maxConcurrency) {
  const maximum = boundedInteger(maxConcurrency, DEFAULT_MAX_CONCURRENCY, 1, HARD_MAX_CONCURRENCY);
  let active = 0;
  const queue = [];

  function drain() {
    while (active < maximum && queue.length > 0) {
      const entry = queue.shift();
      active += 1;
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  return function limit(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      drain();
    });
  };
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}
