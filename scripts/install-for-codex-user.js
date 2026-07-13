#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(root, ".codex-plugin", "plugin.json");

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  printArgumentError(error, process.argv.slice(2));
  process.exit(1);
}

if (args.help) {
  console.log([
    "AgentShell Codex lifecycle",
    "",
    "Usage:",
    "  npm run install:codex",
    "  npm run update:codex",
    "  npm run uninstall:codex",
    "  npm run doctor:codex",
    "  node scripts/install-for-codex-user.js [--action install|update|uninstall|doctor] [--dry-run] [--skip-link] [--json]",
    "",
    "Install and update use atomic staging, retain three backups, and roll back when post-install validation fails.",
    "After success, open a new Codex thread."
  ].join("\n"));
  process.exit(0);
}

const versionBefore = readPluginVersion();
const steps = buildSteps(args);
const results = [];
for (const step of steps) {
  const result = runStep(step, args);
  results.push(result);
  if (!result.ok) break;
}

let rollback = null;
if (!args.dryRun && results.some((step) => step.name === "install-local" && step.ok) && results.some((step) => !step.ok)) {
  rollback = runCommand("node", ["scripts/plugin-lifecycle.js", "rollback"]);
  restorePluginVersion(versionBefore);
}

const report = {
  protocolVersion: "agentshell.codex-user-install.v1",
  ok: results.every((step) => step.ok),
  action: args.action,
  dryRun: args.dryRun,
  installedVersion: readPluginVersion(),
  rollback,
  summary: {
    total: results.length,
    passed: results.filter((step) => step.ok).length,
    failed: results.filter((step) => !step.ok).length
  },
  steps: results,
  nextActions: nextActionsFor(results, args.action)
};

if (args.json) console.log(JSON.stringify(report, null, 2));
else printHumanReport(report);
if (!report.ok) process.exitCode = 1;

function parseArgs(argv) {
  const parsed = { action: "install", dryRun: false, skipLink: false, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--skip-link") parsed.skipLink = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--action") {
      parsed.action = argv[++index];
      if (!["install", "update", "uninstall", "doctor"].includes(parsed.action)) {
        throw new Error("--action must be install, update, uninstall, or doctor");
      }
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function buildSteps(options) {
  if (options.action === "uninstall") {
    return [
      commandStep("dashboard-stop", "Stop AgentShell Dashboard", "node", ["src/cli.js", "dashboard", "--stop"]),
      commandStep("uninstall-local", "Remove AgentShell managed files", "node", ["scripts/plugin-lifecycle.js", "uninstall"])
    ];
  }
  if (options.action === "doctor") {
    return [commandStep("lifecycle-doctor", "Check AgentShell installation", "node", ["scripts/plugin-lifecycle.js", "doctor"])];
  }
  return [
    checkNodeStep(),
    commandStep("codex-version", "Check Codex CLI", "codex", ["--version"]),
    commandStep("dashboard-stop", "Stop previous AgentShell Dashboard", "node", ["src/cli.js", "dashboard", "--stop"]),
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
    commandStep("install-local", "Atomically install marketplace copy", "node", ["scripts/install-codex-plugin.js"]),
    commandStep("codex-add", "Add plugin to Codex", "codex", ["plugin", "add", "agentshell@personal"]),
    commandStep("agent-policy", "Install global AgentShell policy", "node", ["scripts/install-agent-policy.js", "--json"]),
    commandStep("plugin-smoke", "Run installed plugin smoke", "node", ["scripts/plugin-smoke.js"]),
    commandStep("plugin-validate", "Validate installed plugin", "node", ["src/cli.js", "plugin", "validate", "--compact"])
  ];
}

function checkNodeStep() {
  return {
    name: "node-version",
    label: "Check Node.js 20+",
    run: () => Number.parseInt(process.versions.node.split(".")[0], 10) >= 20
      ? success(`Node.js ${process.versions.node}`)
      : failure(`Node.js 20+ is required, found ${process.versions.node}`)
  };
}

function commandStep(name, label, command, commandArgs, options = {}) {
  return {
    name,
    label,
    command: [command, ...commandArgs].join(" "),
    skipped: options.skipped,
    skipReason: options.skipReason,
    run: () => {
      const result = runCommand(command, commandArgs);
      return result.ok
        ? success(result.message || `${command} ok`)
        : failure(result.message || `${command} failed`, { status: result.status });
    }
  };
}

function runCommand(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, encoding: "utf8" });
  return {
    ok: result.status === 0,
    command: [command, ...commandArgs].join(" "),
    status: result.status,
    message: firstUsefulLine(result.stdout) || firstUsefulLine(result.stderr) || result.error?.message || ""
  };
}

function runStep(step, options) {
  if (options.dryRun) return { name: step.name, label: step.label, status: "dry-run", ok: true, command: step.command || null };
  if (step.skipped) return { name: step.name, label: step.label, status: "skipped", ok: true, reason: step.skipReason, command: step.command || null };
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
    details: output.details
  };
}

function success(message) { return { ok: true, message }; }
function failure(message, details) { return { ok: false, message, details }; }

function readPluginVersion() {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")).version;
}

function updateCachebuster() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const base = String(manifest.version || "0.0.0").split("+")[0];
  manifest.version = `${base}+codex.${new Date().toISOString().replace(/[-:.TZ]/g, "")}`;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.version;
}

function restorePluginVersion(version) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.version = version;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function printHumanReport(report) {
  console.log("\nAgentShell Codex Lifecycle\n==========================");
  if (report.dryRun) console.log("Preview only. No files, links, or Codex settings were changed.\n");
  for (const step of report.steps) {
    const mark = step.status === "dry-run" ? "PLAN" : step.ok ? "OK" : "NEEDS ACTION";
    console.log(`[${mark}] ${step.label}${step.message ? ` - ${step.message}` : ""}`);
  }
  console.log("");
  if (report.dryRun) {
    console.log(`Dry run complete. Run \`npm run ${scriptFor(report.action)}\` without \`--dry-run\` to ${report.action}.`);
  } else if (report.ok) {
    console.log(report.action === "uninstall" ? "AgentShell managed files were removed." : `AgentShell ${report.action} completed.`);
    for (const action of report.nextActions) console.log(`Next: ${action}`);
  } else {
    console.log(report.rollback?.ok ? "The previous installation was restored automatically." : "Install needs attention. Lifecycle action did not complete.");
    const failed = report.steps.find((step) => !step.ok);
    if (failed?.command) console.log(`Failed command: ${failed.command}`);
    for (const action of report.nextActions) console.log(`Next: ${action}`);
  }
}

function scriptFor(action) {
  return action === "install" ? "install:codex" : `${action}:codex`;
}

function printArgumentError(error, argv) {
  const message = { protocolVersion: "agentshell.codex-user-install.v1", ok: false, error: error.message };
  if (argv.includes("--json")) console.log(JSON.stringify(message, null, 2));
  else console.error(`Install option error: ${error.message}\nRun node scripts/install-for-codex-user.js --help for supported flags.`);
}

function nextActionsFor(results, action) {
  const failed = results.find((step) => !step.ok);
  if (!failed) return action === "uninstall" ? ["Quit and reopen Codex."] : ["Open a new Codex thread."];
  if (failed.name === "codex-version") return ["Install or open Codex first, then retry."];
  return ["Run npm run doctor:codex.", `Retry npm run ${scriptFor(action)}.`];
}

function firstUsefulLine(text = "") {
  return String(text).trim().split(/\r?\n/).find((line) => line.trim() && !line.startsWith(">")) || "";
}
