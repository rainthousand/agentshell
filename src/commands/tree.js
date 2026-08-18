import fs from "node:fs";
import path from "node:path";

const PROTOCOL_VERSION = "agentshell.tree.v1";
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_DIRECTORIES = 80;
const DEFAULT_MAX_FILES = 120;
const MAX_IGNORED = 40;

const IGNORED_NAMES = new Set([
  ".agentshell",
  ".cache",
  ".git",
  ".next",
  ".parcel-cache",
  ".pytest_cache",
  ".turbo",
  ".vite",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "tmp",
  "temp"
]);

const IMPORTANT_DIRECTORIES = new Set([
  "src",
  "test",
  "tests",
  "doc",
  "docs",
  "script",
  "scripts"
]);

const ENTRY_FILES = new Set([
  "package.json",
  "go.mod",
  "go.work",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "Makefile",
  "README.md",
  "src/cli.js",
  "src/main.js",
  "src/index.js",
  "src/main.ts",
  "src/index.ts",
  "cmd/main.go",
  "main.go"
]);

export async function tree(root, options = {}) {
  const projectRoot = path.resolve(root);
  const maxDepth = positiveInteger(options.maxDepth ?? options.depth, DEFAULT_MAX_DEPTH);
  const sharedLimit = positiveInteger(options.limit, null);
  const maxDirectories = positiveInteger(options.maxDirectories, sharedLimit || DEFAULT_MAX_DIRECTORIES);
  const maxFiles = positiveInteger(options.maxFiles, sharedLimit || DEFAULT_MAX_FILES);

  const state = {
    directoryCount: 0,
    fileCount: 0,
    ignoredCount: 0,
    directories: [],
    files: [],
    ignored: [],
    truncated: false,
    maxDepth,
    maxDirectories,
    maxFiles
  };

  scanDirectory(projectRoot, "", 0, state);

  const importantDirectories = state.directories
    .filter((entry) => entry.important)
    .map((entry) => entry.path);
  const entryFiles = state.files
    .filter((entry) => entry.entry)
    .map((entry) => entry.path);

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: options.compact === true,
    root: {
      name: path.basename(projectRoot),
      path: projectRoot
    },
    summary: {
      directoryCount: state.directoryCount,
      fileCount: state.fileCount,
      ignoredCount: state.ignoredCount,
      importantDirectories,
      entryFiles,
      maxDepth
    },
    directories: state.directories,
    files: state.files,
    ignored: state.ignored,
    truncated: state.truncated,
    suggestedNextActions: suggestedNextActions(importantDirectories, entryFiles)
  };
}

export const projectTree = tree;

function scanDirectory(dir, relativeDir, depth, state) {
  if (depth > state.maxDepth) {
    state.truncated = true;
    return;
  }

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    state.truncated = true;
    addIgnored(state, relativeDir || ".", `unreadable: ${error.code || "UNKNOWN"}`);
    return;
  }

  entries.sort((a, b) => entryPriority(relativeDir, a) - entryPriority(relativeDir, b) || a.name.localeCompare(b.name));

  for (const entry of entries.filter((candidate) => candidate.isFile())) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (shouldIgnore(entry.name)) {
      state.ignoredCount += 1;
      addIgnored(state, relativePath, "default-ignore");
      continue;
    }

    state.fileCount += 1;
    addFile(state, relativePath, depth + 1);
  }

  for (const entry of entries.filter((candidate) => !candidate.isFile())) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (shouldIgnore(entry.name)) {
      state.ignoredCount += 1;
      addIgnored(state, relativePath, "default-ignore");
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      state.directoryCount += 1;
      addDirectory(state, relativePath, depth + 1);
      if (depth + 1 >= state.maxDepth) {
        state.truncated = true;
        continue;
      }
      scanDirectory(fullPath, relativePath, depth + 1, state);
      continue;
    }

  }
}

function entryPriority(relativeDir, entry) {
  const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
  if (entry.isFile() && ENTRY_FILES.has(relativePath)) return 0;
  if (entry.isFile() && ENTRY_FILES.has(entry.name)) return 1;
  if (entry.isDirectory() && IMPORTANT_DIRECTORIES.has(entry.name)) return 2;
  if (entry.isDirectory()) return 3;
  return 4;
}

function addDirectory(state, relativePath, depth) {
  if (state.directories.length >= state.maxDirectories) {
    state.truncated = true;
    return;
  }

  const name = path.basename(relativePath);
  state.directories.push({
    path: relativePath,
    depth,
    important: IMPORTANT_DIRECTORIES.has(name)
  });
}

function addFile(state, relativePath, depth) {
  if (state.files.length >= state.maxFiles) {
    state.truncated = true;
    return;
  }

  state.files.push({
    path: relativePath,
    depth,
    entry: ENTRY_FILES.has(relativePath) || ENTRY_FILES.has(path.basename(relativePath))
  });
}

function addIgnored(state, relativePath, reason) {
  if (state.ignored.length >= MAX_IGNORED) {
    state.truncated = true;
    return;
  }
  state.ignored.push({ path: relativePath, reason });
}

function shouldIgnore(name) {
  return IGNORED_NAMES.has(name);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function suggestedNextActions(importantDirectories, entryFiles) {
  const actions = [];
  if (entryFiles.includes("package.json")) {
    actions.push({
      command: "agentshell read package.json --lines 1:120",
      reason: "Inspect Node scripts and dependency hints"
    });
  }
  if (entryFiles.includes("go.mod")) {
    actions.push({
      command: "agentshell read go.mod --lines 1:80",
      reason: "Inspect Go module path and version"
    });
  }
  if (importantDirectories.includes("src")) {
    actions.push({
      command: "agentshell find \"TODO\"",
      reason: "Search source files only after the project shape is known"
    });
  }
  if (actions.length === 0) {
    actions.push({
      command: "agentshell understand --compact",
      reason: "Collect a broader project summary"
    });
  }
  return actions;
}
