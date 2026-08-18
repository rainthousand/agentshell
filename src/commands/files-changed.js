import { spawnSync } from "node:child_process";
import { fail } from "../core/output.js";

const PROTOCOL_VERSION = "agentshell.files-changed.v1";
const DEFAULT_COMPACT_LIMIT = 40;

export async function filesChanged(root, options = {}) {
  const compact = Boolean(options.compact);
  const repo = git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (repo.error && repo.error.code === "ENOENT") {
    return fail("GIT_NOT_AVAILABLE", "git is not available on PATH");
  }
  if (repo.status !== 0 || repo.stdout.trim() !== "true") {
    return fail("NOT_GIT_REPOSITORY", "Current directory is not inside a git repository", {
      command: "git rev-parse --is-inside-work-tree",
      stderr: (repo.stderr || "").trim()
    });
  }

  const staged = runNameOnly(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMRTD"]);
  const unstaged = runNameOnly(root, ["diff", "--name-only", "--diff-filter=ACMRTD"]);
  const untracked = runNameOnly(root, ["ls-files", "--others", "--exclude-standard"]);
  if (!staged.ok) return staged.error;
  if (!unstaged.ok) return unstaged.error;
  if (!untracked.ok) return untracked.error;

  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status.status !== 0) {
    return fail("GIT_STATUS_FAILED", "Unable to read git status", {
      command: "git status --porcelain=v1 -z --untracked-files=all",
      stderr: (status.stderr || "").trim()
    });
  }

  const statusByPath = parsePorcelainStatus(status.stdout);
  const allFiles = summarizeChangedFiles({
    staged: staged.files,
    unstaged: unstaged.files,
    untracked: untracked.files,
    statusByPath
  });
  const limit = compact ? DEFAULT_COMPACT_LIMIT : Number.POSITIVE_INFINITY;
  const files = allFiles.slice(0, limit);
  const summary = summarize(allFiles, files);

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact,
    summary,
    files,
    suggestedNextActions: suggestedNextActions(summary)
  };
}

export function summarizeChangedFiles({ staged = [], unstaged = [], untracked = [], statusByPath = new Map() } = {}) {
  const entries = new Map();
  for (const filePath of staged) ensureEntry(entries, filePath).staged = true;
  for (const filePath of unstaged) ensureEntry(entries, filePath).unstaged = true;
  for (const filePath of untracked) {
    const entry = ensureEntry(entries, filePath);
    entry.untracked = true;
    entry.staged = false;
    entry.unstaged = false;
  }

  for (const [filePath, status] of statusByPath.entries()) {
    const entry = ensureEntry(entries, filePath);
    entry.status = status;
  }

  return [...entries.values()]
    .map((entry) => finalizeFile(entry))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function parsePorcelainStatus(output) {
  const statusByPath = new Map();
  const records = output.split("\0").filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const code = record.slice(0, 2);
    const filePath = record.slice(3);
    if (!filePath) continue;
    statusByPath.set(filePath, statusFromCode(code));
    if (code[0] === "R" || code[0] === "C") index += 1;
  }
  return statusByPath;
}

function ensureEntry(entries, filePath) {
  if (!entries.has(filePath)) {
    entries.set(filePath, {
      path: filePath,
      status: "changed",
      staged: false,
      unstaged: false,
      untracked: false
    });
  }
  return entries.get(filePath);
}

function finalizeFile(entry) {
  const category = categoryFor(entry.path);
  return {
    path: entry.path,
    status: entry.status || statusFromFlags(entry),
    staged: Boolean(entry.staged),
    unstaged: Boolean(entry.unstaged),
    untracked: Boolean(entry.untracked),
    category,
    risk: riskFor(entry.path, category)
  };
}

function summarize(allFiles, files) {
  const categories = countBy(allFiles, "category");
  const risks = countBy(allFiles, "risk");
  return {
    clean: allFiles.length === 0,
    dirty: allFiles.length > 0,
    totalFiles: allFiles.length,
    returnedFiles: files.length,
    truncated: files.length < allFiles.length,
    staged: allFiles.filter((file) => file.staged).length,
    unstaged: allFiles.filter((file) => file.unstaged).length,
    untracked: allFiles.filter((file) => file.untracked).length,
    categories,
    risks
  };
}

function countBy(files, key) {
  const counts = {};
  for (const file of files) counts[file[key]] = (counts[file[key]] || 0) + 1;
  return counts;
}

function suggestedNextActions(summary) {
  if (summary.clean) {
    return [{
      command: "agentshell run status --compact",
      reason: "No changed files detected"
    }];
  }
  const actions = [{
    command: "agentshell git status --compact",
    reason: "Inspect the working tree with compact AgentShell output"
  }];
  actions.push({
    command: "agentshell git diff --compact",
    reason: "Inspect compact diff summaries only when changed-file categories are insufficient"
  });
  if (summary.truncated) {
    actions.push({
      command: "agentshell files changed",
      reason: "Compact changed-file output was truncated; request the full file list only if needed"
    });
  }
  if (summary.risks.high) {
    actions.push({
      command: "agentshell verify test --compact",
      reason: "High-risk changed files should be verified before handoff"
    });
  }
  return actions;
}

function runNameOnly(root, args) {
  const result = git(root, args);
  if (result.status !== 0) {
    return {
      ok: false,
      error: fail("GIT_COMMAND_FAILED", "Unable to list changed files", {
        command: `git ${args.join(" ")}`,
        stderr: (result.stderr || "").trim()
      })
    };
  }
  return {
    ok: true,
    files: result.stdout.split(/\r?\n/).filter(Boolean)
  };
}

function git(root, args) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 4
  });
}

function statusFromFlags(entry) {
  if (entry.untracked) return "untracked";
  if (entry.staged && entry.unstaged) return "modified";
  if (entry.staged) return "staged";
  if (entry.unstaged) return "modified";
  return "changed";
}

function statusFromCode(code) {
  if (code === "??") return "untracked";
  if (code.includes("R")) return "renamed";
  if (code.includes("C")) return "copied";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  if (code.includes("M")) return "modified";
  if (code.includes("U")) return "unmerged";
  return "changed";
}

function categoryFor(filePath) {
  if (isLockfile(filePath)) return "lockfile";
  if (/(^|\/)(dist|build|coverage|generated|\.next|out)\//.test(filePath) || /\.min\.(js|css)$/.test(filePath)) return "generated";
  if (/(^|\/)(__tests__|tests?|spec|fixtures)\//.test(filePath) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(filePath)) return "test";
  if (/(^|\/)(docs?|README|CHANGELOG|LICENSE|NOTICE)(\/|\.|$)/i.test(filePath) || /\.(md|mdx|rst|txt|adoc)$/i.test(filePath)) return "docs";
  if (isPackageFile(filePath)) return "config";
  if (/(^|\/)(\.github|\.config|config|configs)\//.test(filePath) || /\.(ya?ml|toml|json|ini|env|rc)$/i.test(filePath)) return "config";
  if (/\.(png|jpe?g|gif|webp|svg|ico|mp3|mp4|mov|woff2?|ttf|otf|pdf)$/i.test(filePath)) return "asset";
  if (/(^|\/)(src|lib|bin|scripts|server|client|app)\//.test(filePath) || /\.(mjs|cjs|js|jsx|ts|tsx|go|py|rb|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|css|scss|html)$/i.test(filePath)) return "source";
  return "other";
}

function riskFor(filePath, category) {
  if (/(^|\/)(SECURITY\.md|security|auth|permissions?|secrets?)(\/|\.|$)/i.test(filePath)) return "high";
  if (isPackageFile(filePath)) return "high";
  if (/(^|\/)(release|releases|CHANGELOG|changeset|\.changeset)(\/|\.|$)/i.test(filePath)) return "medium";
  if (category === "lockfile") return "medium";
  if (category === "config") return "medium";
  if (category === "generated") return "low";
  return "low";
}

function isLockfile(filePath) {
  return /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|go\.sum|Cargo\.lock|Gemfile\.lock|poetry\.lock)$/.test(filePath);
}

function isPackageFile(filePath) {
  return /(^|\/)(package\.json|go\.mod|Cargo\.toml|Gemfile|pyproject\.toml|requirements.*\.txt)$/.test(filePath);
}
