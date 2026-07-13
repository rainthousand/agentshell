#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { collectAdapterTrial } from "./adapter-trial-collect.js";

const PROTOCOL_VERSION = "agentshell.codex-plugin-trial.v1";
const usage = "node scripts/codex-plugin-trial-collect.js --input run-log.json [--input run-log-2.json] [--manifest suite.json] [--report report.json] [--markdown report.md]";

export function collectCodexPluginTrials(inputs, options = {}) {
  const normalizedInputs = normalizeInputs(inputs, options);
  const trials = normalizedInputs.map((entry, index) => collectOne(entry, index));
  const evidence = assessEvidence(trials);
  const compactReport = compactReportFor(trials, evidence);
  return {
    ok: evidence.placeholderRuns.length === 0,
    protocolVersion: PROTOCOL_VERSION,
    generatedAt: new Date().toISOString(),
    name: typeof options.name === "string" ? options.name : "codex-plugin-real-run",
    summary: summarize(trials),
    compactReport,
    evidence,
    trials,
    purpose: "Collect real Codex new-thread plugin runs and score whether Codex used AgentShell early, compactly, safely, and successfully.",
    recommendation: recommendationFor(trials, evidence)
  };
}

function collectOne(entry, index) {
  const input = {
    ...entry.input,
    host: entry.input.host || "codex"
  };
  if (input.host !== "codex") throw new Error(`Codex plugin trial input must use host \"codex\", got: ${input.host}`);
  const collected = collectAdapterTrial(input);
  const report = applyObservability(collected.scoreReport, input);
  return {
    id: typeof input.id === "string" ? input.id : `codex-new-thread-${index + 1}`,
    kind: "collect",
    sourcePath: entry.sourcePath,
    host: report.host,
    fixture: report.fixture,
    score: report.score,
    interpretation: report.interpretation,
    metrics: report.metrics,
    criteria: report.criteria,
    finalVerification: report.finalVerification,
    observability: report.observability,
    evidence: evidenceForInput(input),
    notes: input.notes || report.notes
  };
}

function normalizeInputs(inputs, options = {}) {
  const baseDir = options.baseDir || process.cwd();
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("At least one input is required");
  return inputs.map((input, index) => {
    if (typeof input === "string") {
      const inputPath = path.resolve(baseDir, input);
      return {
        sourcePath: inputPath,
        input: readJson(inputPath)
      };
    }
    if (!input || typeof input !== "object") throw new Error(`Invalid input at index ${index}`);
    return {
      sourcePath: null,
      input
    };
  });
}

function summarize(trials) {
  const byHost = {};
  const byInterpretation = { strong: 0, usable: 0, weak: 0 };
  let totalScore = 0;
  let totalOutputTokens = 0;
  let totalDurationMs = 0;
  let totalAgentShellCommands = 0;
  let totalNoisyRawCommands = 0;
  let unobservedNoiseRuns = 0;

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
    if (trial.observability?.nonAgentShellCommands === false) unobservedNoiseRuns += 1;
  }

  for (const host of Object.values(byHost)) {
    host.averageScore = Math.round(host.averageScore / host.total);
  }

  return {
    total: trials.length,
    averageScore: Math.round(totalScore / trials.length),
    successRate: successRateFor(trials),
    byInterpretation,
    byHost,
    totalOutputTokens,
    totalDurationMs,
    averageOutputTokens: Math.round(totalOutputTokens / trials.length),
    averageDurationMs: Math.round(totalDurationMs / trials.length),
    totalAgentShellCommands,
    totalNoisyRawCommands,
    unobservedNoiseRuns
  };
}

function compactReportFor(trials, evidence) {
  const summary = summarize(trials);
  return {
    runs: summary.total,
    completedRuns: evidence.completedRuns,
    placeholderRuns: evidence.placeholderRuns.length,
    successRate: summary.successRate,
    averageScore: summary.averageScore,
    strongRate: Math.round((summary.byInterpretation.strong / summary.total) * 100),
    tokens: {
      total: summary.totalOutputTokens,
      averagePerRun: summary.averageOutputTokens
    },
    speed: {
      totalDurationMs: summary.totalDurationMs,
      averageDurationMs: summary.averageDurationMs
    },
    commands: {
      totalAgentShell: summary.totalAgentShellCommands,
      totalNoisyRaw: summary.totalNoisyRawCommands,
      unobservedNoiseRuns: summary.unobservedNoiseRuns
    },
    evidenceStatus: evidence.status,
    claimReadiness: evidence.claimReadiness
  };
}

function applyObservability(report, input) {
  const observesNonAgentShell = input.evidenceMetadata?.captureScope?.nonAgentShellCommands !== false;
  if (observesNonAgentShell) {
    return {
      ...report,
      observability: {
        nonAgentShellCommands: true,
        noiseControl: "observed",
        scoreAdjustment: 0
      }
    };
  }

  const previousPoints = report.criteria.noiseControl?.points || 0;
  const score = Math.max(0, report.score - previousPoints);
  return {
    ...report,
    score,
    interpretation: interpretationFor(score),
    criteria: {
      ...report.criteria,
      noiseControl: {
        points: 0,
        max: report.criteria.noiseControl?.max || 10,
        ok: false,
        reason: "non-AgentShell commands were outside exporter telemetry coverage"
      }
    },
    observability: {
      nonAgentShellCommands: false,
      noiseControl: "unobserved",
      scoreAdjustment: -previousPoints
    }
  };
}

function interpretationFor(score) {
  if (score >= 85) return "strong";
  if (score >= 65) return "usable";
  return "weak";
}

function successRateFor(trials) {
  const successes = trials.filter((trial) => trial.finalVerification?.ok === true).length;
  return Math.round((successes / trials.length) * 100);
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
    return `Fill placeholder run logs before using this collector report as product evidence: ${evidence.placeholderRuns.join(", ")}.`;
  }
  const strong = trials.filter((trial) => trial.interpretation === "strong").length;
  if (strong === trials.length) return "Real Codex plugin runs are strong; keep collecting new-thread samples across more fixtures.";
  if (strong > 0) return "Some real Codex plugin runs are strong; inspect weaker trials for first-command, compactness, verification, or safety gaps.";
  return "Real Codex plugin runs are not yet strong; inspect whether Codex loaded and followed the AgentShell plugin skill.";
}

function inputsFromManifest(file) {
  const manifest = readJson(file);
  if (!manifest || typeof manifest !== "object") throw new Error("Codex plugin collector manifest must be an object");
  const runs = Array.isArray(manifest.runs) ? manifest.runs : [];
  if (runs.length === 0) throw new Error("Codex plugin collector manifest requires at least one run entry");
  const baseDir = path.dirname(file);
  return {
    name: typeof manifest.name === "string" ? manifest.name : "codex-plugin-real-run",
    baseDir,
    inputs: runs.map((entry, index) => inputFromManifestEntry(entry, index, baseDir))
  };
}

function inputFromManifestEntry(entry, index, baseDir) {
  if (!entry || typeof entry !== "object") throw new Error("Codex plugin collector manifest run entries must be objects");
  if (entry.input && typeof entry.input === "object") {
    return {
      ...entry.input,
      id: typeof entry.id === "string" ? entry.id : entry.input.id
    };
  }
  if (typeof entry.path !== "string") throw new Error("Codex plugin collector manifest entries require path or input");
  return path.resolve(baseDir, entry.path);
}

function parseArgs(args) {
  const inputs = [];
  let manifest = null;
  let report = null;
  let markdown = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--input") {
      inputs.push(path.resolve(process.cwd(), requireValue(args[index + 1], "--input")));
      index += 1;
      continue;
    }
    if (arg.startsWith("--input=")) {
      inputs.push(path.resolve(process.cwd(), requireValue(arg.slice("--input=".length), "--input")));
      continue;
    }
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
  if (inputs.length === 0 && !manifest) throw new Error("--input or --manifest is required");
  return { inputs, manifest, report, markdown };
}

function requireValue(value, flag) {
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value.endsWith("\n") ? value : `${value}\n`);
}

function renderMarkdown(report) {
  return [
    "# Codex Plugin Real-Run Trial",
    "",
    `Generated: ${report.generatedAt}`,
    `Runs: ${report.summary.total}`,
    `Average score: ${report.summary.averageScore}/100`,
    `Strong: ${report.summary.byInterpretation.strong}`,
    `Usable: ${report.summary.byInterpretation.usable}`,
    `Weak: ${report.summary.byInterpretation.weak}`,
    `Success rate: ${report.compactReport.successRate}%`,
    `Total output tokens: ${report.summary.totalOutputTokens}`,
    `Average output tokens: ${report.summary.averageOutputTokens}`,
    `Total duration: ${report.summary.totalDurationMs}ms`,
    `Average duration: ${report.summary.averageDurationMs}ms`,
    `AgentShell commands: ${report.summary.totalAgentShellCommands}`,
    `Noisy raw commands: ${report.summary.totalNoisyRawCommands}`,
    `Runs with unobserved non-AgentShell commands: ${report.summary.unobservedNoiseRuns}`,
    `Evidence status: ${report.evidence.status}`,
    `Claim readiness: ${report.evidence.claimReadiness}`,
    "",
    "## Runs",
    "",
    "| Run | Fixture | Score | Interpretation | Tokens | Duration ms |",
    "|---|---|---:|---|---:|---:|",
    ...report.trials.map((trial) => `| ${tableCell(trial.id)} | ${tableCell(trial.fixture || "-")} | ${trial.score} | ${trial.interpretation} | ${trial.metrics.totalOutputTokens} | ${trial.metrics.totalDurationMs} |`),
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
  const manifestInputs = options.manifest ? inputsFromManifest(options.manifest) : null;
  const report = collectCodexPluginTrials(
    [...(manifestInputs?.inputs || []), ...options.inputs],
    {
      name: manifestInputs?.name,
      baseDir: manifestInputs?.baseDir
    }
  );
  if (options.report) writeFile(options.report, JSON.stringify(report, null, 2));
  if (options.markdown) writeFile(options.markdown, renderMarkdown(report));
  console.log(JSON.stringify(report, null, 2));
}
