import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PROTOCOL_VERSION = "agentshell.pwd.v1";
const MANIFESTS = [
  "package.json", "go.work", "go.mod", "pyproject.toml", "requirements.txt",
  "pom.xml", "settings.gradle", "settings.gradle.kts", "build.gradle",
  "build.gradle.kts", "Cargo.toml", "Makefile"
];

export async function pwd(root, options = {}) {
  const cwd = path.resolve(root);
  const canonicalCwd = canonicalPath(cwd);
  const compact = options.compact === undefined ? true : Boolean(options.compact);
  const project = findProject(cwd);
  const git = findGitRoot(cwd, canonicalCwd);
  const canonicalProjectRoot = project ? canonicalPath(project.root) : null;

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact,
    summary: {
      cwd,
      directoryName: path.basename(cwd),
      insideGitRepository: Boolean(git),
      atGitRoot: Boolean(git && git.canonicalRoot === canonicalCwd),
      atProjectRoot: Boolean(project && canonicalProjectRoot === canonicalCwd),
      manifest: project?.manifest || null
    },
    git: git ? relation(canonicalCwd, git.canonicalRoot, { root: git.root }) : null,
    project: project ? relation(canonicalCwd, canonicalProjectRoot, project) : null,
    suggestedNextActions: suggestedNextActions(project, git)
  };
}

export const workingDirectory = pwd;

function findProject(start) {
  let current = start;
  while (true) {
    for (const manifest of MANIFESTS) {
      if (fs.existsSync(path.join(current, manifest))) return { root: current, manifest };
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function findGitRoot(cwd, canonicalCwd) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const canonicalRoot = canonicalPath(path.resolve(result.stdout.trim()));
  return {
    root: displayRootForCwd(cwd, canonicalCwd, canonicalRoot),
    canonicalRoot
  };
}

function relation(cwd, root, value) {
  const relativePath = path.relative(root, cwd).split(path.sep).join("/") || ".";
  return {
    ...value,
    relation: root === cwd ? "root" : "descendant",
    relativePath
  };
}

function canonicalPath(filePath) {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function displayRootForCwd(cwd, canonicalCwd, canonicalRoot) {
  const relativePath = path.relative(canonicalRoot, canonicalCwd);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return canonicalRoot;
  const levels = relativePath ? relativePath.split(path.sep).length : 0;
  return path.resolve(cwd, ...Array.from({ length: levels }, () => ".."));
}

function suggestedNextActions(project, git) {
  const actions = [];
  if (project) actions.push({
    command: `agentshell read ${quotePath(path.join(project.root, project.manifest))} --lines 1:120`,
    reason: "Inspect the detected project manifest"
  });
  if (git) actions.push({ command: "agentshell git status --compact", reason: "Inspect repository state from the detected Git worktree" });
  if (!project) actions.push({ command: "agentshell ls --compact", reason: "No supported manifest was found; inspect the current directory" });
  return actions;
}

function quotePath(filePath) {
  return /^[A-Za-z0-9_./-]+$/.test(filePath) ? filePath : JSON.stringify(filePath);
}
