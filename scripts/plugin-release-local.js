#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PLUGIN_RELEASE_LOCAL_PROTOCOL_VERSION = "agentshell.plugin-release-local.v1";
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(formatHelp());
  process.exit(0);
}

const steps = buildSteps(args);
const startedAt = new Date().toISOString();
const results = [];

for (const step of steps) {
  const result = runStep(step, args);
  results.push(result);
  if (!result.ok) break;
}

const report = {
  ok: results.every((step) => step.ok),
  protocolVersion: PLUGIN_RELEASE_LOCAL_PROTOCOL_VERSION,
  dryRun: args.dryRun,
  skipCodexAdd: args.skipCodexAdd,
  startedAt,
  finishedAt: new Date().toISOString(),
  plugin: pluginFromSteps(results),
  steps: results
};
const outputReport = args.compact ? compactReport(report) : report;

if (args.reportPath) {
  fs.mkdirSync(path.dirname(args.reportPath), { recursive: true });
  fs.writeFileSync(args.reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(outputReport, null, 2));
if (!report.ok) process.exitCode = 1;

function parseArgs(argv) {
  const parsed = {
    dryRun: false,
    skipCodexAdd: false,
    compact: false,
    reportPath: null,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--skip-codex-add") {
      parsed.skipCodexAdd = true;
      continue;
    }
    if (arg === "--compact") {
      parsed.compact = true;
      continue;
    }
    if (arg === "--report") {
      parsed.reportPath = requirePathValue(argv[index + 1], arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--report=")) {
      parsed.reportPath = requirePathValue(arg.slice("--report=".length), "--report");
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (parsed.reportPath) parsed.reportPath = path.resolve(parsed.reportPath);
  return parsed;
}

function requirePathValue(value, flag) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a path`);
  }
  return value;
}

function buildSteps(options) {
  return [
    npmStep("plugin:cachebust"),
    npmStep("plugin:validate:source"),
    npmStep("plugin:install-local"),
    {
      name: "npm-link",
      command: "npm",
      args: ["link"]
    },
    {
      name: "codex-add",
      command: "codex",
      args: ["plugin", "add", "agentshell@personal"],
      skipped: options.skipCodexAdd,
      skipReason: "--skip-codex-add"
    },
    npmStep("plugin:doctor-local"),
    npmStep("plugin:smoke"),
    npmStep("plugin:smoke:markdown")
  ];
}

function npmStep(scriptName) {
  return {
    name: scriptName,
    command: "npm",
    args: ["run", scriptName]
  };
}

function runStep(step, options) {
  const commandLine = [step.command, ...step.args].join(" ");

  if (options.dryRun) {
    return {
      name: step.name,
      command: commandLine,
      status: "dry-run",
      ok: true
    };
  }

  if (step.skipped) {
    return {
      name: step.name,
      command: commandLine,
      status: "skipped",
      ok: true,
      reason: step.skipReason
    };
  }

  const started = Date.now();
  const result = spawnSync(step.command, step.args, {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  return {
    name: step.name,
    command: commandLine,
    status: result.status,
    ok: result.status === 0,
    durationMs: Date.now() - started,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    error: result.error?.message
  };
}

function formatHelp() {
  return JSON.stringify({
    ok: true,
    usage: "node scripts/plugin-release-local.js [--dry-run] [--skip-codex-add] [--compact] [--report <path>]",
    steps: buildSteps({ skipCodexAdd: false }).map((step) => [step.command, ...step.args].join(" "))
  });
}

function compactReport(report) {
  const failedStep = report.steps.find((step) => !step.ok) || null;
  return {
    ok: report.ok,
    protocolVersion: report.protocolVersion,
    compact: true,
    status: report.ok ? "ready" : "blocked",
    dryRun: report.dryRun,
    skipCodexAdd: report.skipCodexAdd,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    durationMs: elapsedMs(report.startedAt, report.finishedAt),
    plugin: report.plugin,
    summary: {
      total: report.steps.length,
      passed: report.steps.filter((step) => step.ok).length,
      failed: report.steps.filter((step) => !step.ok).length,
      skipped: report.steps.filter((step) => step.status === "skipped").length
    },
    failedStep: failedStep
      ? {
          name: failedStep.name,
          status: failedStep.status,
          error: failedStep.error || null
        }
      : null,
    steps: report.steps.map((step) => ({
      name: step.name,
      status: step.status,
      ok: step.ok,
      durationMs: step.durationMs,
      reason: step.reason,
      error: step.error
    }))
  };
}

function pluginFromSteps(steps) {
  const doctor = steps.find((step) => step.name === "plugin:doctor-local" && step.ok && step.stdout);
  if (!doctor) return null;
  try {
    const parsed = parseJsonFromOutput(doctor.stdout);
    if (!parsed?.plugin || typeof parsed.plugin !== "object") return null;
    return {
      name: parsed.plugin.name || null,
      version: parsed.plugin.version || null,
      authorName: parsed.plugin.authorName || null,
      developerName: parsed.plugin.developerName || null
    };
  } catch {
    return null;
  }
}

function parseJsonFromOutput(output) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return JSON.parse(output.slice(start, end + 1));
}

function elapsedMs(startedAt, finishedAt) {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return null;
  return Math.max(0, finished - started);
}
