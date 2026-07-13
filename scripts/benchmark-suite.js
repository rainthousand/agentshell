#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const casesRoot = path.join(root, "examples", "benchmark-cases");
const cli = path.join(root, "bin", "agentshell");

const options = parseArgs(process.argv.slice(2));
const report = runSuite();
if (options.thresholds) {
  report.thresholds = evaluateThresholds(report, options);
}

writeArtifactReports(report, options);

if (options.format === "markdown") {
  console.log(formatMarkdownReport(report));
} else {
  console.log(JSON.stringify(report, null, 2));
}

if (options.thresholds && !report.thresholds.ok) {
  process.exitCode = 1;
}

function parseArgs(args) {
  let format = "json";
  let thresholds = false;
  let maxFixTokens = 260;
  let reportPath = null;
  let markdownPath = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--markdown") {
      if (args[index + 1] && !args[index + 1].startsWith("--")) {
        markdownPath = args[index + 1];
        index += 1;
      } else {
        format = "markdown";
      }
      continue;
    }
    if (arg.startsWith("--markdown=")) {
      markdownPath = requirePathValue(arg.slice("--markdown=".length), "--markdown");
      continue;
    }
    if (arg === "--report") {
      reportPath = requirePathValue(args[index + 1], arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--report=")) {
      reportPath = requirePathValue(arg.slice("--report=".length), "--report");
      continue;
    }
    if (arg === "--ci" || arg === "--thresholds") {
      thresholds = true;
      continue;
    }
    if (arg === "--max-fix-tokens") {
      maxFixTokens = parsePositiveInteger(args[index + 1], arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--max-fix-tokens=")) {
      maxFixTokens = parsePositiveInteger(arg.slice("--max-fix-tokens=".length), "--max-fix-tokens");
      continue;
    }
    if (arg === "--format") {
      const value = args[index + 1];
      index += 1;
      if (value === "markdown" || value === "json") format = value;
      else throw new Error(`Unsupported format: ${value}`);
      continue;
    }
    if (arg.startsWith("--format=")) {
      const value = arg.slice("--format=".length);
      if (value === "markdown" || value === "json") format = value;
      else throw new Error(`Unsupported format: ${value}`);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { format, thresholds, maxFixTokens, reportPath, markdownPath };
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function requirePathValue(value, flag) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a path`);
  }
  return value;
}

function runSuite() {
  const cases = Object.fromEntries(listCases().map((benchmarkCase) => [
    benchmarkCase.name,
    runCase(benchmarkCase)
  ]));

  return {
    ok: Object.values(cases).every((benchmarkCase) => benchmarkCase.ok),
    casesRoot,
    cases
  };
}

function listCases() {
  return fs.readdirSync(casesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      source: path.join(casesRoot, entry.name)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function runCase(benchmarkCase) {
  const rows = {
    raw: runRawFlow(benchmarkCase),
    split: runSplitFlow(benchmarkCase),
    fix: runFixFlow(benchmarkCase)
  };

  return {
    ok: rows.raw.ok === false && rows.split.ok && rows.fix.ok,
    source: benchmarkCase.source,
    rows
  };
}

function runRawFlow(benchmarkCase) {
  const session = createSession(benchmarkCase, "raw");
  const event = session.run("npm test", "npm", ["test"], { allowFailure: true });
  return buildRow("raw", session.workspace, session.events, event.status === 0);
}

function runSplitFlow(benchmarkCase) {
  const session = createSession(benchmarkCase, "split");
  session.run("agentshell diagnose test --compact", "node", [cli, "diagnose", "test", "--compact"]);
  session.run("agentshell change suggest --apply --compact", "node", [cli, "change", "suggest", "--apply", "--compact"]);
  const verify = session.run("agentshell verify test", "node", [cli, "verify", "test"]);
  return buildRow("split", session.workspace, session.events, verify.status === 0);
}

function runFixFlow(benchmarkCase) {
  const session = createSession(benchmarkCase, "fix");
  const fix = session.run("agentshell fix test --compact", "node", [cli, "fix", "test", "--compact"]);
  return buildRow("fix", session.workspace, session.events, fix.status === 0);
}

function evaluateThresholds(report, options) {
  const checks = [
    makeCheck("all-cases-ok", report.ok, {
      expected: true,
      actual: report.ok
    })
  ];

  for (const [caseName, benchmarkCase] of Object.entries(report.cases)) {
    checks.push(
      makeCheck(`${caseName}:raw-fails`, benchmarkCase.rows.raw.ok === false, {
        case: caseName,
        row: "raw",
        expected: false,
        actual: benchmarkCase.rows.raw.ok
      }),
      makeCheck(`${caseName}:split-passes`, benchmarkCase.rows.split.ok === true, {
        case: caseName,
        row: "split",
        expected: true,
        actual: benchmarkCase.rows.split.ok
      }),
      makeCheck(`${caseName}:fix-passes`, benchmarkCase.rows.fix.ok === true, {
        case: caseName,
        row: "fix",
        expected: true,
        actual: benchmarkCase.rows.fix.ok
      }),
      makeCheck(`${caseName}:split-rollback-available`, benchmarkCase.rows.split.rollbackAvailable === true, {
        case: caseName,
        row: "split",
        expected: true,
        actual: benchmarkCase.rows.split.rollbackAvailable
      }),
      makeCheck(`${caseName}:fix-rollback-available`, benchmarkCase.rows.fix.rollbackAvailable === true, {
        case: caseName,
        row: "fix",
        expected: true,
        actual: benchmarkCase.rows.fix.rollbackAvailable
      }),
      makeCheck(`${caseName}:fix-commands`, benchmarkCase.rows.fix.commands <= 1, {
        case: caseName,
        row: "fix",
        max: 1,
        actual: benchmarkCase.rows.fix.commands
      }),
      makeCheck(`${caseName}:fix-tokens`, benchmarkCase.rows.fix.tokens <= options.maxFixTokens, {
        case: caseName,
        row: "fix",
        max: options.maxFixTokens,
        actual: benchmarkCase.rows.fix.tokens
      })
    );
  }

  return {
    ok: checks.every((check) => check.ok),
    mode: "ci",
    maxFixTokens: options.maxFixTokens,
    checks
  };
}

function makeCheck(name, ok, details) {
  return {
    name,
    ok,
    ...details
  };
}

function createSession(benchmarkCase, mode) {
  const safeName = benchmarkCase.name.replaceAll(/[^a-z0-9_-]/gi, "-");
  const prefix = `agentshell-suite-${safeName}-${mode}-`;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  copyDir(benchmarkCase.source, workspace);
  const events = [];

  return {
    workspace,
    events,
    run(label, command, args, options = {}) {
      const started = Date.now();
      const result = spawnSync(command, args, {
        cwd: workspace,
        encoding: "utf8"
      });
      const durationMs = Date.now() - started;
      const output = `${result.stdout}${result.stderr}`;
      const rollbackCommand = extractRollbackCommand(output);
      const event = {
        command: label,
        status: result.status,
        chars: output.length,
        tokens: estimateTokens(output.length),
        durationMs,
        rollbackAvailable: Boolean(rollbackCommand),
        rollbackCommand
      };
      events.push(event);

      if (result.status !== 0 && !options.allowFailure) {
        throw new Error(`${label} failed:\n${output}`);
      }
      return event;
    }
  };
}

function buildRow(name, workspace, events, ok) {
  const chars = events.reduce((total, event) => total + event.chars, 0);
  const durationMs = events.reduce((total, event) => total + event.durationMs, 0);
  const rollbackCommand = events
    .slice()
    .reverse()
    .find((event) => event.rollbackCommand)?.rollbackCommand || null;
  return {
    ok,
    name,
    workspace,
    commands: events.length,
    chars,
    tokens: estimateTokens(chars),
    durationMs,
    rollbackAvailable: Boolean(rollbackCommand),
    rollbackCommand,
    events
  };
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === ".agentshell") continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    if (entry.isFile()) fs.copyFileSync(source, target);
  }
}

function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}

function extractRollbackCommand(output) {
  const parsed = parseJsonOutput(output);
  if (!parsed) return null;
  return findRollbackCommand(parsed) || findAppliedOperationRollbackCommand(parsed);
}

function parseJsonOutput(output) {
  const trimmed = output.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function findRollbackCommand(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.rollbackCommand === "string" && value.rollbackCommand.length > 0) {
    return value.rollbackCommand;
  }
  for (const child of Object.values(value)) {
    const found = findRollbackCommand(child);
    if (found) return found;
  }
  return null;
}

function findAppliedOperationRollbackCommand(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.applied?.operationId === "string" && value.applied.operationId.length > 0) {
    return `agentshell undo ${value.applied.operationId}`;
  }
  for (const child of Object.values(value)) {
    const found = findAppliedOperationRollbackCommand(child);
    if (found) return found;
  }
  return null;
}

function writeArtifactReports(report, options) {
  if (options.reportPath) {
    writeTextFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (options.markdownPath) {
    writeTextFile(options.markdownPath, formatMarkdownReport(report));
  }
}

function writeTextFile(filePath, contents) {
  const resolved = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, contents);
}

function formatMarkdownReport(report) {
  const lines = [
    "# AgentShell Benchmark Suite",
    "",
    `Overall: ${report.ok ? "ok" : "failed"}`,
    "",
    "| Case | Path | Ok | Commands | Tokens | Duration | Rollback |",
    "| --- | --- | --- | ---: | ---: | ---: | --- |"
  ];

  for (const [caseName, benchmarkCase] of Object.entries(report.cases)) {
    for (const rowName of ["raw", "split", "fix"]) {
      const row = benchmarkCase.rows[rowName];
      lines.push([
        escapeMarkdownCell(caseName),
        rowName,
        row.ok ? "yes" : "no",
        commandSummary(row),
        row.tokens,
        `${row.durationMs}ms`,
        row.rollbackCommand ? `yes: \`${escapeMarkdownCell(row.rollbackCommand)}\`` : "no"
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
    }
  }

  if (report.thresholds) {
    const failedChecks = report.thresholds.checks.filter((check) => !check.ok);
    lines.push(
      "",
      "## Thresholds",
      "",
      `Overall: ${report.thresholds.ok ? "ok" : "failed"}`,
      `Max fix tokens: ${report.thresholds.maxFixTokens}`,
      `Checks: ${report.thresholds.checks.length - failedChecks.length}/${report.thresholds.checks.length} passing`
    );

    if (failedChecks.length > 0) {
      lines.push("", "| Check | Actual | Expected |", "| --- | ---: | --- |");
      for (const check of failedChecks) {
        lines.push([
          escapeMarkdownCell(check.name),
          check.actual,
          check.max === undefined ? check.expected : `<= ${check.max}`
        ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function commandSummary(row) {
  const commands = row.events.map((event) => event.command).join("<br>");
  return `${row.commands}<br>${escapeMarkdownCell(commands)}`;
}

function escapeMarkdownCell(value) {
  return String(value).replaceAll("|", "\\|");
}
