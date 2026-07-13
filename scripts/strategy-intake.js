#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const PROTOCOL_VERSION = "agentshell.strategy-intake.v1";
const KNOWN_CLASSES = [
  "typescript-literal-mismatch",
  "typescript-missing-property",
  "typescript-primitive-literal-mismatch",
  "typescript-property-suggestion",
  "import-path",
  "deep-equal-array-elements",
  "deep-equal-array-removal",
  "deep-equal-missing-property",
  "literal-replacement",
  "unknown"
];
const usage = "node scripts/strategy-intake.js --input samples.json [--report report.json] [--markdown report.md]";

export function buildStrategyIntake(input) {
  const samples = normalizeInput(input).samples.map(scoreSample);
  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    generatedAt: new Date().toISOString(),
    name: normalizeInput(input).name,
    summary: summarize(samples),
    samples
  };
}

function normalizeInput(input) {
  if (!input || typeof input !== "object") throw new Error("Strategy intake input must be an object");
  const samples = Array.isArray(input.samples) ? input.samples : [];
  if (samples.length === 0) throw new Error("Strategy intake requires at least one sample");
  return {
    name: typeof input.name === "string" ? input.name : "strategy-intake",
    samples
  };
}

function scoreSample(sample, index) {
  if (!sample || typeof sample !== "object") throw new Error("Strategy samples must be objects");
  const failureClass = KNOWN_CLASSES.includes(sample.failureClass) ? sample.failureClass : "unknown";
  const commands = Array.isArray(sample.commands) ? sample.commands.filter((command) => typeof command === "string") : [];
  const hasAgentShellFirst = commands.some((command, commandIndex) => commandIndex < 2 && /\bagentshell\b|src\/cli\.js|bin\/agentshell/.test(command));
  const hasLogSnippet = typeof sample.logSnippet === "string" && sample.logSnippet.trim().length > 0;
  const currentOutcome = typeof sample.currentOutcome === "string" ? sample.currentOutcome : "unknown";
  const priority = prioritize({ failureClass, hasAgentShellFirst, hasLogSnippet, currentOutcome });
  return {
    id: typeof sample.id === "string" ? sample.id : `sample-${index + 1}`,
    source: typeof sample.source === "string" ? sample.source : null,
    host: typeof sample.host === "string" ? sample.host : "other",
    failureClass,
    currentOutcome,
    priority,
    readyForImplementation: priority !== "blocked",
    blockers: blockers({ failureClass, hasAgentShellFirst, hasLogSnippet, currentOutcome }),
    evidence: {
      hasAgentShellFirst,
      hasLogSnippet,
      commandCount: commands.length
    },
    notes: typeof sample.notes === "string" ? sample.notes : null
  };
}

function prioritize(sample) {
  if (sample.failureClass === "unknown" || !sample.hasLogSnippet) return "blocked";
  if (sample.currentOutcome === "unsafe" || sample.currentOutcome === "ambiguous") return "needs-review";
  if (["typescript-literal-mismatch", "import-path"].includes(sample.failureClass)) return "high";
  return sample.hasAgentShellFirst ? "medium" : "needs-reproduction";
}

function blockers(sample) {
  const blockers = [];
  if (sample.failureClass === "unknown") blockers.push("unknown failureClass");
  if (!sample.hasLogSnippet) blockers.push("missing logSnippet");
  if (!sample.hasAgentShellFirst) blockers.push("needs AgentShell-first reproduction");
  if (sample.currentOutcome === "unsafe" || sample.currentOutcome === "ambiguous") blockers.push(`currentOutcome is ${sample.currentOutcome}`);
  return blockers;
}

function summarize(samples) {
  const byPriority = {};
  const byFailureClass = {};
  for (const sample of samples) {
    byPriority[sample.priority] = (byPriority[sample.priority] || 0) + 1;
    byFailureClass[sample.failureClass] = (byFailureClass[sample.failureClass] || 0) + 1;
  }
  return {
    total: samples.length,
    readyForImplementation: samples.filter((sample) => sample.readyForImplementation).length,
    blocked: samples.filter((sample) => sample.priority === "blocked").length,
    byPriority,
    byFailureClass
  };
}

function parseArgs(argv) {
  const parsed = { help: false, input: null, report: null, markdown: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--input") {
      parsed.input = path.resolve(process.cwd(), requireValue(argv[index + 1], "--input"));
      index += 1;
    } else if (arg.startsWith("--input=")) parsed.input = path.resolve(process.cwd(), requireValue(arg.slice("--input=".length), "--input"));
    else if (arg === "--report") {
      parsed.report = path.resolve(process.cwd(), requireValue(argv[index + 1], "--report"));
      index += 1;
    } else if (arg.startsWith("--report=")) parsed.report = path.resolve(process.cwd(), requireValue(arg.slice("--report=".length), "--report"));
    else if (arg === "--markdown") {
      parsed.markdown = path.resolve(process.cwd(), requireValue(argv[index + 1], "--markdown"));
      index += 1;
    } else if (arg.startsWith("--markdown=")) parsed.markdown = path.resolve(process.cwd(), requireValue(arg.slice("--markdown=".length), "--markdown"));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!parsed.help && !parsed.input) throw new Error("--input is required");
  return parsed;
}

function requireValue(value, flag) {
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function renderMarkdown(report) {
  return [
    "# AgentShell Strategy Intake",
    "",
    `Generated: ${report.generatedAt}`,
    `Samples: ${report.summary.total}`,
    `Ready for implementation: ${report.summary.readyForImplementation}`,
    `Blocked: ${report.summary.blocked}`,
    "",
    "| Sample | Failure class | Priority | Ready | Blockers |",
    "|---|---|---|---|---|",
    ...report.samples.map((sample) => `| ${sample.id} | ${sample.failureClass} | ${sample.priority} | ${sample.readyForImplementation ? "yes" : "no"} | ${sample.blockers.join("; ") || "-"} |`),
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
  const report = buildStrategyIntake(JSON.parse(fs.readFileSync(options.input, "utf8")));
  if (options.report) writeFile(options.report, JSON.stringify(report, null, 2));
  if (options.markdown) writeFile(options.markdown, renderMarkdown(report));
  console.log(JSON.stringify(report, null, 2));
}
