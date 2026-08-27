#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { SAMPLE_PROTOCOL_VERSION } from "./performance-sla.js";

const ROOT = path.resolve(import.meta.dirname, "..");

export function buildProbeSample({ coldStart, compact, cache, overhead = null, description = null }) {
  const inspectionCommand = coldStart?.commands?.find((command) => command.id === "pwd-compact");
  const coldStartMs = inspectionCommand?.runs?.map((run) => run.wallTimeMs).filter(isNonNegativeNumber) || null;
  const compactEstimatedTokens = compact?.checks?.map((check) => check.estimatedTokens).filter(isNonNegativeNumber) || null;
  const repeatedCacheEvidence = Array.isArray(cache);
  const cacheRuns = (repeatedCacheEvidence ? cache : [cache]).filter(Boolean);
  const cachePairs = cacheRuns.map((entry) => ({
    missMs: entry?.firstRun?.wallDurationMs,
    hitMs: entry?.secondRun?.wallDurationMs
  })).filter((entry) => isNonNegativeNumber(entry.missMs) && entry.missMs > 0 && isNonNegativeNumber(entry.hitMs));
  return {
    protocolVersion: SAMPLE_PROTOCOL_VERSION,
    source: {
      mode: "local-probe",
      description: description || "Local wall-clock probe using the checked-in AgentShell benchmark scripts."
    },
    measurements: {
      coldStartMs: coldStartMs?.length ? coldStartMs : null,
      overheadComparison: overhead?.comparable === true ? overhead : null,
      compactEstimatedTokens: compactEstimatedTokens?.length ? compactEstimatedTokens : null,
      cacheComparison: cachePairs.length
        ? {
          missMs: median(cachePairs.map((entry) => entry.missMs)),
          hitMs: median(cachePairs.map((entry) => entry.hitMs)),
          ...(repeatedCacheEvidence ? { sampleCount: cachePairs.length } : {})
        }
        : null
    },
    evidence: {
      coldStartProtocolVersion: coldStart?.protocolVersion || null,
      coldStartReportOk: typeof coldStart?.ok === "boolean" ? coldStart.ok : null,
      compactProtocolVersion: compact?.protocolVersion || null,
      compactReportOk: typeof compact?.ok === "boolean" ? compact.ok : null,
      cacheCommand: cacheRuns[0]?.command || null,
      cacheReportOk: cacheRuns.length ? cacheRuns.every((entry) => entry?.ok === true) : null,
      overheadReason: overhead ? null : "No semantically equivalent launcher/source comparison was supplied.",
      environment: { platform: process.platform, arch: process.arch, node: process.version }
    }
  };
}

function runJsonScript(script, args = []) {
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${script} did not produce JSON (exit ${result.status ?? "unknown"}): ${result.stderr || result.stdout}`.trim());
  }
}

function parseArgs(argv) {
  const options = { runs: 7, cacheRuns: 3, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--runs") {
      options.runs = positiveInteger(argv[index + 1], arg);
      index += 1;
    } else if (arg === "--cache-runs") {
      options.cacheRuns = positiveInteger(argv[index + 1], arg);
      index += 1;
    } else if (arg === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--output requires a path");
      options.output = path.resolve(value);
      index += 1;
    } else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function isNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function median(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function wallTime(command, argv) {
  const started = process.hrtime.bigint();
  const result = spawnSync(command, argv, { cwd: ROOT, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  if (result.status !== 0) throw new Error(`${command} ${argv.join(" ")} failed: ${result.stderr || result.stdout}`);
  return Number(process.hrtime.bigint() - started) / 1e6;
}

function overheadComparison(runs) {
  const baseline = [];
  const launcher = [];
  const native = path.join(ROOT, "bin", "agentshell-darwin-arm64");
  const baselineCommand = fs.existsSync(native) ? native : process.execPath;
  const baselineArgs = fs.existsSync(native)
    ? ["pwd", "--compact"]
    : [path.join(ROOT, "src", "cli.js"), "pwd", "--compact"];
  for (let index = 0; index < runs; index += 1) {
    baseline.push(wallTime(baselineCommand, baselineArgs));
    launcher.push(wallTime(path.join(ROOT, "bin", "agentshell"), ["pwd", "--compact"]));
  }
  return {
    comparable: true,
    baselineMs: median(baseline),
    agentshellMs: median(launcher),
    sampleCount: runs,
    method: "median wall time for equivalent direct runtime and plugin-launcher pwd --compact calls"
  };
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write("Usage: node scripts/performance-sla-probe.js [--runs 7] [--cache-runs 3] [--output sample.json]\n");
      return;
    }
    const sample = buildProbeSample({
      coldStart: runJsonScript("cold-start-benchmark.js", ["--runs", String(options.runs)]),
      compact: runJsonScript("compact-contract-audit.js"),
      cache: Array.from({ length: options.cacheRuns }, () => runJsonScript("cache-benchmark.js")),
      overhead: overheadComparison(options.runs)
    });
    const serialized = `${JSON.stringify(sample, null, 2)}\n`;
    if (options.output) {
      fs.mkdirSync(path.dirname(options.output), { recursive: true });
      fs.writeFileSync(options.output, serialized);
    }
    process.stdout.write(serialized);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
