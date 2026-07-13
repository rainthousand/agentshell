import fs from "node:fs";
import path from "node:path";

import { readActiveRun, readEvents, readOperations, readRuns } from "../core/store.js";
import { runStatus, summarizeRun } from "./run-status.js";

const PROTOCOL_VERSION = "agentshell.metrics.v2";

export async function metrics(root, options = {}) {
  const limit = parseLimit(options.limit);
  const compact = Boolean(options.compact);
  const allEvents = readEvents(root);
  const events = allEvents.slice(-limit);
  const operations = readOperations(root);
  const verifyOps = operations.filter((operation) => operation.type === "verify");
  const verifyRawChars = sum(verifyOps.map((operation) => operation.rawOutputChars || 0));
  const outputChars = sum(events.map((event) => event.outputChars || 0));

  const latestRun = await runStatus(root, "status");
  const byCommand = groupByCommand(events);
  const dashboard = dashboardSummary(root, events, operations, allEvents.length);
  const base = {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact,
    window: {
      events: events.length,
      limit
    },
    totals: {
      agentShellOutputChars: outputChars,
      agentShellEstimatedTokens: estimateTokens(outputChars),
      verifyRawOutputChars: verifyRawChars,
      verifyRawEstimatedTokens: estimateTokens(verifyRawChars)
    },
    savings: verifyRawChars > 0 ? {
      charsSavedVsRawVerify: Math.max(0, verifyRawChars - outputChars),
      percentSavedVsRawVerify: Math.max(0, Math.round((1 - outputChars / verifyRawChars) * 100))
    } : null,
    latestRun: latestRun.summary,
    measurement: {
      scope: "agentshell-local-tooling",
      measured: ["commandCount", "commandExecutionMs", "workflowElapsedMs", "verificationStatus"],
      estimated: ["agentShellOutputTokens", "rawVerifyTokens", "contextAvoidedTokens"],
      unavailable: ["codexModelTokens", "codexThinkingTimeMs", "nonAgentShellCommandTelemetry"]
    },
    dashboard,
    privacy: {
      storage: "local-workspace-only",
      networkUpload: false,
      includesFileContents: false,
      includesCommandOutput: false
    }
  };

  if (compact) {
    return {
      ...base,
      topCommands: topCommands(byCommand, 5)
    };
  }

  return {
    ...base,
    byCommand,
    recentEvents: events.slice(-10).reverse()
  };
}

function dashboardSummary(root, events, operations, toolCallCount) {
  const runs = uniqueRuns(root);
  const summaries = runs.map(summarizeRun);
  const passed = summaries.filter((run) => run.status === "passed").length;
  const commandCount = sum(summaries.map((run) => run.commandCount));
  const executionMs = sum(summaries.map((run) => run.durationMs));
  const workflowElapsedMs = sum(runs.map(elapsedMsForRun));
  const estimatedTimeSavedMs = timeSavedFromRepeatedVerification(operations);
  const agentShellOutputTokens = sum(events.map((event) => event.estimatedTokens || estimateTokens(event.outputChars || 0)));
  const compactVerificationTokens = sum(events
    .filter((event) => event.command === "verify" || event.command === "fix")
    .map((event) => event.estimatedTokens || estimateTokens(event.outputChars || 0)));
  const rawVerifyTokens = sum(operations
    .filter((operation) => operation.type === "verify")
    .map((operation) => operation.rawEstimatedTokens || estimateTokens(operation.rawOutputChars || 0)));
  const estimatedContextAvoidedTokens = rawVerifyTokens > 0
    ? Math.max(0, rawVerifyTokens - compactVerificationTokens)
    : null;
  const contextAvoidedPercent = estimatedContextAvoidedTokens === null
    ? null
    : Math.round((estimatedContextAvoidedTokens / rawVerifyTokens) * 100);
  const latest = summaries.at(-1) || null;

  return {
    generatedAt: new Date().toISOString(),
    workspace: {
      name: workspaceName(root)
    },
    health: healthFor(latest, runs.at(-1)),
    totals: {
      tasks: summaries.length,
      managedRuns: summaries.length,
      operations: operations.length,
      toolCalls: toolCallCount,
      passed,
      successRate: summaries.length > 0 ? Math.round((passed / summaries.length) * 100) : null,
      commandCount,
      averageCommandsPerTask: summaries.length > 0 ? roundOne(commandCount / summaries.length) : null,
      agentShellOutputTokens,
      rawVerifyTokens,
      estimatedContextAvoidedTokens,
      contextAvoidedPercent,
      executionMs,
      workflowElapsedMs,
      estimatedTimeSavedMs
    },
    latestTask: latest ? taskForDashboard(latest, runs.at(-1)) : null,
    trend: summaries.slice(-12).map((summary, index) => taskForTrend(summary, runs.slice(-12)[index]))
  };
}

function timeSavedFromRepeatedVerification(operations) {
  const baselines = new Map();
  let saved = 0;
  for (const operation of operations) {
    if (operation.type !== "verify" || !operation.cacheKey) continue;
    if (operation.ok && Number.isFinite(operation.durationMs) && !baselines.has(operation.cacheKey)) {
      baselines.set(operation.cacheKey, operation.durationMs);
      continue;
    }
    const baseline = baselines.get(operation.cacheKey);
    if (operation.ok && Number.isFinite(baseline)) {
      saved += Math.max(0, baseline - (operation.durationMs || 0));
    }
  }
  return baselines.size > 0 ? saved : null;
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
  return {
    id: summary.runId,
    status: summary.status,
    commandCount: summary.commandCount,
    estimatedTokens: summary.estimatedTokens,
    executionMs: summary.durationMs,
    workflowElapsedMs: elapsedMsForRun(run),
    finishedAt: run?.updatedAt || null,
    changedFileCount: summary.latestChange?.changedFiles?.length || 0,
    verificationOk: summary.latestVerify?.ok === true
  };
}

function taskForTrend(summary, run) {
  return {
    id: summary.runId,
    status: summary.status,
    estimatedTokens: summary.estimatedTokens,
    executionMs: summary.durationMs,
    workflowElapsedMs: elapsedMsForRun(run),
    finishedAt: run?.updatedAt || null
  };
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
