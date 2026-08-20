import fs from "node:fs";
import path from "node:path";

import { fail } from "../core/output.js";
import { resolveInsideWorkspace } from "../core/workspace.js";

const PROTOCOL_VERSION = "agentshell.ls.v1";
const DEFAULT_COMPACT_LIMIT = 80;
const MAX_LIMIT = 500;
const GENERATED_NAMES = new Set(["build", "coverage", "dist", "generated", "node_modules", "out", "target", "vendor"]);
const TEST_NAMES = new Set(["__tests__", "spec", "test", "tests"]);

export async function listDirectory(root, target = ".", options = {}) {
  if (target && typeof target === "object") {
    options = target;
    target = ".";
  }
  const compact = options.compact === undefined ? true : Boolean(options.compact);
  const limit = Math.min(positiveInteger(options.limit, compact ? DEFAULT_COMPACT_LIMIT : MAX_LIMIT), MAX_LIMIT);
  const resolved = resolveInsideWorkspace(root, target || ".");
  if (!resolved.ok) return fail(resolved.reason, `Cannot list ${target}`);
  if (!fs.existsSync(resolved.absTarget)) return fail("PATH_NOT_FOUND", `Path not found: ${target}`);
  if (!fs.statSync(resolved.absTarget).isDirectory()) return fail("NOT_A_DIRECTORY", `Not a directory: ${target}`);

  let dirents;
  try {
    dirents = fs.readdirSync(resolved.absTarget, { withFileTypes: true });
  } catch (error) {
    return fail("DIRECTORY_READ_FAILED", `Unable to list directory: ${target}`, { code: error.code || "UNKNOWN" });
  }

  const allEntries = dirents.map((entry) => summarizeEntry(resolved.absTarget, entry))
    .sort(compareEntry);
  const entries = allEntries.slice(0, limit);
  const manifests = allEntries.filter((entry) => entry.manifest).map((entry) => entry.name);
  const tests = allEntries.filter((entry) => entry.test).map((entry) => entry.name);
  const generated = allEntries.filter((entry) => entry.generated).map((entry) => entry.name);

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact,
    path: resolved.relative || ".",
    summary: {
      totalEntries: allEntries.length,
      returnedEntries: entries.length,
      truncated: entries.length < allEntries.length,
      files: allEntries.filter((entry) => entry.kind === "file").length,
      directories: allEntries.filter((entry) => entry.kind === "directory").length,
      symlinks: allEntries.filter((entry) => entry.kind === "symlink").length,
      hidden: allEntries.filter((entry) => entry.hidden).length,
      important: allEntries.filter((entry) => entry.important).length,
      manifests,
      tests,
      generated
    },
    entries,
    suggestedNextActions: suggestedNextActions(resolved.relative || ".", manifests, tests, generated)
  };
}

export const ls = listDirectory;

function summarizeEntry(directory, entry) {
  const absolutePath = path.join(directory, entry.name);
  let sizeBytes = null;
  try {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isFile()) sizeBytes = stat.size;
  } catch {
    // Keep the entry visible even when its metadata cannot be read.
  }
  const kind = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other";
  const manifest = isManifest(entry.name);
  const test = TEST_NAMES.has(entry.name.toLowerCase()) || /\.(test|spec)\.[^.]+$/i.test(entry.name) || /_test\.go$/i.test(entry.name);
  const generated = GENERATED_NAMES.has(entry.name.toLowerCase()) || /\.min\.(js|css)$/i.test(entry.name);
  const important = manifest || test || isImportant(entry.name, kind);
  return {
    name: entry.name,
    kind,
    sizeBytes,
    hidden: entry.name.startsWith("."),
    important,
    manifest,
    test,
    generated
  };
}

function compareEntry(left, right) {
  const score = (entry) => entry.important ? 0 : entry.hidden ? 2 : 1;
  return score(left) - score(right)
    || (left.kind === "directory" ? 0 : 1) - (right.kind === "directory" ? 0 : 1)
    || left.name.localeCompare(right.name);
}

function isManifest(name) {
  return /^(package\.json|go\.(mod|work)|pyproject\.toml|requirements.*\.txt|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|Cargo\.toml|Makefile|Dockerfile)$/i.test(name);
}

function isImportant(name, kind) {
  if (kind === "directory") return /^(src|lib|app|cmd|internal|pkg|docs?|scripts?)$/i.test(name);
  return /^(README|AGENTS|CODEX|CHANGELOG|LICENSE)(\.|$)/i.test(name) || /^(main|index|cli)\.[^.]+$/i.test(name);
}

function suggestedNextActions(currentPath, manifests, tests, generated) {
  const actions = [];
  if (manifests.length > 0) {
    const manifestPath = currentPath === "." ? manifests[0] : `${currentPath}/${manifests[0]}`;
    actions.push({ command: `agentshell read ${quotePath(manifestPath)} --lines 1:120`, reason: "Inspect the nearest project manifest" });
  }
  if (tests.length > 0) actions.push({ command: "agentshell test list --compact", reason: "Summarize discovered test entry points" });
  if (generated.length > 0) actions.push({ command: "agentshell du --compact", reason: "Inspect generated-directory size before reading its contents" });
  if (actions.length === 0) actions.push({ command: "agentshell tree --compact", reason: "Inspect the broader project structure" });
  return actions;
}

function quotePath(filePath) {
  return /^[A-Za-z0-9_./-]+$/.test(filePath) ? filePath : JSON.stringify(filePath);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
