#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const SHARE_PACKAGE_PROTOCOL_VERSION = "agentshell.share-package.v1";
const DEFAULT_NAME = "agentshell-share";
const DEFAULT_OUT_DIR = path.join(root, "artifacts", "share-package");

const INCLUDED_PATHS = [
  ".codex-plugin",
  "bin",
  "desktop",
  "docs",
  "examples",
  "schemas",
  "scripts",
  "skills",
  "src",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "package.json"
];

const EXCLUDED_NAMES = new Set([
  ".agentshell",
  ".git",
  ".DS_Store",
  "artifacts",
  "node_modules"
]);

const args = parseArgs(process.argv.slice(2));

if (process.argv[1] === import.meta.filename) {
  try {
    if (args.help) {
      console.log(formatHelp());
      process.exit(0);
    }
    const report = buildSharePackage(root, args);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

export function buildSharePackage(projectRoot = root, options = {}) {
  const packageName = sanitizePackageName(options.name || DEFAULT_NAME);
  const outDir = path.resolve(options.outDir || DEFAULT_OUT_DIR);
  const packageDir = path.join(outDir, packageName);
  const zipPath = path.join(outDir, `${packageName}.zip`);

  ensureSafeOutputPath(projectRoot, packageDir);
  fs.rmSync(packageDir, { recursive: true, force: true });
  fs.mkdirSync(packageDir, { recursive: true });

  const copied = [];
  for (const entry of INCLUDED_PATHS) {
    const source = path.join(projectRoot, entry);
    if (!fs.existsSync(source)) continue;
    copyPath(source, path.join(packageDir, entry), copied, entry);
  }

  const startHerePath = path.join(packageDir, "START-HERE.md");
  fs.writeFileSync(startHerePath, renderStartHere(packageName), "utf8");
  const installCommandPath = path.join(packageDir, "install.command");
  fs.writeFileSync(installCommandPath, renderInstallCommand(), "utf8");
  fs.chmodSync(installCommandPath, 0o755);
  const checkInstallCommandPath = path.join(packageDir, "check-install.command");
  fs.writeFileSync(checkInstallCommandPath, renderCheckInstallCommand(), "utf8");
  fs.chmodSync(checkInstallCommandPath, 0o755);
  const updateCommandPath = path.join(packageDir, "update.command");
  fs.writeFileSync(updateCommandPath, renderLifecycleCommand("update"), "utf8");
  fs.chmodSync(updateCommandPath, 0o755);
  const uninstallCommandPath = path.join(packageDir, "uninstall.command");
  fs.writeFileSync(uninstallCommandPath, renderLifecycleCommand("uninstall"), "utf8");
  fs.chmodSync(uninstallCommandPath, 0o755);
  copied.push("START-HERE.md", "install.command", "check-install.command", "update.command", "uninstall.command");

  const excludedPresent = findExcludedPaths(packageDir);
  const zip = options.zip ? writeZip(outDir, packageName, zipPath) : null;
  const ok = excludedPresent.length === 0 && (!options.zip || zip.ok);

  return {
    ok,
    protocolVersion: SHARE_PACKAGE_PROTOCOL_VERSION,
    packageName,
    packageDir,
    zipPath: zip?.path || null,
    summary: {
      copiedFiles: copied.length,
      excludedPresent: excludedPresent.length,
      zipCreated: Boolean(zip?.ok)
    },
    includedPaths: INCLUDED_PATHS,
    excludedNames: [...EXCLUDED_NAMES].sort(),
    excludedPresent,
    zip
  };
}

function parseArgs(argv) {
  const parsed = {
    name: DEFAULT_NAME,
    outDir: DEFAULT_OUT_DIR,
    zip: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--name") {
      parsed.name = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--name=")) {
      parsed.name = requireInlineValue(arg, "--name");
      continue;
    }
    if (arg === "--out-dir") {
      parsed.outDir = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--out-dir=")) {
      parsed.outDir = requireInlineValue(arg, "--out-dir");
      continue;
    }
    if (arg === "--zip") {
      parsed.zip = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function requireInlineValue(arg, flag) {
  const value = arg.slice(`${flag}=`.length);
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function sanitizePackageName(value) {
  const name = String(value).trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error("--name may only contain letters, numbers, dots, underscores, and dashes");
  }
  if (name === "." || name === "..") {
    throw new Error("--name must be a directory name");
  }
  return name;
}

function ensureSafeOutputPath(projectRoot, packageDir) {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedPackageDir = path.resolve(packageDir);
  if (resolvedPackageDir === resolvedRoot) {
    throw new Error("Refusing to overwrite the project root");
  }
  if (resolvedRoot.startsWith(`${resolvedPackageDir}${path.sep}`)) {
    throw new Error("Refusing to write a share package around the project root");
  }
}

function copyPath(source, target, copied, relativePath) {
  const name = path.basename(source);
  if (EXCLUDED_NAMES.has(name)) return;

  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const child of fs.readdirSync(source)) {
      copyPath(path.join(source, child), path.join(target, child), copied, path.join(relativePath, child));
    }
    return;
  }

  if (!stat.isFile()) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  preserveExecutableMode(stat, target);
  copied.push(relativePath);
}

function preserveExecutableMode(stat, target) {
  if ((stat.mode & 0o111) !== 0) {
    fs.chmodSync(target, stat.mode);
  }
}

function findExcludedPaths(packageDir) {
  const found = [];
  walk(packageDir, null, (entryPath, dirent) => {
    if (entryPath === packageDir) return true;
    if (EXCLUDED_NAMES.has(dirent.name)) {
      found.push(path.relative(packageDir, entryPath));
      return false;
    }
    return true;
  });
  return found.sort();
}

function walk(current, dirent, visit) {
  const currentDirent = dirent || {
    name: path.basename(current),
    isDirectory: () => fs.statSync(current).isDirectory()
  };
  if (visit(current, currentDirent) === false) return;
  if (!fs.statSync(current).isDirectory()) return;
  for (const child of fs.readdirSync(current, { withFileTypes: true })) {
    walk(path.join(current, child.name), child, visit);
  }
}

function writeZip(outDir, packageName, zipPath) {
  fs.rmSync(zipPath, { force: true });
  const result = spawnSync("zip", ["-qr", zipPath, packageName], {
    cwd: outDir,
    encoding: "utf8"
  });
  return {
    ok: result.status === 0,
    path: zipPath,
    command: `zip -qr ${path.basename(zipPath)} ${packageName}`,
    status: result.status,
    stdout: trim(result.stdout),
    stderr: trim(result.stderr),
    error: result.error?.message
  };
}

function renderStartHere(packageName) {
  return `# AgentShell Share Package

This folder is a local AgentShell share package for Codex users. It is not a public plugin release.

## Install For Codex

Requirements:

- Node.js 20+
- Codex CLI available on PATH

Easiest path on macOS:

1. Double-click \`install.command\`.
2. Wait for "AgentShell is installed and configured for Codex."
3. Quit and reopen Codex, then start a new task.

If installation fails or you want to confirm it later, double-click
\`check-install.command\`. It writes \`agentshell-install-check.json\` to the
Desktop. Send that small JSON file to the AgentShell maintainer when asking for
help.

Use \`update.command\` for a staged, rollback-aware update and
\`uninstall.command\` to remove only AgentShell-managed files and settings.

Terminal fallback from this folder:

\`\`\`bash
npm run install:codex
npm run update:codex
npm run doctor:codex
npm run uninstall:codex
\`\`\`

When the installer succeeds, open a new Codex task. The installer links the local \`agentshell\` command, installs the local Codex plugin copy, writes AgentShell guidance into \`~/.codex/AGENTS.md\`, and runs smoke checks.

After Codex completes and verifies a real task, ask it:

> Please run \`agentshell trial export --rating 5\` in this project and tell me where the exported file is.

Review the exported JSON on the Desktop, then send it to the AgentShell maintainer.

## Try The CLI

\`\`\`bash
node src/cli.js start --compact
node src/cli.js manual
node src/cli.js manual --topic onboarding
\`\`\`

## What Is Included

The package keeps the source, plugin metadata, install scripts, docs, schemas, and demo fixtures needed for local use. It intentionally excludes runtime or repository state such as \`.git\`, \`.agentshell\`, \`artifacts\`, and \`node_modules\`.

Package directory name: \`${packageName}\`
`;
}

function renderInstallCommand() {
  return `#!/bin/bash
set -uo pipefail
cd "$(dirname "$0")"
LOG_FILE="$PWD/agentshell-install.log"
echo "Installing AgentShell for Codex..."
echo "A local log will be written to: $LOG_FILE"
echo
npm run install:codex 2>&1 | tee "$LOG_FILE"
STATUS=\${PIPESTATUS[0]}
echo
if [ "$STATUS" -eq 0 ]; then
  echo "AgentShell is installed and configured for Codex."
  echo "Quit and reopen Codex, then start a new task."
else
  echo "AgentShell installation did not finish."
  echo "Keep this folder and send agentshell-install.log when asking for help."
fi
read -r -p "Press Enter to close this window..." _
exit "$STATUS"
`;
}

function renderCheckInstallCommand() {
  return `#!/bin/bash
set -uo pipefail
cd "$(dirname "$0")"
if [ -d "$HOME/Desktop" ]; then
  REPORT_FILE="$HOME/Desktop/agentshell-install-check.json"
else
  REPORT_FILE="$PWD/agentshell-install-check.json"
fi
echo "Checking AgentShell installation..."
npm run doctor:codex 2>/dev/null | tee "$REPORT_FILE"
STATUS=\${PIPESTATUS[0]}
echo
if [ "$STATUS" -eq 0 ]; then
  echo "AgentShell installation is healthy."
else
  echo "AgentShell needs attention."
fi
echo "Diagnostic report: $REPORT_FILE"
echo "Review this JSON before sending it to the AgentShell maintainer."
read -r -p "Press Enter to close this window..." _
exit "$STATUS"
`;
}

function renderLifecycleCommand(action) {
  return `#!/bin/bash
set -uo pipefail
cd "$(dirname "$0")"
LOG_FILE="$PWD/agentshell-${action}.log"
echo "Running AgentShell ${action}..."
npm run ${action}:codex 2>&1 | tee "$LOG_FILE"
STATUS=\${PIPESTATUS[0]}
echo
if [ "$STATUS" -eq 0 ]; then
  echo "AgentShell ${action} completed. Quit and reopen Codex."
else
  echo "AgentShell ${action} needs attention. See: $LOG_FILE"
fi
read -r -p "Press Enter to close this window..." _
exit "$STATUS"
`;
}

function formatHelp() {
  return JSON.stringify({
    ok: true,
    usage: "node scripts/share-package.js [--out-dir <dir>] [--name <name>] [--zip]",
    defaultOutDir: DEFAULT_OUT_DIR,
    defaultName: DEFAULT_NAME,
    output: "Prints agentshell.share-package.v1 JSON."
  });
}

function trim(text = "") {
  return String(text).trim().slice(0, 2000);
}
