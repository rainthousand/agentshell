import fs from "node:fs";
import path from "node:path";

import { fail } from "../core/output.js";
import { resolveInsideWorkspace } from "../core/workspace.js";

const PROTOCOL_VERSION = "agentshell.find-file.v1";
const DEFAULT_COMPACT_LIMIT = 40;
const DEFAULT_FULL_LIMIT = 200;
const MAX_LIMIT = 500;
const DEFAULT_COMPACT_SCAN_LIMIT = 20_000;
const DEFAULT_FULL_SCAN_LIMIT = 100_000;
const MAX_SCAN_LIMIT = 250_000;

const IGNORED_DIRECTORIES = new Set([
  ".agentshell", ".cache", ".git", ".gradle", ".idea", ".mypy_cache",
  ".next", ".nyc_output", ".output", ".pytest_cache", ".ruff_cache",
  ".turbo", ".venv", "__pycache__", "artifacts", "build", "coverage",
  "dist", "external-repos", "node_modules", "out", "reports", "target",
  "temp", "test-results", "tmp", "vendor"
]);

export async function findFile(root, namePattern, options = {}) {
  const parsed = parseFindFileOptions(namePattern, options);
  if (!parsed.ok) return parsed;

  const start = resolveInsideWorkspace(root, parsed.value.path);
  if (!start.ok) return fail(start.reason, `Cannot search ${parsed.value.path}`);
  if (!fs.existsSync(start.absTarget)) {
    return fail("PATH_NOT_FOUND", `Search path not found: ${parsed.value.path}`, {
      path: start.relative || "."
    });
  }
  if (!fs.statSync(start.absTarget).isDirectory()) {
    return fail("NOT_A_DIRECTORY", `Search path is not a directory: ${parsed.value.path}`);
  }

  const matcher = createMatcher(parsed.value.name);
  const state = {
    matches: [],
    totalMatches: 0,
    ignoredDirectories: 0,
    unreadableDirectories: 0,
    scannedEntries: 0,
    scanTruncated: false
  };
  scan(start.absRoot, start.absTarget, matcher, parsed.value.limit, parsed.value.scanLimit, state);
  const files = state.matches.sort(compareMatch);
  const resultTruncated = state.scanTruncated || state.totalMatches > files.length;

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: parsed.value.compact,
    summary: {
      pattern: parsed.value.name,
      searchPath: start.relative || ".",
      totalMatches: state.totalMatches,
      returnedMatches: files.length,
      truncated: resultTruncated,
      ignoredDirectories: state.ignoredDirectories,
      unreadableDirectories: state.unreadableDirectories,
      scannedEntries: state.scannedEntries,
      scanLimit: parsed.value.scanLimit,
      scanTruncated: state.scanTruncated,
      categories: countBy(files, "category"),
      risks: countBy(files, "risk")
    },
    files,
    suggestedNextActions: suggestedNextActions(files, resultTruncated, state.scanTruncated)
  };
}

export function parseFindFileOptions(namePattern, options = {}) {
  if (!namePattern || String(namePattern).startsWith("--")) {
    return fail("INVALID_ARGUMENT", "Usage: agentshell find file --name <pattern> [--path <dir>] [--limit N] --compact");
  }
  const compact = options.compact === undefined ? true : Boolean(options.compact);
  const fallback = compact ? DEFAULT_COMPACT_LIMIT : DEFAULT_FULL_LIMIT;
  const limit = positiveInteger(options.limit, fallback);
  const scanFallback = compact ? DEFAULT_COMPACT_SCAN_LIMIT : DEFAULT_FULL_SCAN_LIMIT;
  const scanLimit = positiveInteger(options.maxEntries ?? options.scanLimit, scanFallback);
  return {
    ok: true,
    value: {
      name: String(namePattern),
      path: options.path ? String(options.path) : ".",
      compact,
      limit: Math.min(limit, MAX_LIMIT),
      scanLimit: Math.min(scanLimit, MAX_SCAN_LIMIT)
    }
  };
}

function scan(root, directory, matcher, limit, scanLimit, state) {
  if (state.scanTruncated) return;
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    state.unreadableDirectories += 1;
    return;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (state.scannedEntries >= scanLimit) {
      state.scanTruncated = true;
      return;
    }
    state.scannedEntries += 1;
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        state.ignoredDirectories += 1;
        continue;
      }
      scan(root, path.join(directory, entry.name), matcher, limit, scanLimit, state);
      if (state.scanTruncated) return;
      continue;
    }
    if (!entry.isFile()) continue;

    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
    if (!matcher(entry.name, relativePath)) continue;
    state.totalMatches += 1;
    if (state.matches.length >= limit) continue;

    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(absolutePath).size;
    } catch {
      continue;
    }
    const category = categoryFor(relativePath);
    state.matches.push({
      path: relativePath,
      name: entry.name,
      category,
      sizeBytes,
      risk: riskFor(relativePath, category, sizeBytes),
      readCommand: `agentshell read ${quotePath(relativePath)} --lines 1:120`
    });
  }
}

function createMatcher(pattern) {
  const normalized = String(pattern).split(path.sep).join("/");
  if (!/[?*]/.test(normalized)) {
    const needle = normalized.toLowerCase();
    return (name, relativePath) => name.toLowerCase().includes(needle)
      || relativePath.toLowerCase().includes(needle);
  }
  const expression = globToRegExp(normalized);
  return (name, relativePath) => expression.test(name) || expression.test(relativePath);
}

function globToRegExp(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[\\^$+?.()|{}\[\]]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "i");
}

function categoryFor(filePath) {
  const name = path.posix.basename(filePath);
  if (/(^|\/)(dist|build|coverage|generated|out)\//i.test(filePath) || /\.min\.(js|css)$/i.test(name)) return "generated";
  if (/(^|\/)(__tests__|tests?|spec|fixtures)(\/|$)/i.test(filePath) || /\.(test|spec)\.[^.]+$/i.test(name) || /_test\.go$/i.test(name)) return "test";
  if (/(^|\/)(docs?)(\/|$)/i.test(filePath) || /^(README|CHANGELOG|LICENSE|NOTICE)/i.test(name) || /\.(md|mdx|rst|adoc)$/i.test(name)) return "docs";
  if (isManifest(name) || /(^|\/)(\.github|config|configs)(\/|$)/i.test(filePath)) return "config";
  if (/\.(js|jsx|mjs|cjs|ts|tsx|go|py|java|kt|rs|rb|php|swift|c|cc|cpp|h|hpp|cs|sh|css|scss|html)$/i.test(name)) return "source";
  if (/\.(png|jpe?g|gif|webp|svg|ico|mp3|mp4|mov|pdf|woff2?|ttf|otf)$/i.test(name)) return "asset";
  return "other";
}

function riskFor(filePath, category, sizeBytes) {
  const name = path.posix.basename(filePath);
  if (/([.]env|secret|credential|private[-_.]?key)/i.test(name) || /(^|\/)(auth|security|permissions?)(\/|$)/i.test(filePath)) return "high";
  if (isManifest(name) || category === "config") return "medium";
  if (sizeBytes > 1024 * 1024) return "medium";
  return "low";
}

function isManifest(name) {
  return /^(package\.json|go\.(mod|work)|pyproject\.toml|requirements.*\.txt|pom\.xml|build\.gradle(?:\.kts)?|Cargo\.toml|Makefile|Dockerfile)$/i.test(name);
}

function compareMatch(left, right) {
  const priority = { source: 0, test: 1, config: 2, docs: 3, other: 4, asset: 5, generated: 6 };
  return (priority[left.category] ?? 9) - (priority[right.category] ?? 9) || left.path.localeCompare(right.path);
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) counts[item[key]] = (counts[item[key]] || 0) + 1;
  return counts;
}

function suggestedNextActions(files, truncated, scanTruncated) {
  const actions = files.slice(0, 3).map((file) => ({
    command: file.readCommand,
    reason: `Inspect matched ${file.category} file`
  }));
  if (scanTruncated) {
    actions.push({
      command: "agentshell find file --name <pattern> --path <source-dir> --compact",
      reason: "The scan-entry limit was reached; narrow the search to a likely source directory"
    });
  } else if (truncated) {
    actions.push({
      command: "agentshell find file --name <pattern> --limit 100 --compact",
      reason: "Increase the bounded result limit only when more matches are needed"
    });
  }
  if (actions.length === 0) actions.push({
    command: "agentshell tree --compact",
    reason: "Inspect the project shape before refining the file-name pattern"
  });
  return actions;
}

function quotePath(filePath) {
  return /^[A-Za-z0-9_./-]+$/.test(filePath) ? filePath : JSON.stringify(filePath);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
