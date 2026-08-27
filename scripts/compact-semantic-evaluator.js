#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_COMPACT_BUDGET,
  findCompactBudgetViolations,
  measureCompactOutput,
  normalizeCompactBudget
} from "../src/core/compact-budget.js";

const PROTOCOL_VERSION = "agentshell.compact-semantic-quality.v2";
const DEFAULT_THRESHOLD = 0.98;
const DEFAULT_MAX_EXTRA_READ_RISK = 0.05;
const DEFAULT_MIN_TOKEN_REDUCTION = 0.5;
const DEFAULT_CORPUS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../examples/compact-semantic-quality/golden-corpus.json");
const QUALITY_METRICS = ["errorRecall", "fileLocationAccuracy", "lineAccuracy", "decisionConsistency", "necessaryInformationRetention"];
const ALL_METRICS = [...QUALITY_METRICS, "extraReadRisk", "tokenReduction"];

export function loadGoldenCorpus(file = DEFAULT_CORPUS) {
  const corpus = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  validateCorpus(corpus);
  return corpus;
}

export function evaluateCompactCase(fixture, options = {}) {
  const limits = normalizeCompactBudget(options.budget || DEFAULT_COMPACT_BUDGET);
  const candidate = fixture.compact;
  const expected = normalizeExpected(fixture.expected);
  const searchable = normalizeText(flattenStrings(candidate).join("\n"));
  const mainError = extractMainError(candidate);
  const locations = extractLocations(candidate);
  const commands = extractCommands(candidate);
  const lineTolerance = options.lineTolerance ?? expected.lineTolerance ?? 0;

  const errorChecks = expected.errors.map((error) => ({
    anyOf: error.anyOf,
    matched: error.anyOf.some((value) => searchable.includes(normalizeText(value)))
  }));
  const locationChecks = expected.locations.map((location) => {
    const fileMatches = locations.filter((actual) => normalizePath(actual.file) === normalizePath(location.file));
    const nearest = nearestLine(fileMatches, location.line);
    const tolerance = location.lineTolerance ?? lineTolerance;
    return {
      ...location,
      tolerance,
      fileMatched: fileMatches.length > 0,
      actualLine: nearest?.line ?? null,
      lineDelta: nearest ? Math.abs(nearest.line - location.line) : null,
      lineMatched: Boolean(nearest) && Math.abs(nearest.line - location.line) <= tolerance
    };
  });
  const decisionChecks = expected.decisions.map((decision) => {
    const alternatives = decision.anyOf.map(normalizeCommand);
    const actual = commands.find((command) => alternatives.includes(normalizeCommand(command)));
    const textualMatch = decision.anyOf.some((value) => searchable.includes(normalizeText(value)));
    return {
      anyOf: decision.anyOf,
      actual: actual || null,
      retained: Boolean(actual) || textualMatch,
      executable: actual ? isExecutableCommand(actual) : textualMatch,
      matched: (Boolean(actual) && isExecutableCommand(actual)) || textualMatch
    };
  });
  const factChecks = expected.necessaryFacts.map((fact) => ({ fact, matched: searchable.includes(normalizeText(fact)) }));
  const forbiddenFactChecks = expected.forbiddenFacts.map((fact) => ({ fact, present: searchable.includes(normalizeText(fact)) }));
  const extraRead = evaluateExtraReadRisk(commands, expected, decisionChecks);
  const serialized = JSON.stringify(candidate, null, 2);
  const measurement = measureCompactOutput(serialized);
  const baselineMeasurement = measureBaseline(fixture.baseline);
  const tokenReduction = baselineMeasurement
    ? clamp(1 - (measurement.estimatedTokens / Math.max(1, baselineMeasurement.estimatedTokens)))
    : null;
  const budgetViolations = findCompactBudgetViolations(candidate, limits);
  const requiredFactMatches = factChecks.filter((item) => item.matched).length;
  const forbiddenFactMisses = forbiddenFactChecks.filter((item) => !item.present).length;
  const informationUnits = factChecks.length + forbiddenFactChecks.length;
  const scores = {
    errorRecall: ratio(errorChecks.filter((item) => item.matched).length, errorChecks.length),
    fileLocationAccuracy: ratio(locationChecks.filter((item) => item.fileMatched).length, locationChecks.length),
    lineAccuracy: ratio(locationChecks.filter((item) => item.lineMatched).length, locationChecks.length),
    decisionConsistency: ratio(decisionChecks.filter((item) => item.matched).length, decisionChecks.length),
    necessaryInformationRetention: ratio(requiredFactMatches + forbiddenFactMisses, informationUnits),
    extraReadRisk: extraRead.measured ? extraRead.risk : null,
    tokenReduction
  };
  const counts = {
    errorRecall: count(errorChecks.filter((item) => item.matched).length, errorChecks.length),
    fileLocationAccuracy: count(locationChecks.filter((item) => item.fileMatched).length, locationChecks.length),
    lineAccuracy: count(locationChecks.filter((item) => item.lineMatched).length, locationChecks.length),
    decisionConsistency: count(decisionChecks.filter((item) => item.matched).length, decisionChecks.length),
    necessaryInformationRetention: count(requiredFactMatches + forbiddenFactMisses, informationUnits),
    extraReadRisk: extraRead.measured ? count(extraRead.riskyCommands.length, Math.max(1, commands.length)) : count(0, 0),
    tokenReduction: baselineMeasurement
      ? count(Math.max(0, baselineMeasurement.estimatedTokens - measurement.estimatedTokens), baselineMeasurement.estimatedTokens)
      : count(0, 0)
  };
  const qualityPass = QUALITY_METRICS.every((name) => scores[name] === 1);

  return {
    id: fixture.id,
    language: fixture.language,
    scenario: fixture.scenario || "unspecified",
    supported: fixture.supported,
    ok: qualityPass && extraRead.risk === 0 && budgetViolations.length === 0,
    scores,
    counts,
    measurement: { ...measurement, baselineEstimatedTokens: baselineMeasurement?.estimatedTokens ?? null, tokenReduction },
    budgetViolations,
    evidence: {
      mainError,
      errors: errorChecks,
      locations: locationChecks,
      decisions: decisionChecks,
      necessaryFacts: factChecks,
      forbiddenFacts: forbiddenFactChecks,
      extraRead
    }
  };
}

export function evaluateCompactCorpus(corpus, options = {}) {
  validateCorpus(corpus);
  const thresholds = resolveThresholds(corpus, options);
  const cases = corpus.fixtures.filter((fixture) => fixture.supported).map((fixture) => evaluateCompactCase(fixture, {
    ...options,
    lineTolerance: options.lineTolerance ?? corpus.defaultLineTolerance
  }));
  const aggregate = aggregateCases(cases);
  const groups = {
    byLanguage: groupCases(cases, (entry) => entry.language),
    byScenario: groupCases(cases, (entry) => entry.scenario)
  };
  const gates = buildGates(aggregate, thresholds, corpus.version >= 2);
  const budgetPass = cases.every((entry) => entry.budgetViolations.length === 0);
  const ok = cases.length > 0 && Object.values(gates).every((gate) => gate.passed) && budgetPass;

  return {
    ok,
    protocolVersion: PROTOCOL_VERSION,
    compact: true,
    summary: {
      status: ok ? "passed" : "failed",
      fixtureCount: cases.length,
      passedFixtures: cases.filter((entry) => entry.ok).length,
      failedFixtures: cases.filter((entry) => !entry.ok).length,
      budgetPass,
      measuredTokenReductionCases: aggregate.coverage.tokenReduction,
      measuredExtraReadRiskCases: aggregate.coverage.extraReadRisk
    },
    thresholds,
    scores: aggregate.macro,
    micro: aggregate.micro,
    macro: aggregate.macro,
    coverage: aggregate.coverage,
    gates,
    groups,
    limits: normalizeCompactBudget(options.budget || DEFAULT_COMPACT_BUDGET),
    cases
  };
}

function normalizeExpected(expected) {
  const errors = expected.errors || (expected.mainError ? [expected.mainError] : []);
  const decisions = expected.decisions || (expected.nextActions || []).map((action) => ({ anyOf: [action.command] }));
  return {
    errors: errors.map((entry) => typeof entry === "string" ? { anyOf: [entry] } : entry),
    locations: expected.locations || [],
    decisions: decisions.map((entry) => ({ anyOf: entry.anyOf || (entry.command ? [entry.command] : []) })),
    necessaryFacts: expected.necessaryFacts || expected.criticalFacts || [],
    forbiddenFacts: expected.forbiddenFacts || [],
    lineTolerance: expected.lineTolerance,
    additionalRead: expected.additionalRead || null
  };
}

function resolveThresholds(corpus, options) {
  const globalMinimum = options.threshold ?? corpus.acceptanceThreshold ?? DEFAULT_THRESHOLD;
  if (!Number.isFinite(globalMinimum) || globalMinimum < 0 || globalMinimum > 1) throw new RangeError("threshold must be between 0 and 1");
  const configured = corpus.gates || {};
  return {
    errorRecall: options.minErrorRecall ?? configured.minimumErrorRecall ?? globalMinimum,
    fileLocationAccuracy: options.minFileLocationAccuracy ?? configured.minimumFileLocationAccuracy ?? globalMinimum,
    lineAccuracy: options.minLineAccuracy ?? configured.minimumLineAccuracy ?? globalMinimum,
    decisionConsistency: options.minDecisionConsistency ?? configured.minimumDecisionConsistency ?? globalMinimum,
    necessaryInformationRetention: options.minInformationRetention ?? configured.minimumInformationRetention ?? globalMinimum,
    extraReadRisk: options.maxExtraReadRisk ?? configured.maximumExtraReadRisk ?? DEFAULT_MAX_EXTRA_READ_RISK,
    tokenReduction: options.minTokenReduction ?? configured.minimumTokenReduction ?? DEFAULT_MIN_TOKEN_REDUCTION
  };
}

function aggregateCases(cases) {
  const macro = {};
  const micro = {};
  const coverage = {};
  for (const metric of ALL_METRICS) {
    const measured = cases.filter((entry) => entry.scores[metric] !== null);
    coverage[metric] = measured.length;
    macro[metric] = measured.length ? average(measured.map((entry) => entry.scores[metric])) : null;
    const totals = measured.reduce((result, entry) => ({
      numerator: result.numerator + entry.counts[metric].numerator,
      denominator: result.denominator + entry.counts[metric].denominator
    }), { numerator: 0, denominator: 0 });
    micro[metric] = totals.denominator ? totals.numerator / totals.denominator : null;
  }
  macro.overall = overallQuality(macro);
  micro.overall = overallQuality(micro);
  return { macro, micro, coverage };
}

function groupCases(cases, selector) {
  const groups = new Map();
  for (const entry of cases) {
    const key = selector(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, entries]) => {
    const aggregate = aggregateCases(entries);
    return [key, { fixtureCount: entries.length, ...aggregate }];
  }));
}

function buildGates(aggregate, thresholds, requireMeasured) {
  return Object.fromEntries(ALL_METRICS.map((metric) => {
    const value = aggregate.micro[metric];
    const measured = value !== null;
    const direction = metric === "extraReadRisk" ? "maximum" : "minimum";
    const threshold = thresholds[metric];
    return [metric, {
      measured,
      direction,
      threshold,
      value,
      passed: measured
        ? (direction === "maximum" ? value <= threshold : value >= threshold)
        : !requireMeasured
    }];
  }));
}

function evaluateExtraReadRisk(commands, expected, decisionChecks) {
  if (!expected.additionalRead) return { measured: false, risk: 0, riskyCommands: [] };
  if (expected.additionalRead.allowed === true) return { measured: true, risk: 0, riskyCommands: [] };
  const expectedCommands = new Set(decisionChecks.flatMap((entry) => entry.anyOf.map(normalizeCommand)));
  const customPatterns = (expected.additionalRead.disallowedPatterns || []).map((value) => new RegExp(value, "i"));
  const riskyCommands = commands.filter((command) => {
    if (expectedCommands.has(normalizeCommand(command))) return false;
    return isReadCommand(command) || customPatterns.some((pattern) => pattern.test(command));
  });
  return { measured: true, risk: ratio(riskyCommands.length, Math.max(1, commands.length)), riskyCommands };
}

function measureBaseline(baseline) {
  if (baseline === undefined || baseline === null) return null;
  return measureCompactOutput(typeof baseline === "string" ? baseline : JSON.stringify(baseline, null, 2));
}

function extractMainError(value) {
  const paths = [["summary", "mainError"], ["summary", "error"], ["error", "message"], ["primaryFailure", "message"], ["verification", "primaryFailure", "message"], ["failure", "message"]];
  for (const keys of paths) {
    let current = value;
    for (const key of keys) current = current && typeof current === "object" ? current[key] : undefined;
    if (typeof current === "string" && current.trim()) return normalizeText(current);
  }
  return "";
}

function extractLocations(value) {
  const locations = [];
  walk(value, (entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const file = entry.file || entry.path;
    const line = Number(entry.line ?? entry.lineNumber ?? entry.range?.start);
    if (typeof file === "string" && Number.isInteger(line) && line > 0) locations.push({ file, line });
  });
  for (const text of flattenStrings(value)) {
    const patterns = [/(?:^|\s)([\w./\\-]+\.[A-Za-z0-9]+):(\d+)(?::\d+)?/g, /(?:^|\s)([\w./\\-]+\.[A-Za-z0-9]+)\((\d+),\d+\)/g];
    for (const pattern of patterns) for (const match of text.matchAll(pattern)) locations.push({ file: match[1], line: Number(match[2]) });
  }
  return uniqueBy(locations, (item) => `${normalizePath(item.file)}:${item.line}`);
}

function extractCommands(value) {
  const commands = [];
  walk(value, (entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    if (typeof entry.command === "string") commands.push(entry.command);
    if (typeof entry.nextCommand === "string") commands.push(entry.nextCommand);
  });
  return [...new Set(commands)];
}

export function isExecutableCommand(command) {
  if (typeof command !== "string" || !command.trim()) return false;
  if (/[<>]/.test(command) || /\b1-5\b/.test(command) || /\b(TODO|TBD)\b/i.test(command) || /\n|\r|\0/.test(command)) return false;
  const first = command.trim().split(/\s+/)[0];
  return /^(?:\.?\.?\/)?[A-Za-z0-9_@.-]+$/.test(first);
}

function validateCorpus(corpus) {
  if (!corpus || ![1, 2].includes(corpus.version) || !Array.isArray(corpus.fixtures) || corpus.fixtures.length === 0) throw new TypeError("golden corpus must use version 1 or 2 and contain fixtures");
  const ids = new Set();
  for (const fixture of corpus.fixtures) {
    if (!fixture?.id || ids.has(fixture.id)) throw new TypeError("fixture ids must be present and unique");
    ids.add(fixture.id);
    if (!fixture.compact || fixture.compact.compact !== true) throw new TypeError(`${fixture.id}: compact response required`);
    const expected = normalizeExpected(fixture.expected || {});
    if (!expected.errors.length) throw new TypeError(`${fixture.id}: expected.errors or expected.mainError required`);
    if (!expected.locations.length) throw new TypeError(`${fixture.id}: expected.locations required`);
    if (!expected.decisions.length) throw new TypeError(`${fixture.id}: expected.decisions or expected.nextActions required`);
    if (!expected.necessaryFacts.length) throw new TypeError(`${fixture.id}: expected.necessaryFacts or expected.criticalFacts required`);
  }
}

function nearestLine(locations, line) { return locations.reduce((nearest, item) => !nearest || Math.abs(item.line - line) < Math.abs(nearest.line - line) ? item : nearest, null); }
function isReadCommand(command) { return /^(?:agentshell\s+(?:read|log\s+get)|(?:cat|head|tail|less|sed|grep|rg)\b)/i.test(command.trim()); }
function overallQuality(scores) {
  const values = QUALITY_METRICS.map((metric) => scores[metric]).filter((value) => value !== null);
  if (scores.extraReadRisk !== null) values.push(1 - scores.extraReadRisk);
  if (scores.tokenReduction !== null) values.push(scores.tokenReduction);
  return values.length ? average(values) : null;
}
function walk(value, visit) {
  visit(value);
  if (Array.isArray(value)) value.forEach((entry) => walk(entry, visit));
  else if (value && typeof value === "object") Object.values(value).forEach((entry) => walk(entry, visit));
}
function flattenStrings(value) {
  const strings = [];
  walk(value, (entry) => {
    if (typeof entry === "string") strings.push(entry);
    else if (typeof entry === "number" || typeof entry === "boolean") strings.push(String(entry));
    else if (entry && typeof entry === "object" && !Array.isArray(entry)) strings.push(...Object.keys(entry));
  });
  return strings;
}
function normalizePath(value) { return String(value).replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase(); }
function normalizeText(value) { return String(value).trim().toLowerCase().replace(/\s+/g, " "); }
function normalizeCommand(value) { return String(value).trim().replace(/\s+/g, " "); }
function count(numerator, denominator) { return { numerator, denominator }; }
function ratio(numerator, denominator) { return denominator === 0 ? 1 : numerator / denominator; }
function average(values) { return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length; }
function clamp(value) { return Math.max(0, Math.min(1, value)); }
function uniqueBy(values, key) {
  const seen = new Set();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function parseArgs(argv) {
  const options = {};
  const numeric = {
    "--threshold": "threshold", "--line-tolerance": "lineTolerance", "--min-error-recall": "minErrorRecall",
    "--min-file-accuracy": "minFileLocationAccuracy", "--min-line-accuracy": "minLineAccuracy",
    "--min-decision-consistency": "minDecisionConsistency", "--min-information-retention": "minInformationRetention",
    "--max-extra-read-risk": "maxExtraReadRisk", "--min-token-reduction": "minTokenReduction"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--corpus") options.corpus = argv[++index];
    else if (arg in numeric) options[numeric[arg]] = Number(argv[++index]);
    else if (arg === "--gate") options.gate = true;
    else if (arg === "--no-gate") options.gate = false;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write("Usage: node scripts/compact-semantic-evaluator.js [--corpus <file>] [--gate|--no-gate] [--threshold 0.98] [--line-tolerance 2] [--min-token-reduction 0.5]\n");
      return;
    }
    const report = evaluateCompactCorpus(loadGoldenCorpus(options.corpus), options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (options.gate !== false && !report.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
