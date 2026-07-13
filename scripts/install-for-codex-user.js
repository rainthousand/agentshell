#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  printArgumentError(error, process.argv.slice(2));
  process.exit(1);
}
const root = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(root, ".codex-plugin", "plugin.json");
const steps = buildSteps(args);
const results = [];

if (args.help) {
  console.log([
    "AgentShell Codex installer",
    "",
    "Usage:",
    "  npm run install:codex",
    "  node scripts/install-for-codex-user.js [--dry-run] [--skip-link] [--json]",
    "",
    "What it does:",
    "  1. Checks Node.js and Codex CLI availability.",
    "  2. Links the agentshell command with npm link.",
    "  3. Refreshes the local plugin cachebuster.",
    "  4. Installs AgentShell into Codex's personal marketplace.",
    "  5. Installs the global Codex AgentShell policy.",
    "  6. Runs installed-plugin smoke checks.",
    "",
    "After success, open a new Codex thread.",
    "No manual Codex configuration is needed."
  ].join("\n"));
  process.exit(0);
}

for (const step of steps) {
  const result = runStep(step, args);
  results.push(result);
  if (!result.ok) break;
}

const report = {
  protocolVersion: "agentshell.codex-user-install.v1",
  ok: results.every((step) => step.ok),
  dryRun: args.dryRun,
  installedVersion: readPluginVersion(),
  summary: {
    total: results.length,
    passed: results.filter((step) => step.ok).length,
    failed: results.filter((step) => !step.ok).length
  },
  steps: results,
  nextActions: nextActionsFor(results)
};

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printHumanReport(report);
}

if (!report.ok) process.exitCode = 1;

function parseArgs(argv) {
  const parsed = {
    dryRun: false,
    skipLink: false,
    json: false,
    help: false
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--skip-link") {
      parsed.skipLink = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function buildSteps(options) {
  return [
    {
      name: "node-version",
      label: "Check Node.js 20+",
      run: () => {
        const major = Number.parseInt(process.versions.node.split(".")[0], 10);
        return major >= 20
          ? success(`Node.js ${process.versions.node}`)
          : failure(`Node.js 20+ is required, found ${process.versions.node}`);
      }
    },
    commandStep("codex-version", "Check Codex CLI", "codex", ["--version"]),
    commandStep("npm-link", "Put agentshell on PATH", "npm", ["link"], { skipped: options.skipLink, skipReason: "--skip-link" }),
    {
      name: "cachebuster",
      label: "Refresh plugin version",
      run: () => {
        const before = readPluginVersion();
        const after = updateCachebuster();
        return success(`${before} -> ${after}`);
      }
    },
    commandStep("source-validate", "Validate plugin source", "node", ["src/cli.js", "plugin", "validate", "--source-only", "--compact"]),
    commandStep("install-local", "Install local marketplace copy", "node", ["scripts/install-codex-plugin.js"]),
    commandStep("codex-add", "Add plugin to Codex", "codex", ["plugin", "add", "agentshell@personal"]),
    commandStep("agent-policy", "Install global AgentShell policy", "node", ["scripts/install-agent-policy.js", "--json"]),
    commandStep("plugin-smoke", "Run installed plugin smoke", "node", ["scripts/plugin-smoke.js"]),
    commandStep("plugin-validate", "Validate installed plugin", "node", ["src/cli.js", "plugin", "validate", "--compact"])
  ];
}

function commandStep(name, label, command, commandArgs, options = {}) {
  return {
    name,
    label,
    command: [command, ...commandArgs].join(" "),
    skipped: options.skipped,
    skipReason: options.skipReason,
    run: () => {
      const result = spawnSync(command, commandArgs, {
        cwd: root,
        encoding: "utf8"
      });
      if (result.status === 0) {
        return success(firstUsefulLine(result.stdout) || `${command} ok`);
      }
      return failure(firstUsefulLine(result.stderr) || firstUsefulLine(result.stdout) || result.error?.message || `${command} failed`, {
        status: result.status,
        stdout: trimOutput(result.stdout),
        stderr: trimOutput(result.stderr)
      });
    }
  };
}

function runStep(step, options) {
  if (options.dryRun) {
    return {
      name: step.name,
      label: step.label,
      status: "dry-run",
      ok: true,
      command: step.command || null
    };
  }

  if (step.skipped) {
    return {
      name: step.name,
      label: step.label,
      status: "skipped",
      ok: true,
      reason: step.skipReason,
      command: step.command || null
    };
  }

  const started = Date.now();
  const output = step.run();
  return {
    name: step.name,
    label: step.label,
    status: output.ok ? "pass" : "fail",
    ok: output.ok,
    durationMs: Date.now() - started,
    message: output.message,
    command: step.command || null,
    details: output.details || undefined
  };
}

function success(message) {
  return { ok: true, message };
}

function failure(message, details) {
  return { ok: false, message, details };
}

function readPluginVersion() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return manifest.version;
}

function updateCachebuster() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const base = String(manifest.version || "0.0.0").split("+")[0];
  manifest.version = `${base}+codex.${timestamp()}`;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.version;
}

function timestamp() {
  const now = new Date();
  const parts = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    String(now.getUTCHours()).padStart(2, "0"),
    String(now.getUTCMinutes()).padStart(2, "0"),
    String(now.getUTCSeconds()).padStart(2, "0")
  ];
  return parts.join("");
}

function printHumanReport(report) {
  console.log("");
  console.log("AgentShell Codex Installer");
  console.log("==========================");
  if (report.dryRun) {
    console.log("Preview only. No files, links, or Codex settings were changed.");
    console.log("");
  }
  for (const step of report.steps) {
    const mark = step.status === "dry-run" ? "PLAN" : step.ok ? "OK" : "NEEDS ACTION";
    console.log(`[${mark}] ${step.label}${step.message ? ` - ${step.message}` : ""}`);
  }
  console.log("");
  if (report.dryRun) {
    console.log("Dry run complete. Run `npm run install:codex` without `--dry-run` to install.");
    return;
  }
  if (report.ok) {
    console.log("AgentShell is installed and configured for Codex.");
    console.log(`Plugin version: ${report.installedVersion}`);
    console.log("");
    console.log("No manual Codex configuration is needed; the plugin and global AgentShell policy were installed for you.");
    for (const action of report.nextActions) console.log(`Next: ${action}`);
  } else {
    const failed = report.steps.find((step) => !step.ok);
    console.log("Install needs attention.");
    if (failed?.command) console.log(`Failed command: ${failed.command}`);
    if (failed?.message) console.log(`Reason: ${failed.message}`);
    console.log("");
    for (const action of report.nextActions) console.log(`Next: ${action}`);
  }
}

function printArgumentError(error, argv) {
  if (argv.includes("--json")) {
    console.log(JSON.stringify({
      protocolVersion: "agentshell.codex-user-install.v1",
      ok: false,
      dryRun: argv.includes("--dry-run"),
      error: error.message,
      nextActions: [
        "Run node scripts/install-for-codex-user.js --help to see supported flags."
      ]
    }, null, 2));
    return;
  }

  console.error(`Install option error: ${error.message}`);
  console.error("Run `node scripts/install-for-codex-user.js --help` to see supported flags.");
}

function nextActionsFor(results) {
  const failed = results.find((step) => !step.ok);
  if (!failed) {
    return [
      "Open a new Codex thread.",
      "Ask for a coding task normally; Codex should now prefer AgentShell automatically.",
      "If behavior looks stale, run npm run install:codex again from this folder."
    ];
  }
  if (failed.name === "codex-version") {
    return [
      "Install or open Codex first, then run npm run install:codex again.",
      "If Codex is installed but not on PATH, restart the terminal and retry."
    ];
  }
  if (failed.name === "npm-link") {
    return [
      "Run npm run install:codex -- --skip-link if you do not need the agentshell command on PATH.",
      "Otherwise check Node.js/npm permissions and retry."
    ];
  }
  if (failed.name === "agent-policy") {
    return [
      "Run npm run install:agent-policy to retry the global Codex policy step.",
      "Then open a new Codex thread."
    ];
  }
  return [
    "Review the failed command above.",
    "Run npm run install:codex again after fixing the issue.",
    "If the plugin installed but Codex behavior is stale, open a new Codex thread."
  ];
}

function firstUsefulLine(text) {
  return trimOutput(text).split(/\r?\n/).find((line) => line.trim() && !line.startsWith(">")) || "";
}

function trimOutput(text = "") {
  return String(text).trim().slice(0, 2000);
}
