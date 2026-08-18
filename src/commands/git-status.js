import { spawnSync } from "node:child_process";
import { fail } from "../core/output.js";

const PROTOCOL_VERSION = "agentshell.git-status.v1";
const DEFAULT_MAX_FILES = 40;

export async function gitStatus(root, options = {}) {
  const maxFiles = normalizeMaxFiles(options.maxFiles);
  const compact = Boolean(options.compact);
  const status = spawnSync("git", ["status", "--porcelain=v2", "--branch", "--renames", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8
  });

  if (status.error && status.error.code === "ENOENT") {
    return fail("GIT_NOT_AVAILABLE", "git is not available on PATH");
  }
  if (status.status !== 0) {
    return fail("NOT_GIT_REPOSITORY", "Current directory is not inside a git repository", {
      command: "git status --porcelain=v2 --branch --renames --untracked-files=all",
      stderr: (status.stderr || "").trim()
    });
  }

  const parsed = parsePorcelainV2(status.stdout);
  const files = parsed.files.slice(0, maxFiles);
  const summary = summarizeFiles(parsed.files, files.length);
  const risks = summarizeRisks(parsed.files);

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact,
    branch: parsed.branch,
    summary,
    files,
    risks,
    suggestedNextActions: suggestedNextActions(summary, risks)
  };
}

export function parsePorcelainV2(output) {
  const branch = {
    name: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0
  };
  const files = [];

  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine) continue;
    if (rawLine.startsWith("# ")) {
      parseBranchHeader(branch, rawLine.slice(2));
      continue;
    }
    if (rawLine.startsWith("1 ")) {
      const parts = rawLine.split(" ");
      files.push(buildFile(pathAfterFields(rawLine, 8), null, parts[1]));
      continue;
    }
    if (rawLine.startsWith("2 ")) {
      const tab = rawLine.indexOf("\t");
      const metadata = tab >= 0 ? rawLine.slice(0, tab) : rawLine;
      const originalPath = tab >= 0 ? rawLine.slice(tab + 1) : null;
      const parts = metadata.split(" ");
      files.push(buildFile(pathAfterFields(metadata, 9), originalPath, parts[1]));
      continue;
    }
    if (rawLine.startsWith("? ")) {
      files.push(buildFile(rawLine.slice(2), null, "??"));
      continue;
    }
    if (rawLine.startsWith("! ")) {
      files.push(buildFile(rawLine.slice(2), null, "!!"));
      continue;
    }
    if (rawLine.startsWith("u ")) {
      const parts = rawLine.split(" ");
      files.push(buildFile(pathAfterFields(rawLine, 10), null, "UU"));
    }
  }

  return { branch, files };
}

function pathAfterFields(line, fieldCount) {
  let spaces = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== " ") continue;
    spaces += 1;
    if (spaces === fieldCount) return line.slice(index + 1);
  }
  return "";
}

export function parsePorcelainV1(output) {
  const files = [];
  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine) continue;
    const code = rawLine.slice(0, 2);
    const rawPath = rawLine.slice(3);
    const renameSeparator = " -> ";
    const renameIndex = rawPath.indexOf(renameSeparator);
    if (renameIndex >= 0) {
      files.push(buildFile(rawPath.slice(renameIndex + renameSeparator.length), rawPath.slice(0, renameIndex), code));
    } else {
      files.push(buildFile(rawPath, null, code));
    }
  }
  return files;
}

function parseBranchHeader(branch, header) {
  if (header.startsWith("branch.head ")) {
    const name = header.slice("branch.head ".length);
    branch.detached = name === "(detached)";
    branch.name = branch.detached ? null : name;
    return;
  }
  if (header.startsWith("branch.upstream ")) {
    branch.upstream = header.slice("branch.upstream ".length);
    return;
  }
  if (header.startsWith("branch.ab ")) {
    const ahead = header.match(/\+(\d+)/);
    const behind = header.match(/-(\d+)/);
    branch.ahead = ahead ? Number(ahead[1]) : 0;
    branch.behind = behind ? Number(behind[1]) : 0;
  }
}

function buildFile(filePath, originalPath, code) {
  const stagedCode = code[0] || ".";
  const unstagedCode = code[1] || ".";
  const risks = riskTypesFor(filePath);
  return {
    path: filePath,
    originalPath,
    code,
    status: primaryStatus(stagedCode, unstagedCode),
    staged: statusName(stagedCode),
    unstaged: statusName(unstagedCode),
    risks
  };
}

function summarizeFiles(allFiles, listedFiles) {
  const summary = {
    dirty: allFiles.length > 0,
    clean: allFiles.length === 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    renamed: 0,
    deleted: 0,
    totalFiles: allFiles.length,
    listedFiles,
    truncated: listedFiles < allFiles.length
  };

  for (const file of allFiles) {
    if (file.code === "??") {
      summary.untracked += 1;
      continue;
    }
    if (file.staged) summary.staged += 1;
    if (file.unstaged) summary.unstaged += 1;
    if (file.staged === "renamed" || file.unstaged === "renamed") summary.renamed += 1;
    if (file.staged === "deleted" || file.unstaged === "deleted") summary.deleted += 1;
  }

  return summary;
}

function summarizeRisks(files) {
  const grouped = new Map();
  for (const file of files) {
    for (const type of file.risks) {
      if (!grouped.has(type)) grouped.set(type, []);
      grouped.get(type).push(file.path);
    }
  }
  return [...grouped.entries()].map(([type, paths]) => ({
    type,
    severity: type === "lockfile" ? "medium" : "low",
    files: paths.slice(0, 10),
    count: paths.length,
    message: riskMessage(type)
  }));
}

function suggestedNextActions(summary, risks) {
  if (summary.clean) {
    return [{
      command: "agentshell run status --compact",
      reason: "No git changes detected; inspect the active AgentShell run if needed"
    }];
  }
  const actions = [{
    command: "agentshell git diff --compact",
    reason: "Review a compact summary of the current changes"
  }];
  if (risks.some((risk) => risk.type === "lockfile")) {
    actions.push({
      command: "git diff -- package-lock.json pnpm-lock.yaml yarn.lock bun.lockb go.sum",
      reason: "Lockfile changes can be high signal; inspect them before committing"
    });
  }
  if (summary.truncated) {
    actions.push({
      command: "agentshell git status --compact --max-files 100",
      reason: "The file list was truncated"
    });
  }
  return actions;
}

function primaryStatus(stagedCode, unstagedCode) {
  if (stagedCode === "?" && unstagedCode === "?") return "untracked";
  if (stagedCode === "!" && unstagedCode === "!") return "ignored";
  return statusName(stagedCode) || statusName(unstagedCode) || "clean";
}

function statusName(code) {
  if (!code || code === "." || code === " ") return null;
  return {
    A: "added",
    M: "modified",
    D: "deleted",
    R: "renamed",
    C: "copied",
    U: "unmerged",
    "?": "untracked",
    "!": "ignored"
  }[code] || "changed";
}

function riskTypesFor(filePath) {
  const risks = [];
  if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|go\.sum|Cargo\.lock|Gemfile\.lock|poetry\.lock)$/.test(filePath)) {
    risks.push("lockfile");
  }
  if (/(^|\/)(dist|build|coverage|generated|\.next|out)\//.test(filePath) || /\.min\.(js|css)$/.test(filePath)) {
    risks.push("generated");
  }
  return risks;
}

function riskMessage(type) {
  if (type === "lockfile") return "Lockfile changed; verify dependency intent before committing";
  return "Generated or build output changed; avoid committing unless intentional";
}

function normalizeMaxFiles(value) {
  const parsed = Number(value || DEFAULT_MAX_FILES);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_FILES;
  return Math.min(Math.floor(parsed), 200);
}
