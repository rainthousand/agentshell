#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_LIFECYCLE_SMOKE_PROTOCOL_VERSION = "agentshell.package-lifecycle-smoke.v1";

const BINARY_NAME = "agentshell-darwin-arm64";
const ACTIONS = ["install", "doctor", "update", "uninstall"];

export function runPackageLifecycleSmoke(options = {}) {
  const packageDir = path.resolve(options.packageDir || process.cwd());
  const dryRun = Boolean(options.dryRun);
  const binary = path.join(packageDir, "bin", BINARY_NAME);
  const preflight = validatePackage(packageDir, binary);
  if (!preflight.ok) return report(false, packageDir, dryRun, [], preflight.error);

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-package-lifecycle-"));
  const home = path.join(sandbox, "home");
  const fakeBin = path.join(sandbox, "bin");
  const commandLog = path.join(sandbox, "commands.jsonl");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  writeFakeCommand(path.join(fakeBin, "codex"), commandLog, 0);
  writeFakeCommand(path.join(fakeBin, "launchctl"), commandLog, 113);

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    SHELL: "/bin/zsh",
    PATH: process.env.AGENTSHELL_TEST_STANDALONE_LAUNCHER === "1"
      ? `${fakeBin}${path.delimiter}${path.dirname(process.execPath)}`
      : fakeBin,
    AGENTSHELL_SMOKE_COMMAND_LOG: commandLog
  };
  const steps = [];

  try {
    for (const action of ACTIONS) {
      if (dryRun && action === "doctor") {
        steps.push({ action, ok: true, status: "skipped", reason: "dry-run-has-no-installed-state" });
        continue;
      }
      const args = ["setup", "codex", action, "--source", packageDir, "--home", home];
      if (dryRun) args.push("--dry-run");
      const step = executeStep(binary, args, packageDir, env, action);
      steps.push(step);
      if (!step.ok) {
        return report(false, packageDir, dryRun, steps, {
          code: "LIFECYCLE_STEP_FAILED",
          message: `${action} failed through the packaged standalone CLI.`,
          action
        }, readCommandLog(commandLog));
      }
    }

    const filesystem = inspectSandbox(home, dryRun);
    if (!filesystem.ok) {
      return report(false, packageDir, dryRun, steps, {
        code: "SANDBOX_STATE_INVALID",
        message: filesystem.message
      }, readCommandLog(commandLog));
    }
    return report(true, packageDir, dryRun, steps, null, readCommandLog(commandLog), filesystem);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

function executeStep(binary, args, cwd, env, action) {
  const result = spawnSync(binary, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024
  });
  const parsed = parseJson(result.stdout);
  const ok = result.status === 0 && parsed?.ok === true;
  return {
    action,
    ok,
    status: parsed?.action || (result.error ? "spawn-error" : "completed"),
    exitCode: Number.isInteger(result.status) ? result.status : null,
    protocolVersion: parsed?.protocolVersion || null,
    ...(parsed?.checks ? { checks: parsed.checks } : {}),
    ...(parsed?.nativeCli?.status ? { nativeCli: parsed.nativeCli.status } : {}),
    ...(parsed?.plugin?.status ? { plugin: parsed.plugin.status } : {}),
    ...(!ok ? {
      diagnostic: {
        error: result.error?.message || parsed?.error?.message || null,
        stdout: compactText(result.stdout),
        stderr: compactText(result.stderr)
      }
    } : {})
  };
}

function validatePackage(packageDir, binary) {
  if (!isDirectory(packageDir)) {
    return { ok: false, error: { code: "PACKAGE_DIR_MISSING", message: `Package directory does not exist: ${packageDir}` } };
  }
  if (!isExecutable(binary)) {
    return { ok: false, error: { code: "PREBUILT_CLI_MISSING", message: `Executable ${BINARY_NAME} is missing from the package bin directory.` } };
  }
  const manifest = readJson(path.join(packageDir, ".codex-plugin", "plugin.json"));
  if (manifest?.name !== "agentshell" || !manifest.version) {
    return { ok: false, error: { code: "PLUGIN_MANIFEST_INVALID", message: "Package plugin manifest is missing or invalid." } };
  }
  return { ok: true };
}

function inspectSandbox(home, dryRun) {
  const installedCli = path.join(home, ".local", "bin", "agentshell");
  const plugin = path.join(home, "plugins", "agentshell");
  if (dryRun) {
    const clean = !fs.existsSync(installedCli) && !fs.existsSync(plugin);
    return { ok: clean, finalState: clean ? "unchanged" : "unexpected-writes", message: clean ? null : "Dry run wrote installation state." };
  }
  const removed = !fs.existsSync(installedCli) && !fs.existsSync(plugin);
  return { ok: removed, finalState: removed ? "uninstalled" : "residual-installation", message: removed ? null : "Uninstall left managed installation files behind." };
}

function writeFakeCommand(file, logFile, exitCode) {
  const script = [
    "#!/bin/sh",
    `printf '%s %s\\n' \"$0\" \"$*\" >> \"${escapeShell(logFile)}\"`,
    `exit ${exitCode}`,
    ""
  ].join("\n");
  fs.writeFileSync(file, script, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function escapeShell(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function readCommandLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => path.basename(line.split(" ")[0]) + line.slice(line.indexOf(" ")));
}

function report(ok, packageDir, dryRun, steps, error = null, commands = [], filesystem = null) {
  return {
    ok,
    protocolVersion: PACKAGE_LIFECYCLE_SMOKE_PROTOCOL_VERSION,
    packageVersion: readJson(path.join(packageDir, "package.json"))?.version || null,
    packageDir,
    dryRun,
    summary: {
      passed: steps.filter((step) => step.ok).length,
      total: steps.length,
      finalState: filesystem?.finalState || null,
      externalCommands: commands.length
    },
    steps,
    externalCommands: commands,
    ...(error ? { error } : {})
  };
}

function parseJson(value) {
  try { return JSON.parse(String(value || "").trim()); } catch { return null; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function compactText(value) {
  const text = String(value || "").trim();
  return text.length > 800 ? `${text.slice(0, 800)}...` : text || null;
}

function isDirectory(value) {
  try { return fs.statSync(value).isDirectory(); } catch { return false; }
}

function isExecutable(value) {
  try { return fs.statSync(value).isFile() && (fs.statSync(value).mode & 0o111) !== 0; } catch { return false; }
}

function parseArgs(argv) {
  const options = { packageDir: process.cwd(), dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--package-dir") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("--package-dir requires a value");
      options.packageDir = argv[++index];
    } else if (arg.startsWith("--package-dir=")) {
      options.packageDir = arg.slice("--package-dir=".length);
      if (!options.packageDir) throw new Error("--package-dir requires a value");
    } else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function help() {
  return {
    ok: true,
    protocolVersion: PACKAGE_LIFECYCLE_SMOKE_PROTOCOL_VERSION,
    usage: "node scripts/package-lifecycle-smoke.js [--package-dir <delivery-dir>] [--dry-run]"
  };
}

const mainFile = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (mainFile === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const output = options.help ? help() : runPackageLifecycleSmoke(options);
    process.stdout.write(`${JSON.stringify(output)}\n`);
    if (!output.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      protocolVersion: PACKAGE_LIFECYCLE_SMOKE_PROTOCOL_VERSION,
      error: { code: "INVALID_ARGUMENT", message: error.message }
    })}\n`);
    process.exitCode = 2;
  }
}
