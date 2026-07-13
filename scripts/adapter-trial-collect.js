#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { scoreAdapterTrial } from "./adapter-trial.js";

const PROTOCOL_VERSION = "agentshell.adapter-trial-collect.v1";
const VALID_HOSTS = ["codex", "claude", "cursor", "windsurf", "agents-md", "other"];
const usage = "node scripts/adapter-trial-collect.js --input run-log.json [--trial trial.json] [--report report.json] [--markdown report.md]";

export function collectAdapterTrial(input) {
  const normalized = normalizeInput(input);
  const trial = {
    host: normalized.host,
    fixture: normalized.fixture,
    commands: normalized.events.filter((event) => event.type === "command").map(commandFromEvent),
    finalVerification: normalized.finalVerification,
    notes: normalized.notes
  };

  const scoreReport = scoreAdapterTrial(trial);
  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    generatedAt: new Date().toISOString(),
    source: normalized.source,
    trial,
    scoreReport,
    summary: {
      host: scoreReport.host,
      fixture: scoreReport.fixture,
      score: scoreReport.score,
      interpretation: scoreReport.interpretation,
      commands: scoreReport.metrics.commandCount,
      agentShellCommands: scoreReport.metrics.agentShellCommandCount,
      noisyRawCommands: scoreReport.metrics.noisyRawCommandCount,
      totalOutputTokens: scoreReport.metrics.totalOutputTokens,
      totalDurationMs: scoreReport.metrics.totalDurationMs
    }
  };
}

function parseArgs(args) {
  let input = null;
  let trial = null;
  let report = null;
  let markdown = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--input") {
      input = path.resolve(process.cwd(), requireValue(args[index + 1], "--input"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--input=")) {
      input = path.resolve(process.cwd(), requireValue(arg.slice("--input=".length), "--input"));
      continue;
    }
    if (arg === "--trial") {
      trial = path.resolve(process.cwd(), requireValue(args[index + 1], "--trial"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--trial=")) {
      trial = path.resolve(process.cwd(), requireValue(arg.slice("--trial=".length), "--trial"));
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
  if (!input) throw new Error("--input is required");
  return { input, trial, report, markdown };
}

function requireValue(value, flag) {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function normalizeInput(input) {
  if (!input || typeof input !== "object") throw new Error("Collector input must be an object");
  const host = typeof input.host === "string" ? input.host : "other";
  if (!VALID_HOSTS.includes(host)) throw new Error(`Unsupported host: ${host}`);
  const events = normalizeEvents(input);
  if (events.filter((event) => event.type === "command").length === 0) {
    throw new Error("Collector input requires at least one command event");
  }
  return {
    host,
    fixture: typeof input.fixture === "string" ? input.fixture : null,
    source: typeof input.source === "string" ? input.source : null,
    events,
    finalVerification: normalizeFinalVerification(input.finalVerification),
    notes: typeof input.notes === "string" ? input.notes : null
  };
}

function normalizeEvents(input) {
  if (Array.isArray(input.events)) return input.events.map(normalizeEvent);
  if (Array.isArray(input.commands)) {
    return input.commands.map((command) => normalizeEvent(typeof command === "string" ? { type: "command", command } : { type: "command", ...command }));
  }
  return [];
}

function normalizeEvent(event) {
  if (!event || typeof event !== "object") throw new Error("Events must be objects");
  if ((event.type || "command") !== "command") {
    return {
      type: String(event.type),
      note: typeof event.note === "string" ? event.note : null
    };
  }
  if (typeof event.command !== "string") throw new Error("Command events require a command string");
  const stdout = typeof event.stdout === "string" ? event.stdout : "";
  const stderr = typeof event.stderr === "string" ? event.stderr : "";
  const outputTokens = Number.isFinite(event.outputTokens) ? event.outputTokens : estimateTokens(stdout, stderr);
  return {
    type: "command",
    command: event.command,
    stdout,
    stderr,
    outputTokens: numberOrZero(outputTokens),
    durationMs: durationMsFor(event),
    startedAt: typeof event.startedAt === "string" ? event.startedAt : null,
    finishedAt: typeof event.finishedAt === "string" ? event.finishedAt : null
  };
}

function commandFromEvent(event) {
  return {
    command: event.command,
    outputTokens: event.outputTokens,
    durationMs: event.durationMs
  };
}

function durationMsFor(event) {
  if (Number.isFinite(event.durationMs)) return numberOrZero(event.durationMs);
  if (typeof event.startedAt === "string" && typeof event.finishedAt === "string") {
    const startedAt = Date.parse(event.startedAt);
    const finishedAt = Date.parse(event.finishedAt);
    if (Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt) {
      return finishedAt - startedAt;
    }
  }
  return 0;
}

function estimateTokens(...texts) {
  return Math.ceil(texts.join("\n").length / 4);
}

function numberOrZero(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function normalizeFinalVerification(value) {
  if (!value || typeof value !== "object") return null;
  return {
    ok: value.ok === true,
    command: typeof value.command === "string" ? value.command : null,
    summary: typeof value.summary === "string" ? value.summary : null
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
    "# AgentShell Adapter Trial Collection",
    "",
    `Generated: ${report.generatedAt}`,
    `Host: ${report.summary.host}`,
    `Fixture: ${report.summary.fixture || "-"}`,
    `Score: ${report.summary.score}/100 (${report.summary.interpretation})`,
    "",
    "## Summary",
    "",
    `- Commands: ${report.summary.commands}`,
    `- AgentShell commands: ${report.summary.agentShellCommands}`,
    `- Noisy raw commands: ${report.summary.noisyRawCommands}`,
    `- Total output tokens: ${report.summary.totalOutputTokens}`,
    `- Total duration: ${report.summary.totalDurationMs}ms`,
    "",
    "## Criteria",
    "",
    "| Criterion | Points | Max | Reason |",
    "|---|---:|---:|---|",
    ...Object.entries(report.scoreReport.criteria).map(([name, entry]) => (
      `| ${tableCell(name)} | ${entry.points} | ${entry.max} | ${tableCell(entry.reason)} |`
    )),
    "",
    "## Trial JSON",
    "",
    "Use the generated trial JSON with `npm run --silent adapter:trial -- --input <trial.json>`."
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

  const report = collectAdapterTrial(readJson(options.input));
  if (options.trial) writeJsonFile(options.trial, report.trial);
  if (options.report) writeJsonFile(options.report, report);
  if (options.markdown) writeTextFile(options.markdown, renderMarkdownReport(report));
  console.log(JSON.stringify(report, null, 2));
}
