#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { runAdapterTrialSuite } from "./adapter-trial-suite.js";

const root = path.resolve(import.meta.dirname, "..");
const PROTOCOL_VERSION = "agentshell.codex-plugin-trial.v1";
const DEFAULT_MANIFEST = "examples/codex-plugin-effect.sample.json";
const usage = "node scripts/codex-plugin-trial.js [--manifest suite.json] [--report report.json] [--markdown report.md]";

function parseArgs(argv) {
  const parsed = {
    help: false,
    manifest: path.join(root, DEFAULT_MANIFEST),
    report: null,
    markdown: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--manifest") {
      parsed.manifest = path.resolve(process.cwd(), requireValue(argv[index + 1], "--manifest"));
      index += 1;
    } else if (arg.startsWith("--manifest=")) {
      parsed.manifest = path.resolve(process.cwd(), requireValue(arg.slice("--manifest=".length), "--manifest"));
    } else if (arg === "--report") {
      parsed.report = path.resolve(process.cwd(), requireValue(argv[index + 1], "--report"));
      index += 1;
    } else if (arg.startsWith("--report=")) {
      parsed.report = path.resolve(process.cwd(), requireValue(arg.slice("--report=".length), "--report"));
    } else if (arg === "--markdown") {
      parsed.markdown = path.resolve(process.cwd(), requireValue(argv[index + 1], "--markdown"));
      index += 1;
    } else if (arg.startsWith("--markdown=")) {
      parsed.markdown = path.resolve(process.cwd(), requireValue(arg.slice("--markdown=".length), "--markdown"));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function requireValue(value, flag) {
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function runCodexPluginTrial(options = {}) {
  const manifestPath = options.manifest || path.join(root, DEFAULT_MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const suite = runAdapterTrialSuite(manifest, { baseDir: path.dirname(manifestPath) });
  const pluginTrial = suite.trials.find((trial) => trial.id === "codex-plugin-agentshell");
  return {
    ...suite,
    protocolVersion: PROTOCOL_VERSION,
    purpose: "Compare Codex raw shell-first behavior with Codex AgentShell plugin-guided behavior.",
    recommendation: pluginTrial?.interpretation === "strong"
      ? "Codex plugin behavior is strong when AgentShell is used first; collect a real new-thread transcript as the next evidence layer."
      : "Collect a real Codex plugin run and inspect AgentShell-guided criteria gaps."
  };
}

function renderMarkdown(report) {
  const codex = report.summary.byHost.codex;
  return [
    "# Codex Plugin Effect Trial",
    "",
    `Generated: ${report.generatedAt}`,
    `Average Codex score: ${codex?.averageScore ?? 0}/100`,
    `Strong: ${report.summary.byInterpretation.strong}`,
    `Usable: ${report.summary.byInterpretation.usable}`,
    `Weak: ${report.summary.byInterpretation.weak}`,
    `Total output tokens: ${report.summary.totalOutputTokens}`,
    `Total duration: ${report.summary.totalDurationMs}ms`,
    "",
    "## Trials",
    "",
    "| Trial | Score | Interpretation | Tokens | Duration ms |",
    "|---|---:|---|---:|---:|",
    ...report.trials.map((trial) => `| ${trial.id} | ${trial.score} | ${trial.interpretation} | ${trial.metrics.totalOutputTokens} | ${trial.metrics.totalDurationMs} |`),
    "",
    `Recommendation: ${report.recommendation}`,
    ""
  ].join("\n");
}

function writeFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value.endsWith("\n") ? value : `${value}\n`);
}

if (process.argv[1] === import.meta.filename) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(JSON.stringify({ ok: true, usage }, null, 2));
    process.exit(0);
  }
  const report = runCodexPluginTrial({ manifest: options.manifest });
  if (options.report) writeFile(options.report, JSON.stringify(report, null, 2));
  if (options.markdown) writeFile(options.markdown, renderMarkdown(report));
  console.log(JSON.stringify(report, null, 2));
}
