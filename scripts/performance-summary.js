#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSION = "agentshell.performance-summary.v1";
const DEFAULT_BENCHMARK_SUITE = "artifacts/benchmark-suite.batch1-4.json";
const DEFAULT_COLD_START = "artifacts/cold-start-benchmark.json";
const DEFAULT_CACHE = "artifacts/cache-benchmark.json";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const report = buildPerformanceSummary(process.cwd(), options);
  if (options.report) writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
  if (options.markdown) writeFile(options.markdown, renderMarkdown(report));
  console.log(JSON.stringify(report, null, 2));
}

export function buildPerformanceSummary(projectRoot = process.cwd(), options = {}) {
  const sources = {
    benchmarkSuite: loadOptionalJson(projectRoot, options.benchmarkSuite || DEFAULT_BENCHMARK_SUITE),
    coldStart: loadOptionalJson(projectRoot, options.coldStart || DEFAULT_COLD_START),
    cache: loadOptionalJson(projectRoot, options.cache || DEFAULT_CACHE)
  };
  const benchmark = summarizeBenchmarkSuite(sources.benchmarkSuite.data);
  const coldStart = summarizeColdStart(sources.coldStart.data);
  const cache = summarizeCache(sources.cache.data);
  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    generatedAt: new Date().toISOString(),
    sources: Object.fromEntries(Object.entries(sources).map(([name, source]) => [
      name,
      { path: source.path, present: source.present, valid: source.valid, error: source.error }
    ])),
    summary: {
      benchmarkCases: benchmark?.cases ?? 0,
      averageFixTokens: benchmark?.averageFixTokens ?? null,
      averageFixDurationMs: benchmark?.averageFixDurationMs ?? null,
      averageFixCommands: benchmark?.averageFixCommands ?? null,
      coldStartCommandCount: coldStart?.commandCount ?? null,
      coldStartTotalCommandInvocations: coldStart?.totalCommandInvocations ?? null,
      coldStartSlowestAverageWallTimeMs: coldStart?.slowestAverageWallTimeMs ?? null,
      coldStartTotalAverageEstimatedTokens: coldStart?.totalAverageEstimatedTokens ?? null,
      cacheCommandCount: cache?.commandCount ?? null,
      cacheSpeedupPercent: cache?.speedupPercent ?? null,
      cacheEstimatedTokenDelta: cache?.estimatedTokenDelta ?? null
    },
    benchmark,
    coldStart,
    cache,
    recommendation: recommendationFor({ benchmark, coldStart, cache })
  };
}

function parseArgs(args) {
  const parsed = {
    benchmarkSuite: DEFAULT_BENCHMARK_SUITE,
    coldStart: DEFAULT_COLD_START,
    cache: DEFAULT_CACHE,
    report: null,
    markdown: null
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--benchmark-suite") {
      parsed.benchmarkSuite = requireValue(args[index + 1], arg);
      index += 1;
    } else if (arg.startsWith("--benchmark-suite=")) {
      parsed.benchmarkSuite = requireValue(arg.slice("--benchmark-suite=".length), "--benchmark-suite");
    } else if (arg === "--cold-start") {
      parsed.coldStart = requireValue(args[index + 1], arg);
      index += 1;
    } else if (arg.startsWith("--cold-start=")) {
      parsed.coldStart = requireValue(arg.slice("--cold-start=".length), "--cold-start");
    } else if (arg === "--cache") {
      parsed.cache = requireValue(args[index + 1], arg);
      index += 1;
    } else if (arg.startsWith("--cache=")) {
      parsed.cache = requireValue(arg.slice("--cache=".length), "--cache");
    } else if (arg === "--report") {
      parsed.report = path.resolve(process.cwd(), requireValue(args[index + 1], arg));
      index += 1;
    } else if (arg.startsWith("--report=")) {
      parsed.report = path.resolve(process.cwd(), requireValue(arg.slice("--report=".length), "--report"));
    } else if (arg === "--markdown") {
      parsed.markdown = path.resolve(process.cwd(), requireValue(args[index + 1], arg));
      index += 1;
    } else if (arg.startsWith("--markdown=")) {
      parsed.markdown = path.resolve(process.cwd(), requireValue(arg.slice("--markdown=".length), "--markdown"));
    } else if (arg === "--help" || arg === "-h") {
      console.log(JSON.stringify({
        ok: true,
        usage: "node scripts/performance-summary.js [--benchmark-suite report.json] [--cold-start report.json] [--cache report.json] [--report report.json] [--markdown report.md]"
      }));
      process.exit(0);
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

function loadOptionalJson(projectRoot, file) {
  const resolved = path.resolve(projectRoot, file);
  if (!fs.existsSync(resolved)) return { path: resolved, present: false, valid: false, error: "missing", data: null };
  try {
    return {
      path: resolved,
      present: true,
      valid: true,
      error: null,
      data: JSON.parse(fs.readFileSync(resolved, "utf8"))
    };
  } catch (error) {
    return {
      path: resolved,
      present: true,
      valid: false,
      error: error.message,
      data: null
    };
  }
}

function summarizeBenchmarkSuite(report) {
  if (!report?.cases) return null;
  const cases = Object.entries(report.cases).map(([name, item]) => ({
    name,
    fixTokens: item.rows.fix.tokens,
    fixDurationMs: item.rows.fix.durationMs,
    fixCommands: item.rows.fix.commands
  }));
  return {
    ok: report.ok === true,
    cases: cases.length,
    averageFixTokens: average(cases.map((item) => item.fixTokens)),
    averageFixDurationMs: average(cases.map((item) => item.fixDurationMs)),
    averageFixCommands: average(cases.map((item) => item.fixCommands)),
    maxFixTokens: Math.max(...cases.map((item) => item.fixTokens)),
    slowestFixDurationMs: Math.max(...cases.map((item) => item.fixDurationMs))
  };
}

function summarizeColdStart(report) {
  if (!report?.summary) return null;
  return {
    ok: report.ok === true,
    runs: report.runs,
    commandCount: report.summary.commandCount ?? report.commands?.length ?? null,
    totalCommandInvocations: report.summary.totalCommandInvocations ?? null,
    slowestAverageWallTimeMs: report.summary.slowestAverageWallTimeMs,
    fastestAverageWallTimeMs: report.summary.fastestAverageWallTimeMs,
    totalAverageEstimatedTokens: report.summary.totalAverageEstimatedTokens
  };
}

function summarizeCache(report) {
  if (!report) return null;
  return {
    ok: report.ok === true,
    command: report.command,
    commandCount: report.commandCount ?? report.summary?.commands ?? null,
    speedupPercent: report.speedupPercent,
    durationDelta: report.durationDelta,
    estimatedTokenDelta: report.estimatedTokenDelta,
    testExecutions: report.testExecutions
  };
}

function recommendationFor({ benchmark, coldStart, cache }) {
  const missing = [];
  if (!benchmark) missing.push("benchmark suite");
  if (!coldStart) missing.push("cold-start benchmark");
  if (!cache) missing.push("cache benchmark");
  if (missing.length > 0) return `Run missing performance reports before making broad claims: ${missing.join(", ")}.`;
  if ((benchmark.maxFixTokens ?? 0) > 260) return "Investigate fix compact output; at least one benchmark case exceeds the 260-token target.";
  if ((cache.speedupPercent ?? 0) <= 0) return "Investigate verify cache behavior; the cache report does not show a positive speedup.";
  return "Performance evidence is ready for product reporting; keep collecting real Codex run data for external validity.";
}

function renderMarkdown(report) {
  return [
    "# AgentShell Performance Summary",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Headline",
    "",
    `- Benchmark cases: ${report.summary.benchmarkCases}`,
    `- Average fix tokens: ${formatValue(report.summary.averageFixTokens)}`,
    `- Average fix duration: ${formatMs(report.summary.averageFixDurationMs)}`,
    `- Average fix commands: ${formatValue(report.summary.averageFixCommands)}`,
    `- Cold-start commands measured: ${formatValue(report.summary.coldStartCommandCount)}`,
    `- Cold-start command invocations: ${formatValue(report.summary.coldStartTotalCommandInvocations)}`,
    `- Cold-start slowest average wall time: ${formatMs(report.summary.coldStartSlowestAverageWallTimeMs)}`,
    `- Cold-start average tokens across commands: ${formatValue(report.summary.coldStartTotalAverageEstimatedTokens)}`,
    `- Cache commands measured: ${formatValue(report.summary.cacheCommandCount)}`,
    `- Cache speedup: ${formatPercent(report.summary.cacheSpeedupPercent)}`,
    `- Cache estimated token delta: ${formatValue(report.summary.cacheEstimatedTokenDelta)}`,
    "",
    `Recommendation: ${report.recommendation}`,
    ""
  ].join("\n");
}

function average(values) {
  if (values.length === 0) return null;
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function formatValue(value) {
  return value === null || value === undefined ? "n/a" : String(value);
}

function formatMs(value) {
  return value === null || value === undefined ? "n/a" : `${value}ms`;
}

function formatPercent(value) {
  return value === null || value === undefined ? "n/a" : `${value}%`;
}
