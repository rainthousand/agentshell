import { spawnSync } from "node:child_process";

import { fail } from "../core/output.js";
import { newId, writeLog } from "../core/store.js";

const PROTOCOL_VERSION = "agentshell.git-diff.v1";
const MAX_FILES = 50;
const MAX_HUNKS_PER_FILE = 3;
const LARGE_FILE_CHANGE_LINES = 400;
const LARGE_DIFF_FILES = 20;
const RISKY_PATH_PATTERNS = [
  { code: "lockfile-change", pattern: /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|go\.sum|Cargo\.lock)$/ },
  { code: "generated-output", pattern: /(^|\/)(dist|build|coverage|vendor)\// },
  { code: "binary-change", pattern: null },
  { code: "delete-change", pattern: null },
  { code: "large-file-change", pattern: null }
];

export async function gitDiff(root, options = {}) {
  const mode = options.staged ? "staged" : "unstaged";
  const compact = options.compact === undefined ? true : Boolean(options.compact);
  const scopeArgs = options.staged ? ["--cached"] : [];

  if (!isGitRepository(root)) {
    return fail("NOT_GIT_REPOSITORY", "Current directory is not inside a git repository", {
      command: "git rev-parse --is-inside-work-tree",
      suggestedNextActions: [
        {
          command: "git init",
          reason: "Initialize a repository before asking AgentShell to summarize git diffs"
        }
      ]
    });
  }

  const numstat = runGit(root, ["diff", ...scopeArgs, "--numstat", "--find-renames"]);
  const nameStatus = runGit(root, ["diff", ...scopeArgs, "--name-status", "--find-renames"]);
  const stat = runGit(root, ["diff", ...scopeArgs, "--stat", "--find-renames"]);
  const rawDiff = runGit(root, ["diff", ...scopeArgs, "--unified=0", "--find-renames"]);

  if (numstat.status !== 0 || nameStatus.status !== 0 || stat.status !== 0 || rawDiff.status !== 0) {
    return fail("GIT_DIFF_FAILED", "Unable to summarize git diff", {
      mode,
      stderr: firstNonEmpty([numstat.stderr, nameStatus.stderr, stat.stderr, rawDiff.stderr])
    });
  }

  const statusByPath = parseNameStatus(nameStatus.stdout);
  const hunkSummaryByPath = parseHunks(rawDiff.stdout);
  const files = parseNumstat(numstat.stdout, statusByPath, hunkSummaryByPath);
  const visibleFiles = files.slice(0, MAX_FILES);
  const risks = detectRisks(files);
  const diffRef = files.length > 0 ? newId("diff") : null;
  if (diffRef) writeLog(root, diffRef, rawDiff.stdout, rawDiff.stderr);

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact,
    mode,
    summary: summarize(files, visibleFiles, stat.stdout),
    files: visibleFiles,
    risks,
    diffRef,
    suggestedNextActions: suggestedNextActions(mode, diffRef, files, risks)
  };
}

function isGitRepository(root) {
  const result = runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  return result.status === 0 && result.stdout.trim() === "true";
}

function runGit(root, args) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16
  });
}

function parseNameStatus(stdout) {
  const byPath = new Map();
  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\t+/);
    const status = parts[0] || "";
    const changeType = changeTypeForStatus(status);
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = normalizePath(parts[1] || "");
      const newPath = normalizePath(parts[2] || oldPath);
      byPath.set(newPath, { changeType, oldPath: oldPath || null });
      continue;
    }
    const filePath = normalizePath(parts[1] || "");
    if (filePath) byPath.set(filePath, { changeType, oldPath: null });
  }
  return byPath;
}

function parseNumstat(stdout, statusByPath, hunkSummaryByPath) {
  const files = [];
  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const [rawInsertions, rawDeletions, ...pathParts] = rawLine.split("\t");
    const paths = normalizeNumstatPath(pathParts.join("\t"));
    const filePath = paths.path;
    const status = statusByPath.get(filePath) || {};
    files.push({
      path: filePath,
      oldPath: status.oldPath || paths.oldPath || null,
      changeType: status.changeType || inferChangeType(rawInsertions, rawDeletions),
      insertions: numberOrNull(rawInsertions),
      deletions: numberOrNull(rawDeletions),
      binary: rawInsertions === "-" || rawDeletions === "-",
      hunks: hunkSummaryByPath.get(filePath) || [],
      truncatedHunks: (hunkSummaryByPath.get(filePath) || []).length >= MAX_HUNKS_PER_FILE
    });
  }
  return files;
}

function normalizeNumstatPath(rawPath) {
  const pathText = normalizePath(rawPath);
  const renameMatch = pathText.match(/^(.*)\s=>\s(.*)$/);
  if (!renameMatch) return { path: pathText, oldPath: null };

  const oldPrefix = renameMatch[1].replace(/\{([^{}]*)$/, "$1");
  const newSuffix = renameMatch[2].replace(/^([^{}]*)\}/, "$1");
  return {
    path: normalizePath(`${oldPrefix}${newSuffix}`),
    oldPath: normalizePath(`${oldPrefix}${renameMatch[2].replace(/^.*\{/, "").replace(/\}.*$/, "")}`) || null
  };
}

function parseHunks(stdout) {
  const byPath = new Map();
  let currentPath = null;
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      currentPath = parseDiffGitPath(line);
      if (currentPath && !byPath.has(currentPath)) byPath.set(currentPath, []);
      continue;
    }
    if (!currentPath || !line.startsWith("@@")) continue;
    const hunk = parseHunkHeader(line);
    if (!hunk) continue;
    const entries = byPath.get(currentPath) || [];
    if (entries.length < MAX_HUNKS_PER_FILE) entries.push(hunk);
    byPath.set(currentPath, entries);
  }
  return byPath;
}

function parseDiffGitPath(line) {
  const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (!match) return null;
  return normalizePath(unquoteGitPath(match[2]));
}

function parseHunkHeader(line) {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\s?(.*)$/);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldLines: Number(match[2] || 1),
    newStart: Number(match[3]),
    newLines: Number(match[4] || 1),
    functionContext: clip(match[5] || null, 100)
  };
}

function summarize(files, visibleFiles, statOutput) {
  const insertions = sum(files.map((file) => file.insertions || 0));
  const deletions = sum(files.map((file) => file.deletions || 0));
  return {
    fileCount: files.length,
    returnedFileCount: visibleFiles.length,
    truncatedFiles: files.length > visibleFiles.length,
    insertions,
    deletions,
    hasChanges: files.length > 0,
    stat: compactStat(statOutput)
  };
}

function detectRisks(files) {
  const risks = [];
  if (files.length > LARGE_DIFF_FILES) {
    risks.push({
      code: "large-diff",
      severity: "medium",
      path: null,
      message: `Diff touches ${files.length} files`
    });
  }

  for (const file of files) {
    if (file.binary) addRisk(risks, "binary-change", "medium", file.path, "Binary file changed");
    if (file.changeType === "deleted") addRisk(risks, "delete-change", "medium", file.path, "File deleted");
    const totalLines = (file.insertions || 0) + (file.deletions || 0);
    if (totalLines >= LARGE_FILE_CHANGE_LINES) {
      addRisk(risks, "large-file-change", "medium", file.path, `Large file diff: ${totalLines} changed lines`);
    }
    for (const rule of RISKY_PATH_PATTERNS) {
      if (!rule.pattern || !rule.pattern.test(file.path)) continue;
      addRisk(risks, rule.code, rule.code === "lockfile-change" ? "high" : "low", file.path, riskMessage(rule.code));
    }
  }

  return risks;
}

function suggestedNextActions(mode, diffRef, files, risks) {
  if (files.length === 0) {
    return [{
      command: mode === "staged" ? "git diff --cached --stat" : "git diff --stat",
      reason: "No changes were found in the selected diff scope"
    }];
  }

  const actions = [];
  if (diffRef) {
    actions.push({
      command: `agentshell log get ${diffRef} --tail 120`,
      reason: "Inspect raw diff only if the compact summary is insufficient"
    });
  }
  for (const file of files.slice(0, 2)) {
    actions.push({
      command: `agentshell read ${shellQuote(file.path)} --lines 1:120`,
      reason: `Review changed file ${file.path}`
    });
  }
  if (risks.some((risk) => risk.severity === "high")) {
    actions.push({
      command: mode === "staged" ? "git diff --cached --check" : "git diff --check",
      reason: "Run a focused git whitespace/conflict-marker check before committing"
    });
  }
  return actions;
}

function changeTypeForStatus(status) {
  if (status.startsWith("A")) return "added";
  if (status.startsWith("D")) return "deleted";
  if (status.startsWith("R")) return "renamed";
  if (status.startsWith("C")) return "copied";
  if (status.startsWith("T")) return "typechanged";
  return "modified";
}

function inferChangeType(insertions, deletions) {
  if (Number(insertions) > 0 && Number(deletions) === 0) return "added";
  if (Number(deletions) > 0 && Number(insertions) === 0) return "deleted";
  return "modified";
}

function addRisk(risks, code, severity, filePath, message) {
  risks.push({ code, severity, path: filePath, message });
}

function riskMessage(code) {
  if (code === "lockfile-change") return "Dependency lockfile changed";
  if (code === "generated-output") return "Generated or build output changed";
  return "Diff risk detected";
}

function compactStat(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-1)[0] || null;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function normalizePath(value) {
  return unquoteGitPath(String(value || "").trim()).replace(/\\/g, "/").replace(/^\.\//, "");
}

function unquoteGitPath(value) {
  const text = String(value || "");
  if (!text.startsWith("\"")) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text.replace(/^"|"$/g, "");
  }
}

function clip(value, limit) {
  if (value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function firstNonEmpty(values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || null;
}
