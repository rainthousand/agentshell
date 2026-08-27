import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runBoundedProcess } from "./bounded-process.js";

const DEFAULT_MAX_ROOTS = 8;
const HARD_MAX_ROOTS = 32;
const GIT_OUTPUT_LIMIT_BYTES = 256 * 1024;

export function resolveExplicitRoots(roots, options = {}) {
  const maxRoots = boundedInteger(options.maxRoots, DEFAULT_MAX_ROOTS, 2, HARD_MAX_ROOTS);
  if (!Array.isArray(roots) || roots.length < 2) {
    return inputFailure("TOO_FEW_ROOTS", "At least two explicit workspace roots are required", {
      minimumRoots: 2,
      receivedRoots: Array.isArray(roots) ? roots.length : 0
    });
  }
  if (roots.length > maxRoots) {
    return inputFailure("TOO_MANY_ROOTS", "Workspace root limit exceeded", {
      maximumRoots: maxRoots,
      receivedRoots: roots.length
    });
  }

  const home = canonicalPath(os.homedir());
  const seen = new Map();
  const resolved = [];

  for (let index = 0; index < roots.length; index += 1) {
    const value = roots[index];
    const rootId = `root-${index + 1}`;
    if (typeof value !== "string" || !value.trim()) {
      return inputFailure("INVALID_ROOT", "Each workspace root must be a non-empty explicit path", { rootId });
    }

    const absolute = path.resolve(value);
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch {
      return inputFailure("ROOT_NOT_FOUND", "Workspace root does not exist", {
        rootId,
        name: safeRootName(absolute)
      });
    }
    if (!stat.isDirectory()) {
      return inputFailure("ROOT_NOT_DIRECTORY", "Workspace root must be a directory", {
        rootId,
        name: safeRootName(absolute)
      });
    }

    const canonical = canonicalPath(absolute);
    if (canonical === path.parse(canonical).root || canonical === home) {
      return inputFailure("DANGEROUS_ROOT", "Refusing an over-broad workspace root", {
        rootId,
        kind: canonical === home ? "home" : "filesystem-root"
      });
    }
    if (seen.has(canonical)) {
      return inputFailure("DUPLICATE_ROOT", "Workspace roots must be unique after resolving symlinks", {
        rootId,
        duplicateOf: seen.get(canonical)
      });
    }

    seen.set(canonical, rootId);
    resolved.push({
      id: rootId,
      name: safeRootName(canonical),
      path: canonical
    });
  }

  return { ok: true, roots: resolved, maxRoots };
}

export async function inspectWorkspaceRepositories(roots, options = {}) {
  const resolved = resolveExplicitRoots(roots, options);
  if (!resolved.ok) return resolved;

  const repositories = await Promise.all(resolved.roots.map((root) => inspectRepository(root, options)));
  const failure = repositories.find((repository) => !repository.ok);
  if (failure) return failure;

  return {
    ok: true,
    maxRoots: resolved.maxRoots,
    repositories: repositories.map((repository) => repository.value)
  };
}

async function inspectRepository(root, options) {
  const processOptions = {
    timeoutMs: options.timeoutMs,
    maxOutputBytes: GIT_OUTPUT_LIMIT_BYTES
  };
  const topLevel = await runBoundedProcess(
    ["git", "rev-parse", "--show-toplevel"],
    root.path,
    processOptions
  );
  if (topLevel.spawnError === "ENOENT") {
    return inputFailure("GIT_NOT_AVAILABLE", "git is not available on PATH");
  }
  if (topLevel.exitCode !== 0) {
    return inputFailure("NOT_GIT_ROOT", "Workspace guard requires every root to be a Git repository root", {
      rootId: root.id,
      name: root.name
    });
  }

  const reportedRoot = canonicalPath(topLevel.stdout.trim());
  if (reportedRoot !== root.path) {
    return inputFailure("NOT_GIT_ROOT", "Workspace guard requires the repository root, not a nested directory", {
      rootId: root.id,
      name: root.name
    });
  }

  const status = await runBoundedProcess([
    "git",
    "status",
    "--porcelain=v2",
    "--branch",
    "--untracked-files=all"
  ], root.path, processOptions);
  if (status.exitCode !== 0) {
    return inputFailure("GIT_STATUS_FAILED", "Unable to inspect repository status", {
      rootId: root.id,
      name: root.name,
      timedOut: status.timedOut
    });
  }

  return {
    ok: true,
    value: parseRepositoryStatus(root, status.stdout, status)
  };
}

export function parseRepositoryStatus(root, output, processResult = {}) {
  const branch = {
    current: null,
    detached: false,
    upstream: null,
    ahead: null,
    behind: null,
    trackingAvailable: false
  };
  let changedFiles = 0;
  let untrackedFiles = 0;

  for (const line of String(output || "").split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const current = line.slice("# branch.head ".length);
      branch.detached = current === "(detached)";
      branch.current = branch.detached ? null : current;
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      branch.upstream = line.slice("# branch.upstream ".length);
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const ahead = line.match(/\+(\d+)/);
      const behind = line.match(/-(\d+)/);
      branch.ahead = ahead ? Number(ahead[1]) : 0;
      branch.behind = behind ? Number(behind[1]) : 0;
      branch.trackingAvailable = true;
      continue;
    }
    if (/^[12u?] /.test(line)) {
      changedFiles += 1;
      if (line.startsWith("? ")) untrackedFiles += 1;
    }
  }

  return {
    rootId: root.id,
    name: root.name,
    branch,
    status: {
      dirty: changedFiles > 0,
      clean: changedFiles === 0,
      changedFiles,
      untrackedFiles,
      truncated: Boolean(processResult.truncated)
    }
  };
}

function canonicalPath(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function safeRootName(root) {
  return path.basename(root) || "workspace";
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function inputFailure(code, message, details = {}) {
  return { ok: false, code, message, details };
}
