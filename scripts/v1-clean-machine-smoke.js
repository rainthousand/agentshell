#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const V1_CLEAN_MACHINE_SMOKE_PROTOCOL_VERSION = "agentshell.v1-clean-machine-smoke.v1";

const BINARY_NAME = "agentshell-darwin-arm64";

export function runV1CleanMachineSmoke(options = {}) {
  if (!options.packageDir) return failure("PACKAGE_DIR_REQUIRED", "--package-dir is required.");
  const packageDir = path.resolve(options.packageDir);
  const binary = path.join(packageDir, "bin", BINARY_NAME);
  const packageVersion = readJson(path.join(packageDir, "package.json"))?.version || null;
  const pluginManifest = readJson(path.join(packageDir, ".codex-plugin", "plugin.json"));
  if (!isDirectory(packageDir)) return failure("PACKAGE_DIR_MISSING", "The package directory does not exist.", packageVersion);
  if (!isExecutable(binary)) return failure("NATIVE_CLI_MISSING", `${BINARY_NAME} is missing or not executable.`, packageVersion);
  if (pluginManifest?.name !== "agentshell" || !pluginManifest.version) {
    return failure("PLUGIN_MANIFEST_INVALID", "The package does not contain a valid AgentShell plugin manifest.", packageVersion);
  }

  const dryRun = options.dryRun === true;
  const sandbox = fs.mkdtempSync(path.join(options.tmpDir || os.tmpdir(), "agentshell-v1-clean-"));
  const home = path.join(sandbox, "home");
  const fakeBin = path.join(sandbox, "bin");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(fakeBin, { recursive: true, mode: 0o700 });
  writeCodexStub(path.join(fakeBin, "codex"));
  const env = isolatedEnvironment(home, fakeBin);
  const steps = [];

  try {
    const actions = dryRun ? ["install", "update"] : ["install", "doctor", "update"];
    for (const action of actions) {
      const args = ["setup", "codex", action, "--source", packageDir, "--home", home];
      if (dryRun) args.push("--dry-run");
      const step = runJsonStep(binary, args, packageDir, env, action);
      steps.push(step);
      if (!step.ok) return buildReport(false, packageVersion, dryRun, steps, inspectFinalState(home, dryRun), {
        code: "LIFECYCLE_STEP_FAILED",
        step: action
      });
    }

    const dashboardBinary = dryRun ? binary : path.join(home, ".local", "bin", "agentshell");
    const dashboard = runJsonStep(dashboardBinary, ["dashboard", "--status"], packageDir, env, "dashboard-status");
    steps.push(dashboard);
    if (!dashboard.ok || dashboard.protocolVersion !== "agentshell.dashboard-control.v1") {
      return buildReport(false, packageVersion, dryRun, steps, inspectFinalState(home, dryRun), {
        code: "DASHBOARD_STATUS_FAILED",
        step: "dashboard-status"
      });
    }

    if (dryRun) {
      const uninstall = runJsonStep(binary, [
        "setup", "codex", "uninstall", "--source", packageDir, "--home", home, "--dry-run"
      ], packageDir, env, "uninstall");
      steps.push(uninstall);
    } else {
      const doctor = steps.find((step) => step.name === "doctor");
      const serviceStatus = doctor?.dashboardServiceStatus || null;
      if (serviceStatus !== "skipped") {
        return buildReport(false, packageVersion, dryRun, steps, inspectFinalState(home, dryRun), {
          code: "SERVICE_ISOLATION_FAILED",
          step: "doctor"
        });
      }
      const uninstall = runJsonStep(binary, [
        "setup", "codex", "uninstall", "--source", packageDir, "--home", home
      ], packageDir, env, "uninstall");
      steps.push(uninstall);
    }

    const filesystem = inspectFinalState(home, dryRun);
    const ok = steps.every((step) => step.ok) && filesystem.ok;
    return buildReport(ok, packageVersion, dryRun, steps, filesystem, ok ? null : {
      code: filesystem.ok ? "LIFECYCLE_STEP_FAILED" : "RESIDUAL_STATE",
      step: filesystem.ok ? steps.find((step) => !step.ok)?.name || null : "uninstall"
    });
  } finally {
    if (options.keepSandbox !== true) fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

function runJsonStep(command, args, cwd, env, name) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024
  });
  const output = parseJson(result.stdout);
  const ok = result.status === 0 && output?.ok === true;
  return {
    name,
    ok,
    exitCode: Number.isInteger(result.status) ? result.status : null,
    protocolVersion: typeof output?.protocolVersion === "string" ? output.protocolVersion : null,
    status: safeStatus(output?.status || output?.action || (ok ? "completed" : "failed")),
    ...(name === "doctor" ? {
      checksPassed: countTrue(output?.checks),
      checksTotal: countBoolean(output?.checks),
      dashboardServiceStatus: safeStatus(output?.dashboardService?.status)
    } : {}),
    ...(name === "dashboard-status" ? { running: output?.running === true } : {}),
    ...(!ok ? { errorCode: safeCode(output?.error?.code || result.error?.code || "COMMAND_FAILED") } : {})
  };
}

function isolatedEnvironment(home, fakeBin) {
  return {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(home, ".codex"),
    PATH: `${fakeBin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    SHELL: "/bin/zsh",
    LANG: process.env.LANG || "C.UTF-8",
    TMPDIR: os.tmpdir()
  };
}

function inspectFinalState(home, dryRun) {
  const managed = [
    path.join(home, ".local", "bin", "agentshell"),
    path.join(home, "plugins", "agentshell"),
    path.join(home, ".agentshell", "standalone-install.json"),
    path.join(home, "Library", "LaunchAgents", "com.agentshell.dashboard.plist")
  ];
  const residualCount = managed.filter((entry) => fs.existsSync(entry)).length;
  return {
    ok: residualCount === 0,
    state: residualCount === 0 ? (dryRun ? "unchanged" : "uninstalled") : "residual",
    residualCount
  };
}

function buildReport(ok, packageVersion, dryRun, steps, filesystem, error = null) {
  return {
    ok,
    protocolVersion: V1_CLEAN_MACHINE_SMOKE_PROTOCOL_VERSION,
    packageVersion,
    dryRun,
    isolation: {
      temporaryHome: true,
      developerHomeUsed: false,
      serviceManagement: "isolated-skip"
    },
    summary: {
      passed: steps.filter((step) => step.ok).length,
      total: steps.length,
      finalState: filesystem.state,
      residualCount: filesystem.residualCount
    },
    steps,
    ...(error ? { error } : {})
  };
}

function failure(code, message, packageVersion = null) {
  return buildReport(false, packageVersion, false, [], { state: "not-started", residualCount: 0 }, { code, message });
}

function writeCodexStub(file) {
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

function safeStatus(value) {
  return typeof value === "string" && /^[a-z0-9-]{1,48}$/u.test(value) ? value : null;
}

function safeCode(value) {
  return typeof value === "string" && /^[A-Z0-9_]{1,64}$/u.test(value) ? value : "COMMAND_FAILED";
}

function countBoolean(value) {
  return value && typeof value === "object" ? Object.values(value).filter((item) => typeof item === "boolean").length : 0;
}

function countTrue(value) {
  return value && typeof value === "object" ? Object.values(value).filter((item) => item === true).length : 0;
}

function parseJson(value) {
  try { return JSON.parse(String(value || "").trim()); } catch { return null; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function isDirectory(value) {
  try { return fs.statSync(value).isDirectory(); } catch { return false; }
}

function isExecutable(value) {
  try { return fs.statSync(value).isFile() && (fs.statSync(value).mode & 0o111) !== 0; } catch { return false; }
}

function parseArgs(argv) {
  const options = { packageDir: null, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--package-dir") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("--package-dir requires a value");
      options.packageDir = argv[++index];
    } else if (arg.startsWith("--package-dir=")) options.packageDir = arg.slice("--package-dir=".length);
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

const mainFile = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (mainFile === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = options.help ? {
      ok: true,
      protocolVersion: V1_CLEAN_MACHINE_SMOKE_PROTOCOL_VERSION,
      usage: "node scripts/v1-clean-machine-smoke.js --package-dir <delivery-dir> [--dry-run]"
    } : runV1CleanMachineSmoke(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      protocolVersion: V1_CLEAN_MACHINE_SMOKE_PROTOCOL_VERSION,
      error: { code: "INVALID_ARGUMENT", message: error.message }
    })}\n`);
    process.exitCode = 2;
  }
}
