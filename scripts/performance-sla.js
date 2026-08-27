#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROTOCOL_VERSION = "agentshell.performance-sla.v1";
export const SAMPLE_PROTOCOL_VERSION = "agentshell.performance-sla-sample.v1";

export const DEFAULT_PERFORMANCE_THRESHOLDS = Object.freeze({
  coldStartP95Ms: 150,
  overheadPercent: 5,
  compactEstimatedTokens: 3_000,
  cacheHitSpeedupPercent: 50
});

const CHECK_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "inspection-cold-start-p95",
    thresholdKey: "coldStartP95Ms",
    operator: "<",
    unit: "ms",
    target: "Core inspection cold-start p95 must be below the configured limit."
  }),
  Object.freeze({
    id: "agentshell-overhead",
    thresholdKey: "overheadPercent",
    operator: "<",
    unit: "percent",
    target: "AgentShell overhead must be below the configured limit when a comparable baseline exists."
  }),
  Object.freeze({
    id: "compact-estimated-tokens",
    thresholdKey: "compactEstimatedTokens",
    operator: "<=",
    unit: "estimated_tokens",
    target: "Every sampled compact response must remain within the configured token estimate."
  }),
  Object.freeze({
    id: "cache-hit-speedup",
    thresholdKey: "cacheHitSpeedupPercent",
    operator: ">",
    unit: "percent",
    target: "Cache-hit end-to-end speedup must exceed the configured minimum."
  })
]);

export function buildPerformanceSlaReport(sample, options = {}) {
  const thresholds = normalizeThresholds(options.thresholds);
  const checks = [
    coldStartCheck(sample?.measurements?.coldStartMs, thresholds),
    overheadCheck(sample?.measurements?.overheadComparison, thresholds),
    compactCheck(sample?.measurements?.compactEstimatedTokens, thresholds),
    cacheCheck(sample?.measurements?.cacheComparison, thresholds)
  ];
  const counts = countStatuses(checks);
  const gateStatus = counts.failed > 0
    ? "failed"
    : counts.unavailable > 0
      ? "unavailable"
      : "passed";

  return {
    ok: gateStatus === "passed",
    protocolVersion: PROTOCOL_VERSION,
    source: normalizeSource(sample),
    thresholds,
    summary: {
      gateStatus,
      total: checks.length,
      passed: counts.passed,
      failed: counts.failed,
      unavailable: counts.unavailable
    },
    checks
  };
}

export function normalizeThresholds(overrides = {}) {
  const result = { ...DEFAULT_PERFORMANCE_THRESHOLDS };
  for (const key of Object.keys(result)) {
    if (overrides?.[key] === undefined) continue;
    const value = Number(overrides[key]);
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`${key} must be a non-negative number`);
    result[key] = value;
  }
  return result;
}

export function percentile(values, percentileValue) {
  const numbers = finiteNonNegativeNumbers(values);
  if (numbers.length === 0) return null;
  numbers.sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentileValue * numbers.length));
  return numbers[Math.min(numbers.length - 1, rank - 1)];
}

function coldStartCheck(values, thresholds) {
  const samples = finiteNonNegativeNumbers(values);
  if (!Array.isArray(values) || samples.length !== values.length || samples.length === 0) {
    return unavailableCheck(0, "No valid core inspection cold-start samples were provided.", thresholds);
  }
  return measuredCheck(0, percentile(samples, 0.95), samples.length, thresholds, `nearest-rank p95 of ${samples.length} wall-clock samples`);
}

function overheadCheck(comparison, thresholds) {
  if (!comparison || comparison.comparable !== true) {
    return unavailableCheck(1, "No explicitly comparable baseline was provided.", thresholds);
  }
  const baselineMs = Number(comparison.baselineMs);
  const agentshellMs = Number(comparison.agentshellMs);
  const sampleCount = Number(comparison.sampleCount || 1);
  if (comparison.sampleCount !== undefined && (!Number.isInteger(sampleCount) || sampleCount < 3)) {
    return unavailableCheck(1, "Comparable overhead evidence requires at least three samples.", thresholds);
  }
  if (!Number.isFinite(baselineMs) || baselineMs <= 0 || !Number.isFinite(agentshellMs) || agentshellMs < 0) {
    return unavailableCheck(1, "Comparable overhead measurements require baselineMs > 0 and agentshellMs >= 0.", thresholds);
  }
  const value = round(((agentshellMs - baselineMs) / baselineMs) * 100);
  return measuredCheck(1, value, sampleCount, thresholds, comparison.method || "(AgentShell wall time - baseline wall time) / baseline wall time");
}

function compactCheck(values, thresholds) {
  const samples = finiteNonNegativeNumbers(values);
  if (!Array.isArray(values) || samples.length !== values.length || samples.length === 0) {
    return unavailableCheck(2, "No valid compact-output token estimates were provided.", thresholds);
  }
  return measuredCheck(2, Math.max(...samples), samples.length, thresholds, `maximum of ${samples.length} estimated-token samples`);
}

function cacheCheck(comparison, thresholds) {
  if (!comparison) return unavailableCheck(3, "No cache miss/hit wall-clock comparison was provided.", thresholds);
  const missMs = Number(comparison.missMs);
  const hitMs = Number(comparison.hitMs);
  const sampleCount = Number(comparison.sampleCount || 1);
  if (comparison.sampleCount !== undefined && (!Number.isInteger(sampleCount) || sampleCount < 3)) {
    return unavailableCheck(3, "Cache speedup evidence requires at least three miss/hit pairs.", thresholds);
  }
  if (!Number.isFinite(missMs) || missMs <= 0 || !Number.isFinite(hitMs) || hitMs < 0) {
    return unavailableCheck(3, "Cache comparison requires missMs > 0 and hitMs >= 0.", thresholds);
  }
  const value = round(((missMs - hitMs) / missMs) * 100);
  return measuredCheck(3, value, sampleCount, thresholds, "(median cache miss wall time - median cache hit wall time) / median cache miss wall time");
}

function measuredCheck(index, value, samples, thresholds, method) {
  const definition = CHECK_DEFINITIONS[index];
  const threshold = thresholds[definition.thresholdKey];
  const passed = compare(value, definition.operator, threshold);
  return {
    id: definition.id,
    status: passed ? "pass" : "fail",
    required: true,
    target: definition.target,
    operator: definition.operator,
    threshold,
    value,
    unit: definition.unit,
    samples,
    method,
    reason: passed ? null : `Measured ${value} ${definition.unit}; target is ${definition.operator} ${threshold}.`
  };
}

function unavailableCheck(index, reason, thresholds) {
  const definition = CHECK_DEFINITIONS[index];
  return {
    id: definition.id,
    status: "unavailable",
    required: true,
    target: definition.target,
    operator: definition.operator,
    threshold: thresholds[definition.thresholdKey],
    value: null,
    unit: definition.unit,
    samples: 0,
    method: null,
    reason
  };
}

function compare(value, operator, threshold) {
  if (operator === "<") return value < threshold;
  if (operator === "<=") return value <= threshold;
  if (operator === ">") return value > threshold;
  throw new Error(`Unsupported operator: ${operator}`);
}

function finiteNonNegativeNumbers(values) {
  if (!Array.isArray(values)) return [];
  return values.map(Number).filter((value) => Number.isFinite(value) && value >= 0);
}

function normalizeSource(sample) {
  return {
    protocolVersion: sample?.protocolVersion === SAMPLE_PROTOCOL_VERSION ? SAMPLE_PROTOCOL_VERSION : null,
    mode: typeof sample?.source?.mode === "string" ? sample.source.mode : "unknown",
    description: typeof sample?.source?.description === "string" ? sample.source.description : null
  };
}

function countStatuses(checks) {
  return checks.reduce((counts, check) => {
    const key = check.status === "pass" ? "passed" : check.status === "fail" ? "failed" : "unavailable";
    counts[key] += 1;
    return counts;
  }, { passed: 0, failed: 0, unavailable: 0 });
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function parseArgs(argv) {
  const options = { input: null, gate: false, thresholds: {}, output: null };
  const thresholdFlags = {
    "--max-cold-start-p95-ms": "coldStartP95Ms",
    "--max-overhead-percent": "overheadPercent",
    "--max-compact-tokens": "compactEstimatedTokens",
    "--min-cache-speedup-percent": "cacheHitSpeedupPercent"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--gate") options.gate = true;
    else if (arg === "--input" || arg === "--output") {
      const value = requiredValue(argv[index + 1], arg);
      options[arg.slice(2)] = path.resolve(value);
      index += 1;
    } else if (thresholdFlags[arg]) {
      options.thresholds[thresholdFlags[arg]] = requiredValue(argv[index + 1], arg);
      index += 1;
    } else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function requiredValue(value, flag) {
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function usage() {
  return [
    "Usage: node scripts/performance-sla.js --input <sample.json> [--gate] [--output <report.json>]",
    "  [--max-cold-start-p95-ms 150] [--max-overhead-percent 5]",
    "  [--max-compact-tokens 3000] [--min-cache-speedup-percent 50]"
  ].join("\n");
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    if (!options.input) throw new Error("--input is required");
    const sample = JSON.parse(fs.readFileSync(options.input, "utf8"));
    const report = buildPerformanceSlaReport(sample, options);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) {
      fs.mkdirSync(path.dirname(options.output), { recursive: true });
      fs.writeFileSync(options.output, serialized);
    }
    process.stdout.write(serialized);
    if (options.gate && !report.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
