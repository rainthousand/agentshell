#!/usr/bin/env node
import path from "node:path";
import { spawnSync } from "node:child_process";

import { setupCodex } from "../src/commands/setup-codex.js";
import { DEFAULT_RELEASE_CHANNEL, normalizeReleaseChannel } from "../src/core/release-channel.js";

const root = path.resolve(import.meta.dirname, "..");

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
    "  node scripts/install-for-codex-user.js [--action install|update|uninstall|doctor] [--channel stable|beta] [--source <package>] [--dry-run] [--json]",
    "",
    "Stable is the default channel. Release downloads are SHA-256 verified, atomically installed, and rolled back after failed validation.",
    "--source keeps local package installation available for development and offline recovery.",
    "The installer only downloads release files and never uploads usage data.",
    "After success, open a new Codex thread."
  ].join("\n"));
  process.exit(0);
}

const steps = buildSteps(args);
const results = [];
for (const step of steps) {
  const result = await runStep(step, args);
  results.push(result);
  if (!result.ok) break;
}

const setupResult = results.find((step) => step.name === "setup-codex")?.details || null;
const report = {
  protocolVersion: "agentshell.codex-user-install.v1",
  ok: results.every((step) => step.ok),
  action: args.action,
  channel: args.channel,
  source: args.source ? { type: "local", path: args.source } : { type: "github-release" },
  dryRun: args.dryRun,
  installedVersion: setupResult?.release?.version || setupResult?.plugin?.version || null,
  release: setupResult?.release || {
    ok: true,
    status: args.dryRun && !args.source ? "would-resolve" : args.source ? "local-source" : "not-started",
    channel: args.channel,
    source: args.source ? "local" : "github-release",
    checksumVerified: false,
    dataUploaded: false
  },
  rollback: setupResult?.rollback || null,
  privacy: { dataUploaded: false, telemetry: "disabled" },
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
  const parsed = {
    action: "install",
    channel: DEFAULT_RELEASE_CHANNEL,
    source: null,
    dryRun: false,
    json: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--skip-link") continue;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--action") {
      parsed.action = requiredValue(argv, ++index, "--action");
      if (!["install", "update", "uninstall", "doctor"].includes(parsed.action)) {
        throw new Error("--action must be install, update, uninstall, or doctor");
      }
    } else if (arg === "--channel") {
      parsed.channel = normalizeReleaseChannel(requiredValue(argv, ++index, "--channel"));
    } else if (arg === "--source") {
      parsed.source = path.resolve(requiredValue(argv, ++index, "--source"));
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (parsed.source && argv.includes("--channel")) throw new Error("--channel and --source cannot be used together");
  return parsed;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function buildSteps(options) {
  if (options.action === "doctor" || options.action === "uninstall") {
    return [setupStep(options.action, options)];
  }
  return [
    checkNodeStep(),
    commandStep("codex-version", "Check Codex CLI", "codex", ["--version"]),
    setupStep(options.action, options),
    {
      name: "agent-policy",
      label: "Confirm global AgentShell policy",
      command: "node scripts/install-agent-policy.js --json",
      run: async () => success("Installed atomically by setup codex")
    }
  ];
}

function checkNodeStep() {
  return {
    name: "node-version",
    label: "Check Node.js 20+",
    run: async () => Number.parseInt(process.versions.node.split(".")[0], 10) >= 20
      ? success(`Node.js ${process.versions.node}`)
      : failure(`Node.js 20+ is required, found ${process.versions.node}`)
  };
}

function commandStep(name, label, command, commandArgs) {
  return {
    name,
    label,
    command: [command, ...commandArgs].join(" "),
    run: async () => {
      const result = runCommand(command, commandArgs);
      return result.ok
        ? success(result.message || `${command} ok`)
        : failure(result.message || `${command} failed`, { status: result.status });
    }
  };
}

function setupStep(action, options) {
  const sourceArgs = options.source ? ["--source", options.source] : ["--channel", options.channel];
  return {
    name: "setup-codex",
    label: `${action[0].toUpperCase()}${action.slice(1)} AgentShell`,
    command: ["agentshell", "setup", "codex", action, ...sourceArgs].join(" "),
    run: async () => {
      const result = await setupCodex(action, {
        channel: options.channel,
        ...(options.source ? { source: options.source, sourceMode: "local" } : { sourceMode: "remote" })
      });
      return result.ok
        ? success(`AgentShell ${action} completed`, result)
        : failure(result.error?.message || `AgentShell ${action} failed`, result);
    }
  };
}

function runCommand(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, encoding: "utf8" });
  return {
    ok: result.status === 0,
    status: result.status,
    message: firstUsefulLine(result.stdout) || firstUsefulLine(result.stderr) || result.error?.message || ""
  };
}

async function runStep(step, options) {
  if (options.dryRun) {
    return { name: step.name, label: step.label, status: "dry-run", ok: true, command: step.command || null };
  }
  const started = Date.now();
  const output = await step.run();
  return {
    name: step.name,
    label: step.label,
    status: output.ok ? "pass" : "fail",
    ok: output.ok,
    durationMs: Date.now() - started,
    message: output.message,
    command: step.command || null,
    ...(output.details ? { details: output.details } : {})
  };
}

function success(message, details) { return { ok: true, message, details }; }
function failure(message, details) { return { ok: false, message, details }; }

function printHumanReport(report) {
  console.log("\nAgentShell Codex Lifecycle\n==========================");
  console.log(`Channel: ${report.channel}${report.source.type === "local" ? " (local source)" : ""}`);
  if (report.dryRun) console.log("Preview only. No files, downloads, links, or Codex settings were changed.\n");
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
  const message = {
    protocolVersion: "agentshell.codex-user-install.v1",
    ok: false,
    channel: DEFAULT_RELEASE_CHANNEL,
    privacy: { dataUploaded: false, telemetry: "disabled" },
    error: error.message
  };
  if (argv.includes("--json")) console.log(JSON.stringify(message, null, 2));
  else console.error(`Install option error: ${error.message}\nRun node scripts/install-for-codex-user.js --help for supported flags.`);
}

function nextActionsFor(results, action) {
  const failed = results.find((step) => !step.ok);
  if (!failed) return action === "uninstall" ? ["Quit and reopen Codex."] : ["Open a new Codex thread."];
  if (failed.name === "codex-version") return ["Install or open Codex first, then retry."];
  return ["Run agentshell setup codex doctor.", `Retry npm run ${scriptFor(action)}.`];
}

function firstUsefulLine(text = "") {
  return String(text).trim().split(/\r?\n/u).find((line) => line.trim() && !line.startsWith(">")) || "";
}
