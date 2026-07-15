import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SNAPSHOT_VERSION = 1;
const FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_QUARANTINE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TEMP_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SNAPSHOTS = 1024;

export function writeDashboardSnapshot(root, report, options = {}) {
  if (report?.protocolVersion !== "agentshell.metrics.v2" || report.scope !== "workspace") {
    throw new Error("Dashboard snapshots require workspace metrics v2");
  }
  const directory = snapshotDirectory(options);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${workspaceId(root)}.json`);
  const snapshot = {
    version: SNAPSHOT_VERSION,
    updatedAt: new Date(options.now ?? Date.now()).toISOString(),
    report: sanitizeReport(report)
  };
  writeJsonAtomic(file, snapshot);
  return file;
}

export function readGlobalDashboardSnapshot(options = {}) {
  return readDashboardSnapshotAggregate(options).report;
}

export function readDashboardSnapshotAggregate(options = {}) {
  const directory = snapshotDirectory(options);
  const now = options.now ?? Date.now();
  const policy = snapshotPolicy(options);
  const diagnostics = emptyDiagnostics(policy);
  let entries = [];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch {}
  cleanupTemporaryFiles(directory, entries, now, policy, diagnostics);
  cleanupQuarantine(directory, now, policy, diagnostics);
  const snapshots = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    diagnostics.discovered += 1;
    const file = path.join(directory, entry.name);
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!validSnapshot(value)) {
        quarantineSnapshot(file, directory, now, diagnostics);
        continue;
      }
      const updatedMs = dateValue(value.updatedAt);
      if (now - updatedMs > policy.retentionMs) {
        removeFile(file, diagnostics, "retired");
        diagnostics.ignored += 1;
        continue;
      }
      snapshots.push({ file, value, updatedMs });
    } catch (error) {
      if (error?.code !== "ENOENT") quarantineSnapshot(file, directory, now, diagnostics);
      else diagnostics.ignored += 1;
    }
  }

  snapshots.sort((a, b) => b.updatedMs - a.updatedMs);
  for (const snapshot of snapshots.splice(policy.maxSnapshots)) {
    removeFile(snapshot.file, diagnostics, "pruned");
    diagnostics.ignored += 1;
  }
  for (const snapshot of snapshots) {
    if (now - snapshot.updatedMs > policy.freshnessWindowMs) diagnostics.stale += 1;
    else diagnostics.refreshed += 1;
  }
  diagnostics.retained = snapshots.length;
  return {
    report: mergeSnapshots(snapshots.map((snapshot) => snapshot.value), now),
    diagnostics
  };
}

export function mergeSnapshots(snapshots, now = Date.now()) {
  const reports = snapshots.map((snapshot) => snapshot.report);
  const dashboards = reports.map((report) => report.dashboard);
  const totals = sumObjects(reports.map((report) => report.totals));
  const dashboardTotals = sumDashboardTotals(dashboards.map((dashboard) => dashboard.totals));
  const coverage = sumCoverage(dashboards.map((dashboard) => dashboard.coverage));
  dashboardTotals.successRate = coverage.evaluatedManagedRuns > 0
    ? Math.round((dashboardTotals.passed / coverage.evaluatedManagedRuns) * 100)
    : null;
  const latestMs = Math.max(0, ...snapshots.map((snapshot) => dateValue(snapshot.updatedAt)));
  const freshness = latestMs === 0 ? emptyFreshness() : {
    status: now - latestMs > FRESHNESS_WINDOW_MS ? "stale" : "fresh",
    latestAt: new Date(latestMs).toISOString(),
    ageMs: Math.max(0, now - latestMs),
    staleAfterMs: FRESHNESS_WINDOW_MS
  };
  const trend = dashboards.flatMap((dashboard) => dashboard.trend || [])
    .sort((a, b) => dateValue(a.finishedAt) - dateValue(b.finishedAt))
    .slice(-12);
  const latestTask = dashboards.map((dashboard) => dashboard.latestTask).filter(Boolean)
    .sort((a, b) => dateValue(a.finishedAt) - dateValue(b.finishedAt)).at(-1) || null;
  const topCommands = mergeTopCommands(reports);
  const savedChars = reports.reduce((sum, report) => sum + (report.savings?.charsSavedVsRawVerify || 0), 0);
  const verifiedChars = totals.verifyRawOutputChars || 0;
  const exactEvents = coverage.exactAttributedEvents;
  const legacyEvents = Math.max(0, coverage.attributableEvents - exactEvents);

  return {
    ok: true,
    protocolVersion: "agentshell.metrics.v2",
    compact: true,
    scope: "global",
    workspaceCount: reports.length,
    window: {
      events: coverage.observedToolCalls,
      limit: 500,
      since: "all",
      cutoff: null
    },
    totals,
    savings: verifiedChars > 0 ? {
      charsSavedVsRawVerify: savedChars,
      percentSavedVsRawVerify: Math.round((savedChars / verifiedChars) * 100)
    } : null,
    topCommands,
    latestRun: null,
    measurement: {
      scope: "agentshell-local-tooling",
      measured: ["commandCount", "commandExecutionMs", "workflowElapsedMs", "verificationStatus"],
      estimated: ["agentShellOutputTokens", "rawVerifyTokens", "contextAvoidedTokens"],
      unavailable: ["codexModelTokens", "codexThinkingTimeMs", "nonAgentShellCommandTelemetry"],
      attribution: {
        exactEvents,
        legacyEvents,
        method: legacyEvents > 0 ? "operation-id-with-legacy-fallback" : "operation-id"
      },
      freshness,
      coverage
    },
    dashboard: {
      generatedAt: new Date(now).toISOString(),
      workspace: { name: "All workspaces" },
      health: latestTask ? (latestTask.status === "passed" ? "ready" : "attention") : "idle",
      freshness,
      coverage,
      totals: dashboardTotals,
      latestTask,
      trend
    },
    privacy: {
      storage: "local-machine-registry",
      networkUpload: false,
      includesFileContents: false,
      includesCommandOutput: false,
      workspacePathsExposed: false
    }
  };
}

function sanitizeReport(report) {
  return {
    ok: true,
    protocolVersion: report.protocolVersion,
    compact: true,
    scope: "workspace",
    workspaceCount: 1,
    window: report.window,
    totals: report.totals,
    savings: report.savings,
    topCommands: report.topCommands || [],
    latestRun: null,
    measurement: report.measurement,
    dashboard: report.dashboard,
    privacy: report.privacy
  };
}

function sumObjects(values) {
  return {
    agentShellOutputChars: sum(values, "agentShellOutputChars"),
    agentShellEstimatedTokens: sum(values, "agentShellEstimatedTokens"),
    verifyRawOutputChars: sum(values, "verifyRawOutputChars"),
    verifyRawEstimatedTokens: sum(values, "verifyRawEstimatedTokens")
  };
}

function sumDashboardTotals(values) {
  const tasks = sum(values, "tasks");
  const passed = sum(values, "passed");
  const estimatedContext = nullableSum(values, "estimatedContextAvoidedTokens");
  const estimatedTime = nullableSum(values, "estimatedTimeSavedMs");
  const commandCount = sum(values, "commandCount");
  const rawVerifyTokens = sum(values, "rawVerifyTokens");
  return {
    tasks,
    managedRuns: sum(values, "managedRuns"),
    operations: sum(values, "operations"),
    toolCalls: sum(values, "toolCalls"),
    passed,
    successRate: null,
    commandCount,
    averageCommandsPerTask: tasks > 0 ? Math.round((commandCount / tasks) * 10) / 10 : null,
    agentShellOutputTokens: sum(values, "agentShellOutputTokens"),
    rawVerifyTokens,
    estimatedContextAvoidedTokens: estimatedContext,
    contextAvoidedPercent: estimatedContext === null || rawVerifyTokens === 0
      ? null
      : Math.round((estimatedContext / rawVerifyTokens) * 100),
    executionMs: sum(values, "executionMs"),
    workflowElapsedMs: sum(values, "workflowElapsedMs"),
    estimatedTimeSavedMs: estimatedTime
  };
}

function sumCoverage(values) {
  const attributableEvents = sum(values, "attributableEvents");
  const exactAttributedEvents = sum(values, "exactAttributedEvents");
  return {
    observedToolCalls: sum(values, "observedToolCalls"),
    managedRuns: sum(values, "managedRuns"),
    evaluatedManagedRuns: sum(values, "evaluatedManagedRuns"),
    activeManagedRuns: sum(values, "activeManagedRuns"),
    staleManagedRuns: sum(values, "staleManagedRuns"),
    attributableEvents,
    exactAttributedEvents,
    exactAttributionPercent: attributableEvents > 0
      ? Math.round((exactAttributedEvents / attributableEvents) * 100)
      : null,
    verifiedTokenSavingsAvailable: values.some((value) => value?.verifiedTokenSavingsAvailable === true),
    verifiedTimeSavingsAvailable: values.some((value) => value?.verifiedTimeSavingsAvailable === true)
  };
}

function mergeTopCommands(reports) {
  const commands = new Map();
  for (const item of reports.flatMap((report) => report.topCommands || [])) {
    const current = commands.get(item.command) || { command: item.command, count: 0, outputChars: 0, estimatedTokens: 0 };
    current.count += item.count || 0;
    current.outputChars += item.outputChars || 0;
    current.estimatedTokens += item.estimatedTokens || 0;
    commands.set(item.command, current);
  }
  return [...commands.values()].sort((a, b) => b.count - a.count || b.outputChars - a.outputChars).slice(0, 5);
}

function nullableSum(values, key) {
  const available = values.map((value) => value?.[key]).filter((value) => Number.isFinite(value));
  return available.length > 0 ? available.reduce((total, value) => total + value, 0) : null;
}

function sum(values, key) {
  return values.reduce((total, value) => total + (Number(value?.[key]) || 0), 0);
}

function emptyFreshness() {
  return { status: "empty", latestAt: null, ageMs: null, staleAfterMs: FRESHNESS_WINDOW_MS };
}

function snapshotPolicy(options) {
  return {
    freshnessWindowMs: positiveNumber(options.freshnessWindowMs, FRESHNESS_WINDOW_MS),
    retentionMs: positiveNumber(options.retentionMs, DEFAULT_RETENTION_MS),
    quarantineRetentionMs: positiveNumber(options.quarantineRetentionMs, DEFAULT_QUARANTINE_RETENTION_MS),
    tempRetentionMs: positiveNumber(options.tempRetentionMs, DEFAULT_TEMP_RETENTION_MS),
    maxSnapshots: positiveInteger(options.maxSnapshots, DEFAULT_MAX_SNAPSHOTS)
  };
}

function emptyDiagnostics(policy) {
  return {
    discovered: 0,
    refreshed: 0,
    stale: 0,
    ignored: 0,
    retained: 0,
    quarantined: 0,
    retired: 0,
    pruned: 0,
    cleanedTemporary: 0,
    cleanedQuarantine: 0,
    freshnessWindowMs: policy.freshnessWindowMs,
    retentionMs: policy.retentionMs,
    maxSnapshots: policy.maxSnapshots
  };
}

function validSnapshot(value) {
  return value?.version === SNAPSHOT_VERSION
    && dateValue(value.updatedAt) > 0
    && value?.report?.protocolVersion === "agentshell.metrics.v2"
    && value.report.scope === "workspace"
    && value.report.dashboard
    && value.report.totals;
}

function quarantineSnapshot(file, directory, now, diagnostics) {
  diagnostics.ignored += 1;
  const quarantine = path.join(directory, ".quarantine");
  try {
    fs.mkdirSync(quarantine, { recursive: true, mode: 0o700 });
    const target = path.join(quarantine, `${path.basename(file)}.${now}.${crypto.randomUUID()}.bad`);
    fs.renameSync(file, target);
    diagnostics.quarantined += 1;
  } catch (error) {
    if (error?.code !== "ENOENT") return;
  }
}

function cleanupTemporaryFiles(directory, entries, now, policy, diagnostics) {
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".tmp")) continue;
    const file = path.join(directory, entry.name);
    try {
      const ageMs = now - fs.statSync(file).mtimeMs;
      if (ageMs <= policy.tempRetentionMs) continue;
      fs.unlinkSync(file);
      diagnostics.cleanedTemporary += 1;
    } catch {}
  }
}

function cleanupQuarantine(directory, now, policy, diagnostics) {
  const quarantine = path.join(directory, ".quarantine");
  let entries = [];
  try { entries = fs.readdirSync(quarantine, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(quarantine, entry.name);
    try {
      if (now - fs.statSync(file).mtimeMs <= policy.quarantineRetentionMs) continue;
      fs.unlinkSync(file);
      diagnostics.cleanedQuarantine += 1;
    } catch {}
  }
}

function removeFile(file, diagnostics, key) {
  try {
    fs.unlinkSync(file);
    diagnostics[key] += 1;
  } catch {}
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function snapshotDirectory(options) {
  const home = path.resolve(options.homeDir || options.home || os.homedir());
  return path.join(home, ".agentshell", "dashboard-snapshots");
}

function workspaceId(root) {
  return crypto.createHash("sha256").update(path.resolve(root)).digest("hex");
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function dateValue(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}
