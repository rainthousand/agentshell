import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureState, readActiveRun, readEvents, readOperations, readRuns, stateDir } from "../core/store.js";
import { readCommandObservations } from "../core/command-coverage.js";
import {
  aggregateVerifiedSavings,
  collectVerifiedSavingsContributions
} from "../core/verified-savings.js";
import { readRegisteredWorkspaces } from "../core/workspace-registry.js";
import { runStatus, summarizeRun } from "./run-status.js";

const PROTOCOL_VERSION = "agentshell.metrics.v2";
const FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1000;
const COMPACT_TOP_COMMANDS = 3;
const COMPACT_TREND_POINTS = 3;
const COMPACT_CHANGED_FILES = 3;
const COMPACT_MAX_SERIALIZED_CHARS = 8 * 1024;
const COMPACT_IDENTIFIER_CHARS = 120;
const COMPACT_MESSAGE_CHARS = 240;

export async function metrics(root, options = {}) {
  const scope = parseScope(options.scope);
  const limit = parseLimit(options.limit);
  const compact = Boolean(options.compact);
  const roots = metricRoots(root, scope, options);
  const datasets = roots.map((workspaceRoot) => workspaceDataset(
    workspaceRoot,
    options.since,
    scope === "global"
  ));
  const allEvents = datasets.flatMap((dataset) => dataset.events)
    .sort((a, b) => dateValue(a.createdAt) - dateValue(b.createdAt));
  const events = allEvents.slice(-limit);
  const operations = datasets.flatMap((dataset) => dataset.operations);
  const verifyOps = operations.filter((operation) => operation.type === "verify");
  const verifyRawChars = sum(verifyOps.map((operation) => operation.rawOutputChars || 0));
  const outputChars = sum(allEvents.map((event) => event.outputChars || 0));
  const attribution = combineAttribution(datasets.map((dataset) => (
    attributedVerification(dataset.events, dataset.verifyOperations)
  )));

  const latestRun = scope === "workspace"
    ? (await runStatus(root, "status")).summary
    : latestRunSummary(datasets);
  const boundedLatestRun = compact ? compactLatestRun(latestRun) : latestRun;
  const visibleLatestRun = scope === "global" ? redactWorkspaceRoots(boundedLatestRun, roots) : boundedLatestRun;
  const byCommand = groupByCommand(events);
  const dashboard = dashboardSummary(root, datasets, allEvents.length, scope, compact, options);
  const tokenAccounting = tokenAccountingFor(outputChars, attribution, datasets);
  const cutoff = scope === "workspace" ? datasets[0]?.cutoff || 0 : globalCutoff(options.since);
  const base = {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact,
    scope,
    workspaceCount: roots.length,
    window: {
      events: allEvents.length,
      limit,
      since: options.since || "all",
      cutoff: cutoff ? new Date(cutoff).toISOString() : null
    },
    totals: {
      agentShellOutputChars: outputChars,
      agentShellEstimatedTokens: estimateTokens(outputChars),
      verifyRawOutputChars: verifyRawChars,
      verifyRawEstimatedTokens: estimateTokens(verifyRawChars)
    },
    savings: attribution.rawTokens > 0 ? {
      charsSavedVsRawVerify: attribution.charsSaved,
      percentSavedVsRawVerify: attribution.percentSaved
    } : null,
    tokenAccounting,
    latestRun: visibleLatestRun,
    measurement: {
      scope: "agentshell-local-tooling",
      measured: ["commandCount", "commandExecutionMs", "workflowElapsedMs", "verificationStatus"],
      estimated: ["agentShellOutputTokens", "rawVerifyTokens", "contextAvoidedTokens"],
      unavailable: ["codexModelTokens", "codexThinkingTimeMs", "nonAgentShellCommandTelemetry"],
      estimation: {
        contextTokens: {
          availability: allEvents.length > 0 || attribution.exactRawChars > 0 ? "available" : "unavailable",
          method: "measured-characters-divided-by-four",
          measuredUnit: "characters",
          estimatedUnit: "context-tokens",
          charsPerToken: 4
        },
        timeSavings: {
          availability: dashboard.coverage.verifiedTimeSavingsAvailable ? "available" : "unavailable",
          method: "median-cache-miss-baseline",
          estimatedUnit: "milliseconds",
          robust: true
        }
      },
      attribution: {
        exactEvents: attribution.exactEvents,
        legacyEvents: attribution.legacyEvents,
        method: attribution.legacyEvents > 0 ? "operation-id-with-legacy-fallback" : "operation-id"
      },
      freshness: dashboard.freshness,
      coverage: dashboard.coverage
    },
    dashboard,
    privacy: {
      storage: scope === "global" ? "local-machine-registry" : "local-workspace-only",
      networkUpload: false,
      includesFileContents: false,
      includesCommandOutput: false,
      workspacePathsExposed: false
    }
  };

  if (compact) {
    return fitCompactBudget({
      ...base,
      topCommands: topCommands(byCommand, COMPACT_TOP_COMMANDS).map((entry) => ({
        ...entry,
        command: boundedText(entry.command, COMPACT_IDENTIFIER_CHARS)
      }))
    });
  }

  return {
    ...base,
    byCommand,
    recentEvents: events.slice(-10).reverse().map((event) => (
      scope === "global" ? redactWorkspaceRoots(event, roots) : event
    ))
  };
}

export function resetMetrics(root, options = {}) {
  const resetAt = new Date().toISOString();
  const file = path.join(ensureState(root), "metrics-reset.json");
  writeJsonAtomic(file, { resetAt });
  const snapshot = dashboardSnapshotFile(root, options);
  let dashboardSnapshot = "absent";
  try {
    fs.unlinkSync(snapshot);
    dashboardSnapshot = "invalidated";
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    resetAt,
    preservedHistory: true,
    dashboardSnapshot
  };
}

export async function exportMetrics(root, out, options = {}) {
  const report = await metrics(root, {
    compact: false,
    since: options.since,
    scope: options.scope,
    homeDir: options.homeDir
  });
  const output = path.resolve(root, out);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  return { ok: true, protocolVersion: PROTOCOL_VERSION, output, generatedAt: report.dashboard.generatedAt };
}

function dashboardSummary(root, datasets, toolCallCount, scope, compact = false, options = {}) {
  const runEntries = datasets.flatMap((dataset) => dataset.runs.map((run) => ({
    run,
    summary: summarizeRun(run)
  }))).sort((a, b) => dateValue(a.run.updatedAt) - dateValue(b.run.updatedAt));
  const runs = runEntries.map((entry) => entry.run);
  const summaries = runEntries.map((entry) => entry.summary);
  const events = datasets.flatMap((dataset) => dataset.events);
  const commandObservations = datasets.flatMap((dataset) => dataset.commandObservations);
  const operations = datasets.flatMap((dataset) => dataset.operations);
  const evaluated = summaries.filter((run) => run.status === "passed" || run.status === "failing");
  const passed = evaluated.filter((run) => run.status === "passed").length;
  const commandCount = sum(summaries.map((run) => run.commandCount));
  const executionMs = sum(summaries.map((run) => run.durationMs));
  const workflowElapsedMs = sum(runs.map(elapsedMsForRun));
  const robustTimeSavings = robustTimeSavingsFor(datasets);
  const estimatedTimeSavedMs = robustTimeSavings.available ? robustTimeSavings.totalMs : null;
  const agentShellOutputTokens = sum(events.map((event) => event.estimatedTokens || estimateTokens(event.outputChars || 0)));
  const attribution = combineAttribution(datasets.map((dataset) => (
    attributedVerification(dataset.events, dataset.verifyOperations)
  )));
  const rawVerifyTokens = attribution.rawTokens;
  const estimatedContextAvoidedTokens = attribution.rawTokens > 0
    ? attribution.tokensSaved
    : null;
  const contextAvoidedPercent = estimatedContextAvoidedTokens === null
    ? null
    : attribution.percentSaved;
  const latest = summaries.at(-1) || null;
  const freshness = freshnessFor(events, operations, runs);
  const coverage = coverageFor(summaries, runs, toolCallCount, attribution, estimatedTimeSavedMs, commandObservations);
  const verifiedSavings = withRobustTimeSavings(aggregateVerifiedSavings(
    collectVerifiedSavingsContributions(datasets),
    { now: options.now, timeZone: options.timeZone }
  ), robustTimeSavings);

  return {
    generatedAt: new Date().toISOString(),
    workspace: {
      name: compact
        ? boundedText(scope === "global" ? "All workspaces" : workspaceName(root), COMPACT_IDENTIFIER_CHARS)
        : scope === "global" ? "All workspaces" : workspaceName(root)
    },
    health: healthFor(latest, runs.at(-1)),
    freshness,
    coverage,
    verifiedSavings,
    totals: {
      tasks: summaries.length,
      managedRuns: summaries.length,
      operations: operations.length,
      toolCalls: toolCallCount,
      passed,
      successRate: evaluated.length > 0 ? Math.round((passed / evaluated.length) * 100) : null,
      commandCount,
      averageCommandsPerTask: summaries.length > 0 ? roundOne(commandCount / summaries.length) : null,
      agentShellOutputTokens,
      agentShellEstimatedContextTokens: events.length > 0 ? agentShellOutputTokens : null,
      rawVerifyTokens,
      rawVerifyEstimatedContextTokens: attribution.rawChars > 0 ? rawVerifyTokens : null,
      estimatedContextAvoidedTokens,
      contextAvoidedPercent,
      executionMs,
      workflowElapsedMs,
      estimatedTimeSavedMs
    },
    latestTask: latest ? taskForDashboard(latest, runs.at(-1)) : null,
    trend: runEntries.slice(compact ? -COMPACT_TREND_POINTS : -12)
      .map(({ summary, run }) => taskForTrend(summary, run))
  };
}

function tokenAccountingFor(agentShellOutputChars, attribution, datasets) {
  const workspaceCount = datasets.length;
  const baselineAvailable = attribution.exactRawChars > 0;
  const verifiedWorkspaceCount = attribution.verifiedWorkspaceCount;
  const observedWorkspaceCount = datasets.filter((dataset) => dataset.events.length > 0).length;
  const verifiedAvailability = availabilityFor(verifiedWorkspaceCount, workspaceCount);
  const exactRawTokens = estimateTokens(attribution.exactRawChars);
  const exactCompactTokens = estimateTokens(attribution.exactCompactChars);
  const exactSavedChars = Math.max(0, attribution.exactRawChars - attribution.exactCompactChars);
  const exactSavedTokens = Math.max(0, exactRawTokens - exactCompactTokens);
  return {
    rawCommandBaseline: {
      availability: verifiedAvailability,
      scope: "attributed-verification-output",
      outputChars: baselineAvailable ? attribution.exactRawChars : null,
      estimatedTokens: baselineAvailable ? exactRawTokens : null,
      ...accountingCoverage(workspaceCount, verifiedWorkspaceCount)
    },
    agentShellActualOutput: {
      availability: availabilityFor(observedWorkspaceCount, workspaceCount),
      scope: "observed-agentshell-events",
      outputChars: observedWorkspaceCount > 0 ? agentShellOutputChars : null,
      estimatedTokens: observedWorkspaceCount > 0 ? estimateTokens(agentShellOutputChars) : null,
      ...accountingCoverage(workspaceCount, observedWorkspaceCount)
    },
    verifiedContextSaved: {
      availability: verifiedAvailability,
      scope: "raw-baseline-minus-attributed-agentshell-output",
      outputChars: baselineAvailable ? exactSavedChars : null,
      estimatedTokens: baselineAvailable ? exactSavedTokens : null,
      percent: baselineAvailable
        ? Math.max(0, Math.round((1 - attribution.exactCompactChars / attribution.exactRawChars) * 100))
        : null,
      ...accountingCoverage(workspaceCount, verifiedWorkspaceCount)
    },
    modelTokens: {
      availability: "unavailable",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null
    }
  };
}

function workspaceDataset(root, since, filterRuns) {
  const cutoff = metricsCutoff(root, since);
  const events = readEvents(root).filter((event) => afterCutoff(event.createdAt, cutoff));
  const operations = readOperations(root).filter((operation) => afterCutoff(operation.createdAt, cutoff));
  return {
    root,
    cutoff,
    events,
    operations,
    commandObservations: readCommandObservations(root).filter((observation) => afterCutoff(observation.createdAt, cutoff)),
    verifyOperations: operations.filter((operation) => operation.type === "verify"),
    runs: filterRuns
      ? uniqueRuns(root).filter((run) => afterCutoff(run.updatedAt, cutoff))
      : uniqueRuns(root)
  };
}

function metricRoots(root, scope, options) {
  const current = canonicalRoot(root);
  if (scope === "workspace") return [current];
  const registered = readRegisteredWorkspaces({
    homeDir: options.homeDir,
    excludeTemporary: options.homeDir === undefined
  });
  const values = Array.isArray(registered) ? registered : registered?.workspaces || [];
  const roots = values.map(registeredRoot).filter(Boolean);
  return [...new Set([current, ...roots].map(canonicalRoot))]
    .filter((value) => fs.existsSync(value));
}

function canonicalRoot(value) {
  const resolved = path.resolve(value);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function registeredRoot(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  return value.root || value.path || value.workspaceRoot || null;
}

function redactWorkspaceRoots(value, roots) {
  if (Array.isArray(value)) return value.map((entry) => redactWorkspaceRoots(entry, roots));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      redactWorkspaceRoots(entry, roots)
    ]));
  }
  if (typeof value !== "string") return value;
  return roots.flatMap(workspacePathAliases).reduce((redacted, workspaceRoot) => (
    redacted.split(workspaceRoot).join("<workspace>")
  ), value);
}

function workspacePathAliases(root) {
  if (root.startsWith("/private/var/")) return [root, root.slice("/private".length)];
  if (root.startsWith("/var/")) return [root, `/private${root}`];
  return [root];
}

function latestRunSummary(datasets) {
  const latest = datasets.flatMap((dataset) => dataset.runs)
    .sort((a, b) => dateValue(a.updatedAt) - dateValue(b.updatedAt))
    .at(-1);
  return latest ? summarizeRun(latest) : null;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function robustTimeSavingsFor(datasets) {
  const baselines = new Map();
  const seenHits = new Set();
  const contributions = [];
  const entries = datasets.flatMap((dataset) => dataset.operations.map((operation) => ({
    operation,
    workspace: dataset.root
  }))).sort((left, right) => dateValue(left.operation.createdAt) - dateValue(right.operation.createdAt));
  for (const { operation, workspace } of entries) {
    if (operation.type !== "verify" || !operation.cacheKey) continue;
    const baselineKey = `${workspace}\0${operation.cacheKey}`;
    if (!operation.cacheHit && Number.isFinite(operation.durationMs)) {
      const samples = baselines.get(baselineKey) || [];
      samples.push(Math.max(0, operation.durationMs));
      baselines.set(baselineKey, samples);
      continue;
    }
    const baseline = median(baselines.get(baselineKey) || []);
    if (!operation.cacheHit || !operation.id || seenHits.has(operation.id) || baseline === null) continue;
    seenHits.add(operation.id);
    contributions.push({
      at: operation.createdAt,
      savedMs: Math.max(0, baseline - (Number(operation.durationMs) || 0))
    });
  }
  return {
    available: contributions.length > 0,
    totalMs: contributions.reduce((total, entry) => total + entry.savedMs, 0),
    contributions
  };
}

function withRobustTimeSavings(report, robustTimeSavings) {
  const byDate = new Map();
  for (const contribution of robustTimeSavings.contributions) {
    const date = localDateKey(contribution.at, report.timeZone);
    byDate.set(date, (byDate.get(date) || 0) + contribution.savedMs);
  }
  const timeFor = (period) => ({ ...period, timeMs: byDate.get(period.date) || 0 });
  return {
    ...report,
    today: timeFor(report.today),
    last7Days: report.last7Days.map(timeFor),
    allTime: {
      ...report.allTime,
      timeMs: [...byDate.values()].reduce((total, value) => total + value, 0)
    },
    availability: { ...report.availability, time: robustTimeSavings.available },
    methodology: { ...report.methodology, time: "robust-estimated-cache-hit-median-baseline" }
  };
}

function localDateKey(value, timeZone) {
  const date = new Date(dateValue(value));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function attributedVerification(events, operations) {
  const operationById = new Map(operations.filter((operation) => operation.id).map((operation) => [operation.id, operation]));
  const claimed = new Set();
  let rawChars = 0;
  let compactChars = 0;
  let exactEvents = 0;
  let legacyEvents = 0;
  let exactRawChars = 0;
  let exactCompactChars = 0;

  for (const event of events) {
    const ids = Array.isArray(event.operationIds)
      ? event.operationIds.filter((id) => operationById.has(id))
      : [];
    if (ids.length > 0) {
      exactEvents += 1;
      compactChars += event.outputChars || 0;
      exactCompactChars += event.outputChars || 0;
      for (const id of ids) {
        if (claimed.has(id)) continue;
        claimed.add(id);
        const operationChars = operationById.get(id).rawOutputChars || 0;
        rawChars += operationChars;
        exactRawChars += operationChars;
      }
      continue;
    }
    if (event.command !== "verify" && event.command !== "fix") continue;
    legacyEvents += 1;
    compactChars += event.outputChars || 0;
  }

  if (legacyEvents > 0) {
    for (const operation of operations) {
      if (!claimed.has(operation.id)) rawChars += operation.rawOutputChars || 0;
    }
  }
  const rawTokens = estimateTokens(rawChars);
  const compactTokens = estimateTokens(compactChars);
  return {
    rawChars,
    compactChars,
    rawTokens,
    compactTokens,
    tokensSaved: rawTokens > 0 ? Math.max(0, rawTokens - compactTokens) : null,
    charsSaved: Math.max(0, rawChars - compactChars),
    percentSaved: rawChars > 0 ? Math.max(0, Math.round((1 - compactChars / rawChars) * 100)) : null,
    exactRawChars,
    exactCompactChars,
    verifiedWorkspaceCount: exactRawChars > 0 ? 1 : 0,
    exactEvents,
    legacyEvents
  };
}

function combineAttribution(values) {
  const rawChars = sum(values.map((value) => value.rawChars));
  const compactChars = sum(values.map((value) => value.compactChars));
  const rawTokens = estimateTokens(rawChars);
  const compactTokens = estimateTokens(compactChars);
  const exactRawChars = sum(values.map((value) => value.exactRawChars));
  const exactCompactChars = sum(values.map((value) => value.exactCompactChars));
  return {
    rawChars,
    compactChars,
    rawTokens,
    compactTokens,
    tokensSaved: rawTokens > 0 ? Math.max(0, rawTokens - compactTokens) : null,
    charsSaved: Math.max(0, rawChars - compactChars),
    percentSaved: rawChars > 0 ? Math.max(0, Math.round((1 - compactChars / rawChars) * 100)) : null,
    exactRawChars,
    exactCompactChars,
    verifiedWorkspaceCount: sum(values.map((value) => value.verifiedWorkspaceCount)),
    exactEvents: sum(values.map((value) => value.exactEvents)),
    legacyEvents: sum(values.map((value) => value.legacyEvents))
  };
}

function healthFor(latest, run) {
  if (!latest) return "idle";
  const ageMs = Date.now() - dateValue(run?.updatedAt);
  if (ageMs > 24 * 60 * 60 * 1000) return "idle";
  return latest.status === "failing" ? "attention" : "ready";
}

function uniqueRuns(root) {
  const map = new Map();
  for (const run of readRuns(root)) {
    if (run?.id) map.set(run.id, run);
  }
  const active = readActiveRun(root);
  if (active?.id) map.set(active.id, active);
  return [...map.values()].sort((a, b) => dateValue(a.updatedAt) - dateValue(b.updatedAt));
}

function taskForDashboard(summary, run) {
  const stale = staleRun(summary, run);
  return {
    id: boundedText(summary.runId, COMPACT_IDENTIFIER_CHARS),
    status: summary.status,
    commandCount: summary.commandCount,
    estimatedTokens: summary.estimatedTokens,
    executionMs: summary.durationMs,
    workflowElapsedMs: elapsedMsForRun(run),
    finishedAt: run?.updatedAt || null,
    changedFileCount: summary.latestChange?.changedFiles?.length || 0,
    verificationOk: summary.latestVerify?.ok === true,
    stale,
    lifecycle: stale ? "stale" : summary.status === "in_progress" ? "active" : "complete"
  };
}

function taskForTrend(summary, run) {
  const stale = staleRun(summary, run);
  return {
    id: boundedText(summary.runId, COMPACT_IDENTIFIER_CHARS),
    status: summary.status,
    estimatedTokens: summary.estimatedTokens,
    executionMs: summary.durationMs,
    workflowElapsedMs: elapsedMsForRun(run),
    finishedAt: run?.updatedAt || null,
    stale,
    lifecycle: stale ? "stale" : summary.status === "in_progress" ? "active" : "complete"
  };
}

function freshnessFor(events, operations, runs) {
  const latestMs = Math.max(0, ...events.map((event) => dateValue(event.createdAt)),
    ...operations.map((operation) => dateValue(operation.createdAt)),
    ...runs.map((run) => dateValue(run.updatedAt)));
  if (latestMs === 0) {
    return { status: "empty", latestAt: null, ageMs: null, staleAfterMs: FRESHNESS_WINDOW_MS };
  }
  const ageMs = Math.max(0, Date.now() - latestMs);
  return {
    status: ageMs > FRESHNESS_WINDOW_MS ? "stale" : "fresh",
    latestAt: new Date(latestMs).toISOString(),
    ageMs,
    staleAfterMs: FRESHNESS_WINDOW_MS
  };
}

function coverageFor(summaries, runs, toolCalls, attribution, estimatedTimeSavedMs, commandObservations = []) {
  const attributableEvents = attribution.exactEvents + attribution.legacyEvents;
  const externalTelemetryAvailable = commandObservations.length > 0;
  const externalCommandCount = externalTelemetryAvailable ? commandObservations.length : null;
  const observedToolCalls = externalTelemetryAvailable ? toolCalls + externalCommandCount : toolCalls;
  const staleManagedRuns = summaries.filter((summary, index) => staleRun(summary, runs[index])).length;
  const activeManagedRuns = summaries.filter((summary, index) => (
    summary.status === "in_progress" && !staleRun(summary, runs[index])
  )).length;
  return {
    observedToolCalls,
    agentShellCommandHits: toolCalls,
    externalCommandCount,
    fallbackCommandCount: externalCommandCount,
    commandCoveragePercent: externalTelemetryAvailable && observedToolCalls > 0
      ? Math.round((toolCalls / observedToolCalls) * 100)
      : null,
    fallbackRatePercent: externalTelemetryAvailable && observedToolCalls > 0
      ? Math.round((externalCommandCount / observedToolCalls) * 100)
      : null,
    externalCommandTelemetryAvailable: externalTelemetryAvailable,
    managedRuns: summaries.length,
    evaluatedManagedRuns: summaries.filter((summary) => ["passed", "failing"].includes(summary.status)).length,
    activeManagedRuns,
    staleManagedRuns,
    attributableEvents,
    exactAttributedEvents: attribution.exactEvents,
    exactAttributionPercent: attributableEvents > 0
      ? Math.round((attribution.exactEvents / attributableEvents) * 100)
      : null,
    verifiedTokenSavingsAvailable: attribution.exactRawChars > 0,
    verifiedTimeSavingsAvailable: estimatedTimeSavedMs !== null
  };
}

function compactLatestRun(summary) {
  if (!summary) return null;
  return {
    runId: boundedText(summary.runId, COMPACT_IDENTIFIER_CHARS),
    status: summary.status,
    commandCount: summary.commandCount,
    nodeCount: summary.nodeCount,
    outputChars: summary.outputChars,
    estimatedTokens: summary.estimatedTokens,
    durationMs: summary.durationMs,
    diagnosis: summary.diagnosis ? {
      verificationOk: summary.diagnosis.verificationOk,
      logRef: boundedText(summary.diagnosis.logRef, COMPACT_IDENTIFIER_CHARS),
      confidence: boundedText(summary.diagnosis.confidence, COMPACT_IDENTIFIER_CHARS),
      targetFile: boundedText(summary.diagnosis.targetFile, COMPACT_MESSAGE_CHARS)
    } : null,
    latestChange: summary.latestChange ? {
      ok: summary.latestChange.ok,
      changedFiles: Array.isArray(summary.latestChange.changedFiles)
        ? summary.latestChange.changedFiles.slice(0, COMPACT_CHANGED_FILES)
          .map((file) => boundedText(file, COMPACT_MESSAGE_CHARS))
        : []
    } : null,
    latestVerify: summary.latestVerify ? {
      ok: summary.latestVerify.ok,
      logRef: boundedText(summary.latestVerify.logRef, COMPACT_IDENTIFIER_CHARS),
      summary: {
        mainError: boundedText(summary.latestVerify.summary?.mainError, COMPACT_MESSAGE_CHARS),
        failedTests: summary.latestVerify.summary?.failedTests ?? null
      }
    } : null,
    rollbackCommand: boundedText(summary.rollbackCommand, COMPACT_MESSAGE_CHARS),
    nextBestAction: boundedText(summary.nextBestAction, COMPACT_MESSAGE_CHARS)
  };
}

function fitCompactBudget(report) {
  const outputBudget = {
    maxSerializedChars: COMPACT_MAX_SERIALIZED_CHARS,
    serializedChars: 0,
    degraded: false
  };
  let compact = { ...report, outputBudget };
  stabilizeSerializedChars(compact);
  if (compact.outputBudget.serializedChars <= COMPACT_MAX_SERIALIZED_CHARS) return compact;

  compact = {
    ...compact,
    latestRun: null,
    topCommands: [],
    dashboard: { ...compact.dashboard, latestTask: null, trend: [] },
    outputBudget: { ...outputBudget, degraded: true }
  };
  stabilizeSerializedChars(compact);
  return compact;
}

function stabilizeSerializedChars(report) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    report.outputBudget.serializedChars = JSON.stringify(report, null, 2).length;
  }
}

function boundedText(value, limit) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function availabilityFor(availableCount, totalCount) {
  if (availableCount === 0) return "unavailable";
  return availableCount === totalCount ? "available" : "partial";
}

function accountingCoverage(workspaceCount, availableWorkspaceCount) {
  return workspaceCount === 1 ? {} : { workspaceCount, availableWorkspaceCount };
}

function staleRun(summary, run) {
  return summary?.status !== "passed"
    && Date.now() - dateValue(run?.updatedAt) > FRESHNESS_WINDOW_MS;
}

function elapsedMsForRun(run) {
  const start = dateValue(run?.startedAt);
  const end = dateValue(run?.updatedAt);
  return start > 0 && end >= start ? end - start : 0;
}

function workspaceName(root) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    if (typeof value.name === "string" && value.name.trim()) return value.name.trim();
  } catch {
    // Fall back to the directory name for non-package workspaces.
  }
  return path.basename(path.resolve(root));
}

function groupByCommand(events) {
  const groups = new Map();
  for (const event of events) {
    const key = event.command || "unknown";
    const current = groups.get(key) || {
      count: 0,
      outputChars: 0,
      estimatedTokens: 0
    };
    current.count += 1;
    current.outputChars += event.outputChars || 0;
    current.estimatedTokens += event.estimatedTokens || 0;
    groups.set(key, current);
  }
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function topCommands(groups, limit) {
  return Object.entries(groups)
    .map(([command, stats]) => ({ command, ...stats }))
    .sort((a, b) => b.estimatedTokens - a.estimatedTokens || a.command.localeCompare(b.command))
    .slice(0, limit);
}

function parseLimit(value) {
  const parsed = Number(value || 500);
  if (!Number.isInteger(parsed) || parsed <= 0) return 500;
  return Math.min(parsed, 500);
}

function parseScope(value) {
  const scope = value || "workspace";
  if (scope !== "workspace" && scope !== "global") {
    throw new Error("Metrics --scope must be `workspace` or `global`");
  }
  return scope;
}

function globalCutoff(since) {
  if (!since || since === "all") return 0;
  const match = /^(\d+)(h|d)$/.exec(String(since));
  if (!match) throw new Error("Metrics --since must be `all`, `<hours>h`, or `<days>d`");
  const unitMs = match[2] === "h" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return Date.now() - Number(match[1]) * unitMs;
}

function metricsCutoff(root, since) {
  let cutoff = 0;
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(stateDir(root), "metrics-reset.json"), "utf8"));
    cutoff = dateValue(marker.resetAt);
  } catch {}
  if (!since || since === "all") return cutoff;
  const match = /^(\d+)(h|d)$/.exec(String(since));
  if (!match) throw new Error("Metrics --since must be `all`, `<hours>h`, or `<days>d`");
  const unitMs = match[2] === "h" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return Math.max(cutoff, Date.now() - Number(match[1]) * unitMs);
}

function afterCutoff(value, cutoff) {
  return cutoff === 0 || dateValue(value) >= cutoff;
}

function dateValue(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundOne(value) {
  return Math.round(value * 10) / 10;
}

function sum(values) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}

function dashboardSnapshotFile(root, options) {
  const home = path.resolve(options.homeDir || options.home || os.homedir());
  const id = crypto.createHash("sha256").update(path.resolve(root)).digest("hex");
  return path.join(home, ".agentshell", "dashboard-snapshots", `${id}.json`);
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}
