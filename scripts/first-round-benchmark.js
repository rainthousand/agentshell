#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");

const options = parseArgs(process.argv.slice(2));
const report = runBenchmark(options);

writeArtifactReports(report, options);

if (options.format === "markdown") {
  console.log(formatMarkdown(report));
} else {
  console.log(JSON.stringify(report, null, 2));
}

if (!report.ok) {
  process.exitCode = 1;
}

function parseArgs(args) {
  const options = {
    runs: 3,
    format: "json",
    cli: path.join(root, "src", "cli.js"),
    cwd: root,
    reportPath: null,
    markdownPath: null
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.format = "json";
      continue;
    }
    if (arg === "--markdown") {
      if (args[index + 1] && !args[index + 1].startsWith("--")) {
        options.markdownPath = args[index + 1];
        index += 1;
      } else {
        options.format = "markdown";
      }
      continue;
    }
    if (arg.startsWith("--markdown=")) {
      options.markdownPath = requirePathValue(arg.slice("--markdown=".length), "--markdown");
      continue;
    }
    if (arg === "--report") {
      options.reportPath = requirePathValue(args[index + 1], arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--report=")) {
      options.reportPath = requirePathValue(arg.slice("--report=".length), "--report");
      continue;
    }
    if (arg === "--runs") {
      options.runs = parsePositiveInteger(args[index + 1], arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--runs=")) {
      options.runs = parsePositiveInteger(arg.slice("--runs=".length), "--runs");
      continue;
    }
    if (arg === "--cli") {
      options.cli = requireValue(args[index + 1], arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--cli=")) {
      options.cli = requireValue(arg.slice("--cli=".length), "--cli");
      continue;
    }
    if (arg === "--cwd") {
      options.cwd = requireValue(args[index + 1], arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--cwd=")) {
      options.cwd = requireValue(arg.slice("--cwd=".length), "--cwd");
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    ...options,
    cli: path.resolve(options.cli),
    cwd: path.resolve(options.cwd),
    reportPath: options.reportPath ? path.resolve(options.reportPath) : null,
    markdownPath: options.markdownPath ? path.resolve(options.markdownPath) : null
  };
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function requireValue(value, flag) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function requirePathValue(value, flag) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a path`);
  }
  return value;
}

function writeArtifactReports(report, options) {
  if (options.reportPath) {
    writeFileCreatingParents(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (options.markdownPath) {
    writeFileCreatingParents(options.markdownPath, formatMarkdown(report));
  }
}

function writeFileCreatingParents(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function runBenchmark(options) {
  const startCapability = detectStartCapability(options);
  const flows = {
    old: runFlow("old", [
      ["doctor"],
      ["understand", "--compact"],
      ["run", "next"]
    ], options),
    new: runFlow("new", [
      startCapability.compact ? ["start", "--compact"] : ["start"]
    ], options)
  };

  return {
    ok: flows.old.ok && flows.new.ok,
    protocolVersion: "agentshell.first-round-benchmark.v1",
    runs: options.runs,
    cwd: options.cwd,
    cli: options.cli,
    startCapability,
    flows,
    reduction: calculateReduction(flows.old.summary, flows.new.summary)
  };
}

function detectStartCapability(options) {
  const help = spawnSync("node", [options.cli, "--help"], {
    cwd: options.cwd,
    encoding: "utf8"
  });

  let compact = false;
  let source = "help";
  let note = "Top-level help did not advertise start --compact; using plain start.";

  if (help.status === 0) {
    const helpText = help.stdout;
    const parsed = parseJson(helpText);
    const commands = Array.isArray(parsed?.commands) ? parsed.commands : [];
    compact = commands.some((command) => /start \[--compact\]/.test(command)) ||
      /start \[--compact\]/.test(helpText);
    if (compact) {
      note = "Top-level help advertises start --compact; benchmarking the compact start path.";
    }
  } else {
    source = "unavailable";
    note = "Could not read CLI help; using plain start.";
  }

  return {
    compact,
    command: compact ? "node src/cli.js start --compact" : "node src/cli.js start",
    source,
    note
  };
}

function runFlow(name, commandArgsList, options) {
  const runs = [];
  for (let index = 0; index < options.runs; index += 1) {
    runs.push(runOnce(commandArgsList, options, index + 1));
  }

  const summary = summarizeRuns(runs);
  return {
    ok: runs.every((run) => run.ok),
    name,
    commands: commandArgsList.map((args) => commandLabel(args)),
    commandCount: commandArgsList.length,
    summary,
    runs
  };
}

function runOnce(commandArgsList, options, runNumber) {
  const commands = commandArgsList.map((args) => runCommand(args, options));
  const stdoutChars = commands.reduce((total, command) => total + command.stdoutChars, 0);
  const wallTimeMs = commands.reduce((total, command) => total + command.wallTimeMs, 0);
  return {
    run: runNumber,
    ok: commands.every((command) => command.status === 0),
    commandCount: commands.length,
    wallTimeMs,
    stdoutChars,
    estimatedTokens: estimateTokens(stdoutChars),
    commands
  };
}

function runCommand(args, options) {
  const started = process.hrtime.bigint();
  const result = spawnSync("node", [options.cli, ...args], {
    cwd: options.cwd,
    encoding: "utf8"
  });
  const wallTimeMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
  return {
    command: commandLabel(args),
    status: result.status,
    wallTimeMs,
    stdoutChars: result.stdout.length,
    estimatedTokens: estimateTokens(result.stdout.length),
    stderrChars: result.stderr.length
  };
}

function summarizeRuns(runs) {
  const totals = runs.reduce((summary, run) => ({
    commandCount: summary.commandCount + run.commandCount,
    wallTimeMs: summary.wallTimeMs + run.wallTimeMs,
    stdoutChars: summary.stdoutChars + run.stdoutChars,
    estimatedTokens: summary.estimatedTokens + run.estimatedTokens
  }), {
    commandCount: 0,
    wallTimeMs: 0,
    stdoutChars: 0,
    estimatedTokens: 0
  });

  return {
    commandCount: Math.round(totals.commandCount / runs.length),
    wallTimeMs: Math.round(totals.wallTimeMs / runs.length),
    stdoutChars: Math.round(totals.stdoutChars / runs.length),
    estimatedTokens: Math.round(totals.estimatedTokens / runs.length),
    total: totals
  };
}

function calculateReduction(oldSummary, newSummary) {
  return {
    commandCount: reductionRow(oldSummary.commandCount, newSummary.commandCount),
    wallTimeMs: reductionRow(oldSummary.wallTimeMs, newSummary.wallTimeMs),
    stdoutChars: reductionRow(oldSummary.stdoutChars, newSummary.stdoutChars),
    estimatedTokens: reductionRow(oldSummary.estimatedTokens, newSummary.estimatedTokens)
  };
}

function reductionRow(oldValue, newValue) {
  const saved = oldValue - newValue;
  return {
    old: oldValue,
    new: newValue,
    saved,
    percent: oldValue > 0 ? Math.round((saved / oldValue) * 1000) / 10 : null
  };
}

function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}

function commandLabel(args) {
  return `node src/cli.js ${args.join(" ")}`;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function formatMarkdown(report) {
  const lines = [
    "# AgentShell First-Round Benchmark",
    "",
    `Runs: ${report.runs}`,
    `Start path: \`${report.startCapability.command}\``,
    "",
    "| Flow | Commands | Wall time | Stdout chars | Estimated tokens |",
    "| --- | ---: | ---: | ---: | ---: |"
  ];

  for (const flowName of ["old", "new"]) {
    const flow = report.flows[flowName];
    lines.push([
      flowName,
      flow.summary.commandCount,
      `${flow.summary.wallTimeMs}ms`,
      flow.summary.stdoutChars,
      flow.summary.estimatedTokens
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }

  lines.push(
    "",
    "## Reduction",
    "",
    "| Metric | Saved | Percent |",
    "| --- | ---: | ---: |"
  );

  for (const [metric, row] of Object.entries(report.reduction)) {
    lines.push([
      metric,
      row.saved,
      row.percent === null ? "n/a" : `${row.percent}%`
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }

  return `${lines.join("\n")}\n`;
}
