#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const PROTOCOL_VERSION = "agentshell.cold-start-benchmark.v1";

const options = parseArgs(process.argv.slice(2));
const report = runBenchmark(options);
writeArtifactReports(report, options);

if (options.format === "markdown") {
  console.log(formatMarkdown(report));
} else {
  console.log(JSON.stringify(report, null, 2));
}

if (!report.ok) process.exitCode = 1;

function parseArgs(args) {
  const options = {
    runs: 5,
    cli: path.join(root, "src", "cli.js"),
    cwd: root,
    format: "json",
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
        options.markdownPath = requirePathValue(args[index + 1], arg);
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

function runBenchmark(options) {
  const commands = [
    { id: "help", args: ["--help"], profile: false },
    { id: "manual", args: ["manual"], profile: false },
    { id: "plugin-validate-compact", args: ["plugin", "validate", "--compact", "--profile"], profile: true },
    { id: "start-compact", args: ["start", "--compact", "--profile"], profile: true }
  ].map((command) => runCommand(command, options));

  const summary = summarizeCommands(commands);
  return {
    ok: commands.every((command) => command.ok),
    protocolVersion: PROTOCOL_VERSION,
    runs: options.runs,
    cwd: options.cwd,
    cli: options.cli,
    note: "wallTimeMs is measured outside the Node.js process and includes process startup, module loading, command execution, JSON serialization, and stdout capture. profile.totalMs, when present, is measured inside the already-started CLI process.",
    summary,
    commands
  };
}

function runCommand(command, options) {
  const runs = [];
  for (let index = 0; index < options.runs; index += 1) {
    runs.push(runOnce(command, options, index + 1));
  }
  return {
    id: command.id,
    command: ["node", "src/cli.js", ...command.args].join(" "),
    ok: runs.every((run) => run.status === 0),
    summary: summarizeRuns(runs),
    runs
  };
}

function runOnce(command, options, runNumber) {
  const started = process.hrtime.bigint();
  const result = spawnSync("node", [options.cli, ...command.args], {
    cwd: options.cwd,
    encoding: "utf8"
  });
  const wallTimeMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
  const parsed = parseJson(result.stdout);
  return {
    run: runNumber,
    status: result.status,
    wallTimeMs,
    stdoutChars: result.stdout.length,
    stderrChars: result.stderr.length,
    estimatedTokens: estimateTokens(result.stdout.length),
    profileTotalMs: typeof parsed?.profile?.totalMs === "number" ? parsed.profile.totalMs : null,
    profileMeasuredMs: typeof parsed?.profile?.measuredMs === "number" ? parsed.profile.measuredMs : null,
    profileSubprocessMs: typeof parsed?.profile?.subprocessMs === "number" ? parsed.profile.subprocessMs : null
  };
}

function summarizeRuns(runs) {
  const totals = runs.reduce((summary, run) => ({
    wallTimeMs: summary.wallTimeMs + run.wallTimeMs,
    stdoutChars: summary.stdoutChars + run.stdoutChars,
    stderrChars: summary.stderrChars + run.stderrChars,
    estimatedTokens: summary.estimatedTokens + run.estimatedTokens,
    profileTotalMs: summary.profileTotalMs + (run.profileTotalMs || 0),
    profileMeasuredMs: summary.profileMeasuredMs + (run.profileMeasuredMs || 0),
    profileSubprocessMs: summary.profileSubprocessMs + (run.profileSubprocessMs || 0),
    profileCount: summary.profileCount + (run.profileTotalMs === null ? 0 : 1)
  }), {
    wallTimeMs: 0,
    stdoutChars: 0,
    stderrChars: 0,
    estimatedTokens: 0,
    profileTotalMs: 0,
    profileMeasuredMs: 0,
    profileSubprocessMs: 0,
    profileCount: 0
  });

  const averageProfileTotalMs = totals.profileCount > 0
    ? Math.round(totals.profileTotalMs / totals.profileCount)
    : null;
  const averageProfileMeasuredMs = totals.profileCount > 0
    ? Math.round(totals.profileMeasuredMs / totals.profileCount)
    : null;
  const averageProfileSubprocessMs = totals.profileCount > 0
    ? Math.round(totals.profileSubprocessMs / totals.profileCount)
    : null;

  return {
    averageWallTimeMs: Math.round(totals.wallTimeMs / runs.length),
    averageStdoutChars: Math.round(totals.stdoutChars / runs.length),
    averageEstimatedTokens: Math.round(totals.estimatedTokens / runs.length),
    averageProfileTotalMs,
    averageProfileMeasuredMs,
    averageProfileSubprocessMs,
    averageProcessOverheadMs: averageProfileTotalMs === null
      ? null
      : Math.max(0, Math.round(totals.wallTimeMs / runs.length) - averageProfileTotalMs),
    total: totals
  };
}

function summarizeCommands(commands) {
  const commandCount = commands.length;
  const totalCommandInvocations = commands.reduce((total, command) => total + command.runs.length, 0);
  return {
    commandCount,
    totalCommandInvocations,
    fastestAverageWallTimeMs: Math.min(...commands.map((command) => command.summary.averageWallTimeMs)),
    slowestAverageWallTimeMs: Math.max(...commands.map((command) => command.summary.averageWallTimeMs)),
    totalAverageEstimatedTokens: commands.reduce((total, command) => total + command.summary.averageEstimatedTokens, 0)
  };
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

function formatMarkdown(report) {
  const lines = [
    "# AgentShell Cold-Start Benchmark",
    "",
    `Runs: ${report.runs}`,
    `Commands measured: ${report.summary.commandCount}`,
    `Total command invocations: ${report.summary.totalCommandInvocations}`,
    "",
    "| Command | Avg wall time | Avg profile total | Avg process overhead | Avg stdout chars | Avg tokens |",
    "| --- | ---: | ---: | ---: | ---: | ---: |"
  ];

  for (const command of report.commands) {
    lines.push([
      `| ${command.id}`,
      `${command.summary.averageWallTimeMs}ms`,
      formatNullableMs(command.summary.averageProfileTotalMs),
      formatNullableMs(command.summary.averageProcessOverheadMs),
      command.summary.averageStdoutChars,
      `${command.summary.averageEstimatedTokens} |`
    ].join(" | "));
  }

  lines.push("", "## Notes", "", report.note);
  return lines.join("\n");
}

function formatNullableMs(value) {
  return value === null ? "n/a" : `${value}ms`;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}
