import fs from "node:fs";
import path from "node:path";

import { boundedProcessOptions, runBoundedProcess } from "./bounded-process.js";
import { resolveExplicitRoots } from "./workspace-guard.js";

const DEFAULT_MAX_MATCHES = 40;
const DEFAULT_MAX_MATCHES_PER_ROOT = 12;
const DEFAULT_MAX_MATCHES_PER_FILE = 3;
const DEFAULT_PREVIEW_CHARS = 180;
const MAX_SEARCH_OUTPUT_BYTES = 384 * 1024;
const MAX_VISITED_FILES = 20_000;
const MAX_FALLBACK_FILE_BYTES = 1024 * 1024;
const MAX_FALLBACK_OBSERVED_MATCHES = 2_000;
const FALLBACK_YIELD_EVERY_LINES = 256;
const IGNORED_DIRS = new Set([
  ".agentshell", ".cache", ".git", ".gradle", ".next", ".turbo", ".venv",
  "__pycache__", "build", "coverage", "dist", "generated", "node_modules", "out",
  "target", "vendor", "venv"
]);

export async function searchAcrossRoots(roots, query, options = {}) {
  const resolved = resolveExplicitRoots(roots, options);
  if (!resolved.ok) return resolved;
  if (!options.fixedStrings) {
    try {
      new RegExp(query);
    } catch {
      return inputFailure("INVALID_QUERY", "Search query is not a valid regular expression", {
        mode: "regex"
      });
    }
  }

  const limits = {
    maxMatches: boundedInteger(options.maxMatches, DEFAULT_MAX_MATCHES, 1, 200),
    maxMatchesPerRoot: boundedInteger(options.maxMatchesPerRoot, DEFAULT_MAX_MATCHES_PER_ROOT, 1, 50),
    maxMatchesPerFile: boundedInteger(options.maxMatchesPerFile, DEFAULT_MAX_MATCHES_PER_FILE, 1, 20),
    previewChars: boundedInteger(options.previewChars, DEFAULT_PREVIEW_CHARS, 40, 500)
  };
  const searched = await Promise.all(resolved.roots.map((root) => searchRoot(root, query, limits, options)));
  const failure = searched.find((entry) => !entry.ok);
  if (failure) return failure;

  const allocated = allocateFairly(searched.map((entry) => entry.value), limits);
  return {
    ok: true,
    maxRoots: resolved.maxRoots,
    limits,
    roots: allocated,
    observedMatches: sum(allocated.map((entry) => entry.observedMatches)),
    returnedMatches: sum(allocated.map((entry) => entry.matches.length)),
    truncated: allocated.some((entry) => entry.truncated)
  };
}

async function searchRoot(root, query, limits, options) {
  const timeoutMs = boundedProcessOptions({ timeoutMs: options.timeoutMs }).timeoutMs;
  const deadlineMs = Date.now() + timeoutMs;
  const args = [
    "rg", "--json", "--line-number", "--column", "--no-heading", "--color", "never"
  ];
  if (options.fixedStrings) args.push("--fixed-strings");
  if (options.caseSensitive === false) args.push("--ignore-case");
  for (const ignored of IGNORED_DIRS) {
    args.push("--glob", `!${ignored}/**`, "--glob", `!**/${ignored}/**`);
  }
  args.push("--", query, ".");

  const processResult = await runBoundedProcess(args, root.path, {
    timeoutMs,
    maxOutputBytes: MAX_SEARCH_OUTPUT_BYTES
  });
  if (processResult.spawnError === "ENOENT") {
    return fallbackSearch(root, query, limits, { ...options, deadlineMs });
  }
  if (![0, 1].includes(processResult.exitCode)) {
    return inputFailure("SEARCH_FAILED", "Search failed in one workspace root", {
      rootId: root.id,
      name: root.name,
      timedOut: processResult.timedOut
    });
  }

  const parsed = parseRipgrepJson(processResult.stdout, limits);
  return {
    ok: true,
    value: {
      rootId: root.id,
      name: root.name,
      engine: "rg",
      observedMatches: parsed.observedMatches,
      candidates: parsed.matches,
      sourceTruncated: processResult.truncated || parsed.truncated
    }
  };
}

export function parseRipgrepJson(output, limits = {}) {
  const maxMatchesPerFile = limits.maxMatchesPerFile || DEFAULT_MAX_MATCHES_PER_FILE;
  const previewChars = limits.previewChars || DEFAULT_PREVIEW_CHARS;
  const matches = [];
  let observedMatches = 0;

  for (const line of String(output || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type !== "match") continue;
      observedMatches += 1;
      const file = normalizeRelativeFile(event.data.path?.text || "");
      const submatch = event.data.submatches?.[0];
      matches.push({
        file,
        line: event.data.line_number,
        column: typeof submatch?.start === "number" ? submatch.start + 1 : 1,
        preview: sanitizePreview(event.data.lines?.text || "", previewChars)
      });
    } catch {
      // Malformed partial events are ignored; bounded results remain usable.
    }
  }

  const ordered = matches.sort(compareCandidate);
  const bounded = limitMatchesPerFile(ordered, maxMatchesPerFile);
  return {
    matches: bounded,
    observedMatches,
    truncated: bounded.length < observedMatches
  };
}

export async function fallbackSearch(root, query, limits, options) {
  let matcher;
  try {
    matcher = options.fixedStrings
      ? literalMatcher(query, options.caseSensitive !== false)
      : new RegExp(query, options.caseSensitive === false ? "i" : "");
  } catch {
    return inputFailure("INVALID_QUERY", "Search query is not a valid regular expression", {
      mode: "regex"
    });
  }

  const candidates = [];
  const perFile = new Map();
  let observedMatches = 0;
  let visitedFiles = 0;
  let traversalTruncated = false;
  let contentSkipped = false;
  const deadlineMs = Number.isFinite(options.deadlineMs)
    ? options.deadlineMs
    : Date.now() + boundedProcessOptions({ timeoutMs: options.timeoutMs }).timeoutMs;

  function timedOut() {
    return Date.now() >= deadlineMs;
  }

  function timeoutFailure() {
    return inputFailure("SEARCH_TIMEOUT", "Search timed out in one workspace root", {
      rootId: root.id,
      name: root.name,
      engine: "node-fallback",
      timedOut: true,
      visitedFiles
    });
  }

  async function inspectFile(absolute) {
    let text;
    try {
      if ((await fs.promises.stat(absolute)).size > MAX_FALLBACK_FILE_BYTES) {
        contentSkipped = true;
        return;
      }
      if (timedOut()) return;
      const buffer = await fs.promises.readFile(absolute);
      if (buffer.includes(0)) return;
      text = buffer.toString("utf8");
    } catch {
      return;
    }
    const relative = normalizeRelativeFile(path.relative(root.path, absolute));
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (index > 0 && index % FALLBACK_YIELD_EVERY_LINES === 0) {
        await yieldToEventLoop();
      }
      if (timedOut()) return;
      const match = matcher(line);
      if (!match) continue;
      observedMatches += 1;
      if (observedMatches >= MAX_FALLBACK_OBSERVED_MATCHES) {
        traversalTruncated = true;
      }
      const count = perFile.get(relative) || 0;
      if (count >= limits.maxMatchesPerFile) continue;
      perFile.set(relative, count + 1);
      candidates.push({
        file: relative,
        line: index + 1,
        column: match.index + 1,
        preview: sanitizePreview(line, limits.previewChars)
      });
      if (traversalTruncated) return;
    }
  }

  const directories = [root.path];
  let directoryIndex = 0;
  while (directoryIndex < directories.length && !traversalTruncated) {
    if (timedOut()) return timeoutFailure();
    const directory = directories[directoryIndex];
    directoryIndex += 1;
    let entries;
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      if (timedOut()) return timeoutFailure();
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      visitedFiles += 1;
      if (visitedFiles > MAX_VISITED_FILES) {
        traversalTruncated = true;
        break;
      }
      await inspectFile(absolute);
      if (timedOut()) return timeoutFailure();
    }
  }
  return {
    ok: true,
    value: {
      rootId: root.id,
      name: root.name,
      engine: "node-fallback",
      observedMatches,
      candidates: candidates.sort(compareCandidate),
      sourceTruncated: traversalTruncated || contentSkipped || candidates.length < observedMatches
    }
  };
}

function allocateFairly(roots, limits) {
  const orderedRoots = roots.map((root) => ({
    ...root,
    candidates: [...root.candidates].sort(compareCandidate)
  }));
  const selected = roots.map(() => []);
  let returned = 0;
  let round = 0;

  while (returned < limits.maxMatches) {
    let added = false;
    for (let index = 0; index < orderedRoots.length && returned < limits.maxMatches; index += 1) {
      if (round >= limits.maxMatchesPerRoot) continue;
      const candidate = orderedRoots[index].candidates[round];
      if (!candidate) continue;
      selected[index].push(candidate);
      returned += 1;
      added = true;
    }
    if (!added || round + 1 >= limits.maxMatchesPerRoot) break;
    round += 1;
  }

  return orderedRoots.map((root, index) => {
    const omittedMatches = Math.max(0, root.observedMatches - selected[index].length);
    const truncated = root.sourceTruncated || omittedMatches > 0;
    return {
      rootId: root.rootId,
      name: root.name,
      engine: root.engine,
      observedMatches: root.observedMatches,
      returnedMatches: selected[index].length,
      omittedMatches,
      matches: selected[index],
      truncated
    };
  });
}

function compareCandidate(left, right) {
  return compareText(left.file, right.file)
    || left.line - right.line
    || left.column - right.column
    || compareText(left.preview, right.preview);
}

function compareText(left, right) {
  const first = String(left);
  const second = String(right);
  return first < second ? -1 : first > second ? 1 : 0;
}

function limitMatchesPerFile(matches, maximum) {
  const counts = new Map();
  return matches.filter((match) => {
    const count = counts.get(match.file) || 0;
    if (count >= maximum) return false;
    counts.set(match.file, count + 1);
    return true;
  });
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function sanitizePreview(value, limit) {
  let text = String(value || "").trimEnd();
  text = text.replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s"']+/gi, "$1[REDACTED]");
  text = text.replace(/((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)[^\s,;"']+/gi, "$1[REDACTED]");
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function literalMatcher(query, caseSensitive) {
  const needle = caseSensitive ? query : query.toLowerCase();
  return (line) => {
    const haystack = caseSensitive ? line : line.toLowerCase();
    const index = haystack.indexOf(needle);
    return index < 0 ? null : { index };
  };
}

function normalizeRelativeFile(value) {
  return String(value).replace(/^\.\//, "").split(path.sep).join("/");
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function inputFailure(code, message, details = {}) {
  return { ok: false, code, message, details };
}
