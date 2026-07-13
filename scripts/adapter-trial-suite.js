#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { scoreAdapterTrial } from "./adapter-trial.js";
import { collectAdapterTrial } from "./adapter-trial-collect.js";

const PROTOCOL_VERSION = "agentshell.adapter-trial-suite.v1";
const usage = "node scripts/adapter-trial-suite.js --manifest suite.json [--report report.json] [--markdown report.md]";

export function runAdapterTrialSuite(manifest, options = {}) {
  const normalized = normalizeManifest(manifest, options.baseDir || process.cwd());
  const trials = normalized.trials.map((entry) => runSuiteEntry(entry, normalized.baseDir));
  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    generatedAt: new Date().toISOString(),
    name: normalized.name,
    summary: summarize(trials),
    trials
  };
}

function parseArgs(args) {
  let manifest = null;
  let report = null;
  let markdown = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--manifest") {
      manifest = path.resolve(process.cwd(), requireValue(args[index + 1], "--manifest"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--manifest=")) {
      manifest = path.resolve(process.cwd(), requireValue(arg.slice("--manifest=".length), "--manifest"));
      continue;
    }
    if (arg === "--report") {
      report = path.resolve(process.cwd(), requireValue(args[index + 1], "--report"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--report=")) {
      report = path.resolve(process.cwd(), requireValue(arg.slice("--report=".length), "--report"));
      continue;
    }
    if (arg === "--markdown") {
      markdown = path.resolve(process.cwd(), requireValue(args[index + 1], "--markdown"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--markdown=")) {
      markdown = path.resolve(process.cwd(), requireValue(arg.slice("--markdown=".length), "--markdown"));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!manifest) throw new Error("--manifest is required");
  return { manifest, report, markdown };
}

function requireValue(value, flag) {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function normalizeManifest(manifest, baseDir) {
  if (!manifest || typeof manifest !== "object") throw new Error("Suite manifest must be an object");
  const trials = Array.isArray(manifest.trials) ? manifest.trials.map(normalizeSuiteEntry) : [];
  if (trials.length === 0) throw new Error("Suite manifest requires at least one trial entry");
  return {
    name: typeof manifest.name === "string" ? manifest.name : "adapter-trial-suite",
    baseDir,
    trials
  };
}

function normalizeSuiteEntry(entry, index) {
  if (!entry || typeof entry !== "object") throw new Error("Suite trial entries must be objects");
  const kind = entry.kind || "trial";
  if (kind !== "trial" && kind !== "collect") throw new Error(`Unsupported suite entry kind: ${kind}`);
  if (!entry.path && !entry.input) throw new Error("Suite trial entries require path or input");
  return {
    id: typeof entry.id === "string" ? entry.id : `trial-${index + 1}`,
    kind,
    path: typeof entry.path === "string" ? entry.path : null,
    input: entry.input || null,
    notes: typeof entry.notes === "string" ? entry.notes : null
  };
}

function runSuiteEntry(entry, baseDir) {
  const input = entry.input || readJson(path.resolve(baseDir, entry.path));
  const report = entry.kind === "collect"
    ? collectAdapterTrial(input).scoreReport
    : scoreAdapterTrial(input);
  return {
    id: entry.id,
    kind: entry.kind,
    sourcePath: entry.path,
    host: report.host,
    fixture: report.fixture,
    score: report.score,
    interpretation: report.interpretation,
    metrics: report.metrics,
    criteria: report.criteria,
    notes: entry.notes || report.notes
  };
}

function summarize(trials) {
  const byHost = {};
  const byInterpretation = { strong: 0, usable: 0, weak: 0 };
  let totalScore = 0;
  let totalOutputTokens = 0;
  let totalDurationMs = 0;
  let totalAgentShellCommands = 0;
  let totalNoisyRawCommands = 0;

  for (const trial of trials) {
    byHost[trial.host] ||= {
      total: 0,
      averageScore: 0,
      strong: 0,
      usable: 0,
      weak: 0,
      totalOutputTokens: 0,
      totalDurationMs: 0
    };
    const host = byHost[trial.host];
    host.total += 1;
    host[trial.interpretation] += 1;
    host.totalOutputTokens += trial.metrics.totalOutputTokens;
    host.totalDurationMs += trial.metrics.totalDurationMs;
    host.averageScore += trial.score;

    byInterpretation[trial.interpretation] += 1;
    totalScore += trial.score;
    totalOutputTokens += trial.metrics.totalOutputTokens;
    totalDurationMs += trial.metrics.totalDurationMs;
    totalAgentShellCommands += trial.metrics.agentShellCommandCount;
    totalNoisyRawCommands += trial.metrics.noisyRawCommandCount;
  }

  for (const host of Object.values(byHost)) {
    host.averageScore = Math.round(host.averageScore / host.total);
  }

  return {
    total: trials.length,
    averageScore: Math.round(totalScore / trials.length),
    byInterpretation,
    byHost,
    totalOutputTokens,
    totalDurationMs,
    totalAgentShellCommands,
    totalNoisyRawCommands
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value.endsWith("\n") ? value : `${value}\n`);
}

function renderMarkdownReport(report) {
  const lines = [
    "# AgentShell Adapter Trial Suite",
    "",
    `Generated: ${report.generatedAt}`,
    `Name: ${report.name}`,
    `Trials: ${report.summary.total}`,
    `Average score: ${report.summary.averageScore}/100`,
    "",
    "## Summary",
    "",
    `- Strong: ${report.summary.byInterpretation.strong}`,
    `- Usable: ${report.summary.byInterpretation.usable}`,
    `- Weak: ${report.summary.byInterpretation.weak}`,
    `- Total output tokens: ${report.summary.totalOutputTokens}`,
    `- Total duration: ${report.summary.totalDurationMs}ms`,
    `- AgentShell commands: ${report.summary.totalAgentShellCommands}`,
    `- Noisy raw commands: ${report.summary.totalNoisyRawCommands}`,
    "",
    "## Hosts",
    "",
    "| Host | Trials | Avg score | Strong | Usable | Weak | Tokens | Duration ms |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(report.summary.byHost).map(([host, item]) => (
      `| ${tableCell(host)} | ${item.total} | ${item.averageScore} | ${item.strong} | ${item.usable} | ${item.weak} | ${item.totalOutputTokens} | ${item.totalDurationMs} |`
    )),
    "",
    "## Trials",
    "",
    "| ID | Host | Fixture | Score | Interpretation | Tokens | Duration ms |",
    "|---|---|---|---:|---|---:|---:|",
    ...report.trials.map((trial) => (
      `| ${tableCell(trial.id)} | ${tableCell(trial.host)} | ${tableCell(trial.fixture || "-")} | ${trial.score} | ${trial.interpretation} | ${trial.metrics.totalOutputTokens} | ${trial.metrics.totalDurationMs} |`
    ))
  ];
  return lines.join("\n");
}

function tableCell(value) {
  return String(value).replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

if (process.argv[1] === import.meta.filename) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(JSON.stringify({ ok: true, usage }));
    process.exit(0);
  }

  const report = runAdapterTrialSuite(readJson(options.manifest), {
    baseDir: path.dirname(options.manifest)
  });
  if (options.report) writeJsonFile(options.report, report);
  if (options.markdown) writeTextFile(options.markdown, renderMarkdownReport(report));
  console.log(JSON.stringify(report, null, 2));
}
