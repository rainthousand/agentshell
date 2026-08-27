#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
export const RELEASE_SOURCE_AUDIT_PROTOCOL_VERSION = "agentshell.release-source-audit.v1";

export const RUNTIME_DELIVERY_MANIFEST = Object.freeze({
  exact: Object.freeze([
    ".codex-plugin/plugin.json",
    "assets/agentshell-icon.png",
    "assets/agentshell-logo.png",
    "CHANGELOG.md",
    "LICENSE",
    "README.md",
    "package.json",
    "bin/agentshell",
    "desktop/macos/dist/AgentShell Dashboard.app/Contents/Info.plist",
    "desktop/macos/dist/AgentShell Dashboard.app/Contents/MacOS/AgentShellDashboard",
    "desktop/macos/dist/AgentShell Dashboard.app/Contents/PkgInfo",
    "scripts/install-agent-policy.js",
    "scripts/install-codex-plugin.js",
    "scripts/install-for-codex-user.js",
    "scripts/plugin-lifecycle.js",
    "scripts/plugin-smoke.js",
    "scripts/strategy-coverage-matrix.js",
    "src/cli-runtime.js",
    "src/cli.js"
  ]),
  prefixes: Object.freeze([
    "schemas/",
    "skills/agentshell/",
    "src/commands/",
    "src/core/",
    "src/dashboard/",
    "src/strategies/"
  ]),
  excludedPrefixes: Object.freeze([
    "assets/marketing/",
    "docs/",
    "examples/",
    "src/mcp/",
    "tests/"
  ]),
  excludedExact: Object.freeze(["bin/agentshell-mcp"]),
  generated: Object.freeze(["bin/agentshell-darwin-arm64"])
});

if (process.argv[1] === import.meta.filename) {
  const report = auditReleaseSource(root);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

export function auditReleaseSource(projectRoot = root, options = {}) {
  const manifest = options.manifest || RUNTIME_DELIVERY_MANIFEST;
  const trackedResult = options.trackedFiles
    ? { ok: true, files: normalizeFiles(options.trackedFiles), error: null }
    : readTrackedFiles(projectRoot);
  const worktreeFiles = options.worktreeFiles
    ? normalizeFiles(options.worktreeFiles)
    : listWorktreeFiles(projectRoot);
  const trackedSet = new Set(trackedResult.files);
  const includedTrackedFiles = trackedResult.files.filter((file) => isRuntimeDeliveryPath(file, manifest));
  const includedWorktreeFiles = worktreeFiles.filter((file) => isRuntimeDeliveryPath(file, manifest));
  const untrackedIncludedFiles = options.allowUntracked
    ? []
    : includedWorktreeFiles.filter((file) => !trackedSet.has(file));
  const missingRequiredFiles = manifest.exact.filter((file) => !fs.existsSync(path.join(projectRoot, file)));
  const untrackedRequiredFiles = options.allowUntracked
    ? []
    : manifest.exact.filter((file) => fs.existsSync(path.join(projectRoot, file)) && !trackedSet.has(file));
  const generatedMissing = manifest.generated.filter((file) => !fs.existsSync(path.join(projectRoot, file)));
  const mcpLeaks = [...new Set([...includedTrackedFiles, ...includedWorktreeFiles])]
    .filter((file) => isExcludedPath(file, manifest));
  const ok = trackedResult.ok
    && missingRequiredFiles.length === 0
    && untrackedRequiredFiles.length === 0
    && untrackedIncludedFiles.length === 0
    && generatedMissing.length === 0
    && mcpLeaks.length === 0;

  return {
    ok,
    protocolVersion: RELEASE_SOURCE_AUDIT_PROTOCOL_VERSION,
    source: options.trackedFiles ? "fixture" : "git-ls-files",
    summary: {
      trackedFiles: trackedResult.files.length,
      deliveryFiles: includedTrackedFiles.length + manifest.generated.length,
      untrackedIncludedFiles: untrackedIncludedFiles.length,
      missingRequiredFiles: missingRequiredFiles.length,
      generatedMissing: generatedMissing.length,
      mcpLeaks: mcpLeaks.length
    },
    deliveryFiles: [...new Set([
      ...includedTrackedFiles,
      ...(options.allowUntracked ? includedWorktreeFiles : []),
      ...manifest.generated
    ])].sort(),
    untrackedIncludedFiles,
    untrackedRequiredFiles,
    missingRequiredFiles,
    generatedMissing,
    mcpLeaks,
    gitError: trackedResult.error
  };
}

export function isRuntimeDeliveryPath(relativePath, manifest = RUNTIME_DELIVERY_MANIFEST) {
  const file = normalizePath(relativePath);
  if (!file || isExcludedPath(file, manifest)) return false;
  return manifest.exact.includes(file) || manifest.prefixes.some((prefix) => file.startsWith(prefix));
}

function isExcludedPath(file, manifest) {
  return manifest.excludedExact.includes(file)
    || manifest.excludedPrefixes.some((prefix) => file.startsWith(prefix));
}

function readTrackedFiles(projectRoot) {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: projectRoot, encoding: "buffer" });
  if (result.status !== 0) {
    return {
      ok: false,
      files: [],
      error: String(result.stderr || result.error?.message || "git ls-files failed").trim()
    };
  }
  return { ok: true, files: normalizeFiles(result.stdout.toString("utf8").split("\0")), error: null };
}

function listWorktreeFiles(projectRoot) {
  const files = [];
  walk(projectRoot, "", files);
  return files.sort();
}

function walk(projectRoot, relativeDir, files) {
  const directory = path.join(projectRoot, relativeDir);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if ([".git", ".agentshell", "artifacts", "node_modules"].includes(entry.name)) continue;
    const relativePath = normalizePath(path.join(relativeDir, entry.name));
    if (entry.isDirectory()) walk(projectRoot, relativePath, files);
    else if (entry.isFile()) files.push(relativePath);
  }
}

function normalizeFiles(files) {
  return [...new Set(files.map(normalizePath).filter(Boolean))].sort();
}

function normalizePath(file) {
  return String(file || "").replaceAll(path.sep, "/").replace(/^\.\//, "");
}
