#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { buildCodexPluginTrialTemplate } from "./codex-plugin-trial-template.js";

const PROTOCOL_VERSION = "agentshell.codex-plugin-trial-plan.v1";
const DEFAULT_NAME = "codex-plugin-real-run-plan";
const DEFAULT_FIXTURE = "examples/failing-test-demo";
const DEFAULT_RUNS = 3;
const usage = "node scripts/codex-plugin-trial-plan.js [--name plan-name] [--runs 3] [--fixture path] [--id-prefix run] [--out-dir artifacts/codex-plugin-plan] [--report report.json] [--manifest suite.json] [--markdown plan.md]";

export function buildCodexPluginTrialPlan(options = {}) {
  const name = safeText(options.name, DEFAULT_NAME);
  const fixture = safeText(options.fixture, DEFAULT_FIXTURE);
  const runCount = clampRunCount(options.runs ?? DEFAULT_RUNS);
  const idPrefix = safeText(options.idPrefix, "codex-real-run");
  const outDir = safeText(options.outDir, "artifacts/codex-plugin-plan");
  const runs = [];

  for (let index = 0; index < runCount; index += 1) {
    const number = String(index + 1).padStart(2, "0");
    const id = `${idPrefix}-${number}`;
    const jsonPath = path.posix.join(outDir, `${id}.json`);
    const markdownPath = path.posix.join(outDir, `${id}.md`);
    const template = buildCodexPluginTrialTemplate({ id, fixture });
    runs.push({
      id,
      fixture,
      jsonPath,
      markdownPath,
      jsonTemplate: template.jsonTemplate,
      markdown: template.markdown
    });
  }

  const suiteManifestPath = path.posix.join(outDir, "suite.json");
  const suiteManifest = {
    name,
    runs: runs.map((run) => ({
      id: run.id,
      path: path.posix.basename(run.jsonPath),
      notes: `Fill this run log after Codex new-thread trial ${run.id}.`
    }))
  };

  const report = {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    generatedAt: new Date().toISOString(),
    name,
    fixture,
    runCount,
    outDir,
    suiteManifestPath,
    suiteManifest,
    runs: runs.map(({ id, fixture: runFixture, jsonPath, markdownPath }) => ({
      id,
      fixture: runFixture,
      jsonPath,
      markdownPath
    })),
    markdown: renderPlanMarkdown({ name, fixture, runs, suiteManifestPath }),
    nextActions: [
      "Open one fresh Codex thread per generated run-log template.",
      "Fill each JSON template with observed AgentShell commands, compact stdout, durations, and final verification.",
      `Run npm run codex:plugin:suite -- --manifest ${suiteManifestPath} --report ${path.posix.join(outDir, "suite-report.json")} --markdown ${path.posix.join(outDir, "suite-report.md")}`
    ]
  };

  return {
    ...report,
    files: runs.flatMap((run) => [
      { path: run.jsonPath, kind: "json", content: JSON.stringify(run.jsonTemplate, null, 2) },
      { path: run.markdownPath, kind: "markdown", content: run.markdown }
    ]).concat([
      { path: suiteManifestPath, kind: "json", content: JSON.stringify(suiteManifest, null, 2) }
    ])
  };
}

function clampRunCount(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error("--runs must be a positive integer");
  if (parsed > 10) throw new Error("--runs must be 10 or less");
  return parsed;
}

function renderPlanMarkdown({ name, fixture, runs, suiteManifestPath }) {
  return [
    "# Codex Plugin Real-Run Plan",
    "",
    `Name: \`${name}\``,
    `Fixture: \`${fixture}\``,
    `Runs: ${runs.length}`,
    "",
    "## Execution",
    "",
    "Run each row in a fresh Codex thread after installing the latest AgentShell plugin.",
    "",
    "| Run | JSON template | Markdown form |",
    "|---|---|---|",
    ...runs.map((run) => `| ${tableCell(run.id)} | ${tableCell(run.jsonPath)} | ${tableCell(run.markdownPath)} |`),
    "",
    "## Scoring",
    "",
    "After filling the JSON templates, run:",
    "",
    "```bash",
    `npm run codex:plugin:suite -- --manifest ${suiteManifestPath} --report ${path.posix.dirname(suiteManifestPath)}/suite-report.json --markdown ${path.posix.dirname(suiteManifestPath)}/suite-report.md`,
    "```",
    "",
    "The suite report should be used for stability claims: strong rate, average score, average token cost, average duration, and per-fixture stability.",
    ""
  ].join("\n");
}

function safeText(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function parseArgs(args) {
  const parsed = {
    help: false,
    name: DEFAULT_NAME,
    runs: DEFAULT_RUNS,
    fixture: DEFAULT_FIXTURE,
    idPrefix: "codex-real-run",
    outDir: null,
    report: null,
    manifest: null,
    markdown: null
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--name") {
      parsed.name = requireValue(args[index + 1], "--name");
      index += 1;
    } else if (arg.startsWith("--name=")) {
      parsed.name = requireValue(arg.slice("--name=".length), "--name");
    } else if (arg === "--runs") {
      parsed.runs = requireValue(args[index + 1], "--runs");
      index += 1;
    } else if (arg.startsWith("--runs=")) {
      parsed.runs = requireValue(arg.slice("--runs=".length), "--runs");
    } else if (arg === "--fixture") {
      parsed.fixture = requireValue(args[index + 1], "--fixture");
      index += 1;
    } else if (arg.startsWith("--fixture=")) {
      parsed.fixture = requireValue(arg.slice("--fixture=".length), "--fixture");
    } else if (arg === "--id-prefix") {
      parsed.idPrefix = requireValue(args[index + 1], "--id-prefix");
      index += 1;
    } else if (arg.startsWith("--id-prefix=")) {
      parsed.idPrefix = requireValue(arg.slice("--id-prefix=".length), "--id-prefix");
    } else if (arg === "--out-dir") {
      parsed.outDir = requireValue(args[index + 1], "--out-dir");
      index += 1;
    } else if (arg.startsWith("--out-dir=")) {
      parsed.outDir = requireValue(arg.slice("--out-dir=".length), "--out-dir");
    } else if (arg === "--report") {
      parsed.report = path.resolve(process.cwd(), requireValue(args[index + 1], "--report"));
      index += 1;
    } else if (arg.startsWith("--report=")) {
      parsed.report = path.resolve(process.cwd(), requireValue(arg.slice("--report=".length), "--report"));
    } else if (arg === "--manifest") {
      parsed.manifest = path.resolve(process.cwd(), requireValue(args[index + 1], "--manifest"));
      index += 1;
    } else if (arg.startsWith("--manifest=")) {
      parsed.manifest = path.resolve(process.cwd(), requireValue(arg.slice("--manifest=".length), "--manifest"));
    } else if (arg === "--markdown") {
      parsed.markdown = path.resolve(process.cwd(), requireValue(args[index + 1], "--markdown"));
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

function writeFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value.endsWith("\n") ? value : `${value}\n`);
}

function writePlanFiles(plan, outDir) {
  const outputRoot = path.resolve(process.cwd(), outDir);
  for (const file of plan.files) {
    writeFile(path.resolve(process.cwd(), file.path), file.content);
  }
  return outputRoot;
}

function publicReport(plan) {
  const { files, ...report } = plan;
  return report;
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
  const outDir = options.outDir || "artifacts/codex-plugin-plan";
  const plan = buildCodexPluginTrialPlan({ ...options, outDir });
  if (options.outDir) writePlanFiles(plan, outDir);
  if (options.manifest) writeFile(options.manifest, JSON.stringify(plan.suiteManifest, null, 2));
  if (options.markdown) writeFile(options.markdown, plan.markdown);
  if (options.report) writeFile(options.report, JSON.stringify(publicReport(plan), null, 2));
  console.log(JSON.stringify(publicReport(plan), null, 2));
}
