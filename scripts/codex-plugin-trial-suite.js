#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { collectCodexPluginTrials } from "./codex-plugin-trial-collect.js";

const PROTOCOL_VERSION = "agentshell.codex-plugin-trial-suite.v1";
const usage = "node scripts/codex-plugin-trial-suite.js --manifest suite.json [--report report.json] [--markdown report.md]";

export function runCodexPluginTrialSuite(manifest, options = {}) {
  const normalized = normalizeManifest(manifest, options.baseDir || process.cwd());
  const trials = normalized.runs.map((entry) => runSuiteEntry(entry, normalized.baseDir));
  const evidence = assessEvidence(trials);
  return {
    ok: evidence.placeholderRuns.length === 0,
    protocolVersion: PROTOCOL_VERSION,
    generatedAt: new Date().toISOString(),
    name: normalized.name,
    summary: summarize(trials),
    evidence,
    trials,
    purpose: "Aggregate real Codex new-thread AgentShell plugin runs into a stable product evidence report.",
    recommendation: recommendationFor(trials, evidence)
  };
}

function normalizeManifest(manifest, baseDir) {
  if (!manifest || typeof manifest !== "object") throw new Error("Codex plugin suite manifest must be an object");
  const runs = Array.isArray(manifest.runs) ? manifest.runs.map(normalizeSuiteEntry) : [];
  if (runs.length === 0) throw new Error("Codex plugin suite manifest requires at least one run entry");
  return {
    name: typeof manifest.name === "string" ? manifest.name : "codex-plugin-real-run-suite",
    baseDir,
    runs
  };
}

function normalizeSuiteEntry(entry, index) {
  if (!entry || typeof entry !== "object") throw new Error("Codex plugin suite run entries must be objects");
  if (!entry.path && !entry.input) throw new Error("Codex plugin suite run entries require path or input");
  return {
    id: typeof entry.id === "string" ? entry.id : `codex-run-${index + 1}`,
    path: typeof entry.path === "string" ? entry.path : null,
    input: entry.input || null,
    notes: typeof entry.notes === "string" ? entry.notes : null
  };
}

function runSuiteEntry(entry, baseDir) {
  const input = entry.input || readJson(path.resolve(baseDir, entry.path));
  const report = collectCodexPluginTrials([{ ...input, id: entry.id }]);
  const trial = report.trials[0];
  return {
    ...trial,
    id: entry.id,
    sourcePath: entry.path,
    evidence: evidenceForInput(input),
    notes: entry.notes || trial.notes
  };
}

function summarize(trials) {
  const byInterpretation = { strong: 0, usable: 0, weak: 0 };
  const byFixture = {};
  let totalScore = 0;
  let totalOutputTokens = 0;
  let totalDurationMs = 0;
  let totalAgentShellCommands = 0;
  let totalNoisyRawCommands = 0;
  let unobservedNoiseRuns = 0;

  for (const trial of trials) {
    byInterpretation[trial.interpretation] += 1;
    totalScore += trial.score;
    totalOutputTokens += trial.metrics.totalOutputTokens;
    totalDurationMs += trial.metrics.totalDurationMs;
    totalAgentShellCommands += trial.metrics.agentShellCommandCount;
    totalNoisyRawCommands += trial.metrics.noisyRawCommandCount;
    if (trial.observability?.nonAgentShellCommands === false) unobservedNoiseRuns += 1;

    const fixture = trial.fixture || "unknown";
    byFixture[fixture] ||= {
      total: 0,
      averageScore: 0,
      strong: 0,
      usable: 0,
      weak: 0,
      totalOutputTokens: 0,
      totalDurationMs: 0
    };
    const item = byFixture[fixture];
    item.total += 1;
    item.averageScore += trial.score;
    item[trial.interpretation] += 1;
    item.totalOutputTokens += trial.metrics.totalOutputTokens;
    item.totalDurationMs += trial.metrics.totalDurationMs;
  }

  for (const item of Object.values(byFixture)) {
    item.averageScore = Math.round(item.averageScore / item.total);
  }

  return {
    total: trials.length,
    averageScore: Math.round(totalScore / trials.length),
    strongRate: Math.round((byInterpretation.strong / trials.length) * 100),
    byInterpretation,
    byFixture,
    totalOutputTokens,
    totalDurationMs,
    averageOutputTokens: Math.round(totalOutputTokens / trials.length),
    averageDurationMs: Math.round(totalDurationMs / trials.length),
    totalAgentShellCommands,
    totalNoisyRawCommands,
    unobservedNoiseRuns
  };
}

function assessEvidence(trials) {
  const placeholderRuns = trials
    .filter((trial) => trial.evidence?.complete === false)
    .map((trial) => trial.id);
  const completedRuns = trials.length - placeholderRuns.length;
  return {
    status: placeholderRuns.length === 0 ? "complete" : "incomplete",
    completedRuns,
    placeholderRuns,
    claimReadiness: placeholderRuns.length === 0
      ? "ready-for-product-evidence"
      : "not-ready-fill-placeholder-run-logs"
  };
}

function evidenceForInput(input) {
  const placeholderFields = placeholderFieldsFor(input);
  return {
    complete: placeholderFields.length === 0,
    placeholderFields
  };
}

function placeholderFieldsFor(input) {
  const fields = [];
  const visit = (value, pathName) => {
    if (typeof value === "string" && isPlaceholderText(value)) {
      fields.push(pathName);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${pathName}[${index}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, pathName ? `${pathName}.${key}` : key);
    }
  };
  visit(input, "");
  return fields;
}

function isPlaceholderText(value) {
  return /PASTE_|REPLACE_WITH_|Fill this run log|Replace placeholders/i.test(value);
}

function recommendationFor(trials, evidence = assessEvidence(trials)) {
  if (evidence.placeholderRuns.length > 0) {
    return `Fill placeholder run logs before using this suite as product evidence: ${evidence.placeholderRuns.join(", ")}.`;
  }
  const summary = summarize(trials);
  if (summary.byInterpretation.strong === trials.length) {
    return "All real Codex plugin runs are strong; collect more fixtures or external-user runs before broad release claims.";
  }
  if (summary.byInterpretation.weak > 0) {
    return "At least one real Codex plugin run is weak; inspect first-command selection, compact output, verification, and rollback criteria.";
  }
  return "Real Codex plugin runs are usable but not uniformly strong; tighten skill guidance or fixture-specific workflow docs.";
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
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
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
  return [
    "# Codex Plugin Real-Run Suite",
    "",
    `Generated: ${report.generatedAt}`,
    `Name: ${report.name}`,
    `Runs: ${report.summary.total}`,
    `Average score: ${report.summary.averageScore}/100`,
    `Strong rate: ${report.summary.strongRate}%`,
    `Average output tokens: ${report.summary.averageOutputTokens}`,
    `Average duration: ${report.summary.averageDurationMs}ms`,
    `Evidence status: ${report.evidence.status}`,
    `Claim readiness: ${report.evidence.claimReadiness}`,
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
    `- Runs with unobserved non-AgentShell commands: ${report.summary.unobservedNoiseRuns}`,
    `- Completed runs: ${report.evidence.completedRuns}`,
    `- Placeholder runs: ${report.evidence.placeholderRuns.length}`,
    "",
    "## Fixtures",
    "",
    "| Fixture | Runs | Avg score | Strong | Usable | Weak | Tokens | Duration ms |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(report.summary.byFixture).map(([fixture, item]) => (
      `| ${tableCell(fixture)} | ${item.total} | ${item.averageScore} | ${item.strong} | ${item.usable} | ${item.weak} | ${item.totalOutputTokens} | ${item.totalDurationMs} |`
    )),
    "",
    "## Runs",
    "",
    "| Run | Fixture | Score | Interpretation | Tokens | Duration ms |",
    "|---|---|---:|---|---:|---:|",
    ...report.trials.map((trial) => (
      `| ${tableCell(trial.id)} | ${tableCell(trial.fixture || "-")} | ${trial.score} | ${trial.interpretation} | ${trial.metrics.totalOutputTokens} | ${trial.metrics.totalDurationMs} |`
    )),
    "",
    `Recommendation: ${report.recommendation}`,
    ""
  ].join("\n");
}

function tableCell(value) {
  return String(value).replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

if (process.argv[1] === import.meta.filename) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(JSON.stringify({ ok: true, usage }, null, 2));
    process.exit(0);
  }

  const report = runCodexPluginTrialSuite(readJson(options.manifest), {
    baseDir: path.dirname(options.manifest)
  });
  if (options.report) writeJsonFile(options.report, report);
  if (options.markdown) writeTextFile(options.markdown, renderMarkdownReport(report));
  console.log(JSON.stringify(report, null, 2));
}
