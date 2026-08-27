import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PLUGIN_CONTENT_HASH_VERSION = "agentshell.plugin-content-hash.v1";

export const DEFAULT_PLUGIN_CONTENT_PATHS = Object.freeze([
  ".codex-plugin",
  "bin/agentshell",
  "bin/agentshell-mcp",
  "skills",
  "src",
  "schemas",
  "scripts",
  "package.json"
]);

export const PLUGIN_CONTENT_EXCLUDED_NAMES = Object.freeze([
  ".DS_Store",
  ".agentshell",
  ".git",
  "artifacts",
  "coverage",
  "dist",
  "node_modules",
  "reports",
  "tmp"
]);

const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_SMOKE_TIMEOUT_MS = 5_000;
const REQUIRED_INSTALLED_PATHS = Object.freeze([
  ".codex-plugin/plugin.json",
  "bin/agentshell",
  "skills/agentshell/SKILL.md",
  "src/cli.js"
]);

export function pluginContentHash(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  const includePaths = normalizeIncludePaths(options.includePaths || DEFAULT_PLUGIN_CONTENT_PATHS);
  const excludedNames = new Set(options.excludedNames || PLUGIN_CONTENT_EXCLUDED_NAMES);
  const maxFiles = positiveInteger(options.maxFiles, DEFAULT_MAX_FILES);
  const entries = [];

  for (const relativePath of includePaths) {
    collectEntries(resolvedRoot, relativePath, entries, excludedNames, maxFiles);
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));

  const hash = crypto.createHash("sha256");
  let totalBytes = 0;
  for (const entry of entries) {
    hash.update(entry.kind);
    hash.update("\0");
    hash.update(entry.path);
    hash.update("\0");
    if (entry.kind === "file") {
      const content = fs.readFileSync(entry.absolutePath);
      totalBytes += content.length;
      hash.update(content);
    } else {
      hash.update(entry.value || "");
    }
    hash.update("\0");
  }

  return {
    protocolVersion: PLUGIN_CONTENT_HASH_VERSION,
    algorithm: "sha256",
    hash: `sha256:${hash.digest("hex")}`,
    fileCount: entries.filter((entry) => entry.kind === "file").length,
    totalBytes,
    missingPaths: entries.filter((entry) => entry.kind === "missing").map((entry) => entry.path),
    includePaths,
    excludedNames: [...excludedNames].sort()
  };
}

export function comparePluginContent(sourceRoot, installedRoot, options = {}) {
  const source = pluginContentHash(sourceRoot, options);
  const installed = pluginContentHash(installedRoot, options);
  return {
    protocolVersion: PLUGIN_CONTENT_HASH_VERSION,
    comparable: true,
    matches: source.hash === installed.hash,
    source,
    installed
  };
}

export function installedPluginSmoke(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  const missingPaths = REQUIRED_INSTALLED_PATHS.filter((relativePath) => !fs.existsSync(path.join(resolvedRoot, relativePath)));
  const skillPath = path.join(resolvedRoot, "skills", "agentshell", "SKILL.md");
  const commandPath = path.join(resolvedRoot, "bin", "agentshell");
  const skill = inspectSkill(skillPath);
  const command = missingPaths.includes("bin/agentshell")
    ? { ok: false, protocolVersion: null, error: "Installed bin/agentshell is missing." }
    : runInstalledManual(commandPath, options);

  return {
    ok: missingPaths.length === 0 && skill.ok && command.ok,
    missingPaths,
    skill,
    command
  };
}

function inspectSkill(file) {
  try {
    const source = readSkillBundle(file);
    const guidance = {
      startCompact: source.includes("agentshell start --compact"),
      verifyTest: source.includes("agentshell verify test"),
      compactSearch: source.includes("agentshell grep <query> --compact")
    };
    const missing = Object.entries(guidance).filter(([, present]) => !present).map(([name]) => name);
    return {
      ok: missing.length === 0,
      path: file,
      guidance,
      missing
    };
  } catch (error) {
    return { ok: false, path: file, guidance: {}, missing: ["SKILL.md"], error: error.message };
  }
}

function readSkillBundle(file) {
  const sources = [fs.readFileSync(file, "utf8")];
  const references = path.join(path.dirname(file), "references");
  if (!fs.existsSync(references)) return sources[0];
  for (const entry of fs.readdirSync(references, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      sources.push(fs.readFileSync(path.join(references, entry.name), "utf8"));
    }
  }
  return sources.join("\n");
}

function runInstalledManual(commandPath, options) {
  const runner = options.runner || spawnSync;
  const timeout = positiveInteger(options.timeoutMs, DEFAULT_SMOKE_TIMEOUT_MS);
  const temporaryCwd = options.cwd ? null : fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-plugin-smoke-"));
  const cwd = options.cwd || temporaryCwd;
  let result;
  try {
    result = runner(commandPath, ["manual"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      maxBuffer: 256 * 1024,
      timeout
    }) || {};
  } catch (error) {
    return { ok: false, protocolVersion: null, error: compactError(error.message) };
  } finally {
    if (temporaryCwd) fs.rmSync(temporaryCwd, { recursive: true, force: true });
  }

  let output = null;
  try {
    output = JSON.parse(result.stdout || "");
  } catch {
    // The bounded error below is enough; do not expose raw installed command output.
  }
  const protocolVersion = output?.protocolVersion || null;
  const ok = result.status === 0 && output?.ok === true && protocolVersion === "agentshell.manual.v1";
  return {
    ok,
    protocolVersion,
    exitCode: Number.isInteger(result.status) ? result.status : null,
    ...(ok ? {} : { error: compactError(output?.error?.message || result.error?.message || "Installed manual smoke returned invalid JSON or protocol.") })
  };
}

function compactError(value) {
  return String(value).replace(/\s+/gu, " ").trim().slice(0, 240);
}

function collectEntries(root, relativePath, entries, excludedNames, maxFiles) {
  const normalized = normalizeRelativePath(relativePath);
  const target = path.join(root, normalized);
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      entries.push({ kind: "missing", path: normalized, value: "missing" });
      return;
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    entries.push({ kind: "symlink", path: normalized, value: fs.readlinkSync(target) });
    return;
  }
  if (stat.isFile()) {
    entries.push({ kind: "file", path: normalized, absolutePath: target });
    assertWithinFileLimit(entries, maxFiles);
    return;
  }
  if (!stat.isDirectory()) return;

  const children = fs.readdirSync(target, { withFileTypes: true })
    .filter((entry) => !excludedNames.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  if (children.length === 0) entries.push({ kind: "directory", path: normalized, value: "empty" });
  for (const child of children) {
    collectEntries(root, path.posix.join(normalized, child.name), entries, excludedNames, maxFiles);
  }
}

function assertWithinFileLimit(entries, maxFiles) {
  const fileCount = entries.filter((entry) => entry.kind === "file").length;
  if (fileCount > maxFiles) {
    throw new Error(`Plugin content exceeds the ${maxFiles} file digest limit.`);
  }
}

function normalizeIncludePaths(values) {
  return [...new Set(values.map(normalizeRelativePath))].sort((left, right) => left.localeCompare(right, "en"));
}

function normalizeRelativePath(value) {
  const normalized = String(value).replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`Invalid plugin content path: ${value}`);
  }
  return normalized;
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
