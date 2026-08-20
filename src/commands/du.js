import fs from "node:fs";
import path from "node:path";

import { fail } from "../core/output.js";

const PROTOCOL_VERSION = "agentshell.du.v1";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_MAX_DEPTH = 8;
const MAX_DEPTH = 20;
const DEFAULT_MAX_SCANNED_ENTRIES = 5000;
const MAX_SCANNED_ENTRIES = 25000;

const GENERATED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".parcel-cache",
  ".pytest_cache",
  ".turbo",
  ".vite",
  "__pycache__",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "tmp",
  "temp",
  "vendor"
]);

export async function du(root, options = {}) {
  const projectRoot = path.resolve(root);
  const target = resolveTarget(projectRoot, options.path || ".");
  if (!target.ok) return target.error;

  const limit = boundedInteger(options.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const maxDepth = boundedInteger(options.maxDepth, DEFAULT_MAX_DEPTH, 1, MAX_DEPTH);
  const maxScannedEntries = boundedInteger(
    options.maxScannedEntries,
    DEFAULT_MAX_SCANNED_ENTRIES,
    100,
    MAX_SCANNED_ENTRIES
  );
  const state = {
    scannedEntries: 0,
    fileCount: 0,
    directoryCount: 0,
    excludedCount: 0,
    unreadableCount: 0,
    truncated: false,
    files: [],
    directories: [],
    excluded: []
  };

  const totalSizeBytes = scanDirectory(target.absTarget, target.relative, 0, state, {
    maxDepth,
    maxScannedEntries
  });
  const largestFiles = state.files.sort(bySizeDescending).slice(0, limit);
  const largestDirectories = state.directories
    .filter((entry) => entry.path !== target.relative)
    .sort(bySizeDescending)
    .slice(0, limit);
  const excluded = state.excluded.slice(0, limit);

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: options.compact === undefined ? true : Boolean(options.compact),
    root: {
      path: target.relative,
      absolutePath: target.absTarget
    },
    summary: {
      totalSizeBytes,
      totalSize: formatBytes(totalSizeBytes),
      fileCount: state.fileCount,
      directoryCount: state.directoryCount,
      excludedCount: state.excludedCount,
      unreadableCount: state.unreadableCount,
      scannedEntries: state.scannedEntries,
      maxDepth,
      tokenNoiseRisk: tokenNoiseRisk(totalSizeBytes)
    },
    largestDirectories,
    largestFiles,
    excluded,
    truncated: state.truncated || state.excluded.length > excluded.length,
    suggestedNextActions: suggestedNextActions(largestFiles, excluded, state.truncated)
  };
}

export const diskUsage = du;

function resolveTarget(projectRoot, requestedPath) {
  const absTarget = path.resolve(projectRoot, requestedPath);
  const relative = path.relative(projectRoot, absTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return {
      ok: false,
      error: fail("PATH_OUTSIDE_WORKSPACE", "Disk usage target must stay inside the workspace", {
        path: requestedPath
      })
    };
  }
  if (!fs.existsSync(absTarget)) {
    return {
      ok: false,
      error: fail("PATH_NOT_FOUND", "Disk usage target does not exist", { path: requestedPath })
    };
  }
  let stat;
  try {
    stat = fs.statSync(absTarget);
  } catch (error) {
    return {
      ok: false,
      error: fail("PATH_UNREADABLE", "Disk usage target cannot be read", {
        path: requestedPath,
        code: error.code || "UNKNOWN"
      })
    };
  }
  if (!stat.isDirectory()) {
    return {
      ok: false,
      error: fail("PATH_NOT_DIRECTORY", "Disk usage target must be a directory", { path: requestedPath })
    };
  }
  return {
    ok: true,
    absTarget,
    relative: relative ? toPosix(relative) : "."
  };
}

function scanDirectory(directory, relativeDirectory, depth, state, limits) {
  if (depth > limits.maxDepth) {
    state.truncated = true;
    return 0;
  }

  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    state.unreadableCount += 1;
    addExcluded(state, relativeDirectory, "unreadable", error.code || "UNKNOWN");
    return 0;
  }

  let sizeBytes = 0;
  for (const entry of entries) {
    if (state.scannedEntries >= limits.maxScannedEntries) {
      state.truncated = true;
      break;
    }
    state.scannedEntries += 1;
    const relativePath = relativeDirectory === "."
      ? entry.name
      : `${relativeDirectory}/${entry.name}`;
    const fullPath = path.join(directory, entry.name);

    if (entry.isSymbolicLink()) {
      addExcluded(state, relativePath, "symbolic-link", null);
      continue;
    }
    if (entry.isDirectory()) {
      state.directoryCount += 1;
      if (GENERATED_DIRECTORIES.has(entry.name)) {
        addExcluded(state, relativePath, "generated-noise", null);
        continue;
      }
      if (depth >= limits.maxDepth) {
        state.truncated = true;
        addExcluded(state, relativePath, "max-depth", null);
        continue;
      }
      const childSize = scanDirectory(fullPath, relativePath, depth + 1, state, limits);
      sizeBytes += childSize;
      continue;
    }
    if (!entry.isFile()) continue;

    try {
      const fileSize = fs.statSync(fullPath).size;
      state.fileCount += 1;
      sizeBytes += fileSize;
      state.files.push(sizeEntry(relativePath, fileSize, "file"));
    } catch (error) {
      state.unreadableCount += 1;
      addExcluded(state, relativePath, "unreadable", error.code || "UNKNOWN");
    }
  }

  state.directories.push(sizeEntry(relativeDirectory, sizeBytes, "directory"));
  return sizeBytes;
}

function addExcluded(state, relativePath, reason, code) {
  state.excludedCount += 1;
  state.excluded.push({
    path: toPosix(relativePath),
    reason,
    generated: reason === "generated-noise",
    code
  });
}

function sizeEntry(relativePath, sizeBytes, kind) {
  return {
    path: toPosix(relativePath),
    kind,
    sizeBytes,
    size: formatBytes(sizeBytes),
    tokenNoiseRisk: tokenNoiseRisk(sizeBytes)
  };
}

function suggestedNextActions(largestFiles, excluded, truncated) {
  const actions = [];
  const noisyFile = largestFiles.find((entry) => entry.tokenNoiseRisk === "high");
  if (noisyFile) {
    actions.push({
      command: `agentshell file info ${shellQuote(noisyFile.path)} --compact`,
      reason: "Inspect the largest high-noise file without reading its contents"
    });
  }
  if (excluded.some((entry) => entry.generated)) {
    actions.push({
      command: "agentshell tree --compact",
      reason: "Inspect project structure while keeping generated directories excluded"
    });
  }
  if (truncated) {
    actions.push({
      command: "agentshell du --compact --max-scanned-entries 10000",
      reason: "Increase the bounded scan only if a wider disk summary is needed"
    });
  }
  if (actions.length === 0) {
    actions.push({
      command: "agentshell files changed --compact",
      reason: "Disk usage is bounded; inspect the active change set next"
    });
  }
  return actions.slice(0, 3);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) return fallback;
  return Math.min(number, maximum);
}

function bySizeDescending(left, right) {
  return right.sizeBytes - left.sizeBytes || left.path.localeCompare(right.path);
}

function tokenNoiseRisk(sizeBytes) {
  if (sizeBytes >= 1024 * 1024) return "high";
  if (sizeBytes >= 64 * 1024) return "medium";
  return "low";
}

function formatBytes(sizeBytes) {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KiB`;
  if (sizeBytes < 1024 * 1024 * 1024) return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function toPosix(value) {
  return String(value).split(path.sep).join("/");
}
