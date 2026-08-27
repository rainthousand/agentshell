import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { metrics, resetMetrics } from "../src/commands/metrics.js";
import { registerWorkspace } from "../src/core/workspace-registry.js";

test("global metrics aggregate registered workspaces without leaking their paths", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-metrics-home-"));
  const first = fixtureWorkspace("first-project", {
    eventChars: 400,
    rawChars: 4000,
    command: "verify",
    updatedOffsetMs: -2000
  });
  const second = fixtureWorkspace("second-project", {
    eventChars: 200,
    rawChars: 2000,
    command: "fix",
    updatedOffsetMs: -500
  });
  registerWorkspace(first, { homeDir });
  registerWorkspace(second, { homeDir });

  const report = await metrics(first, { scope: "global", compact: false, homeDir });

  assert.equal(report.scope, "global");
  assert.equal(report.workspaceCount, 2);
  assert.equal(report.window.events, 2);
  assert.equal(report.totals.agentShellOutputChars, 600);
  assert.equal(report.totals.verifyRawOutputChars, 6000);
  assert.equal(report.savings.charsSavedVsRawVerify, 5400);
  assert.equal(report.savings.percentSavedVsRawVerify, 90);
  assert.deepEqual(report.tokenAccounting.rawCommandBaseline, {
    availability: "available",
    scope: "attributed-verification-output",
    outputChars: 6000,
    estimatedTokens: 1500,
    workspaceCount: 2,
    availableWorkspaceCount: 2
  });
  assert.equal(report.tokenAccounting.agentShellActualOutput.outputChars, 600);
  assert.equal(report.tokenAccounting.verifiedContextSaved.estimatedTokens, 1350);
  assert.equal(report.tokenAccounting.modelTokens.availability, "unavailable");
  assert.equal(report.measurement.attribution.exactEvents, 2);
  assert.equal(report.measurement.freshness.status, "fresh");
  assert.equal(report.measurement.coverage.observedToolCalls, 2);
  assert.equal(report.measurement.coverage.agentShellCommandHits, 2);
  assert.equal(report.measurement.coverage.externalCommandCount, null);
  assert.equal(report.measurement.coverage.fallbackCommandCount, null);
  assert.equal(report.measurement.coverage.commandCoveragePercent, null);
  assert.equal(report.measurement.coverage.fallbackRatePercent, null);
  assert.equal(report.measurement.coverage.externalCommandTelemetryAvailable, false);
  assert.equal(report.measurement.coverage.managedRuns, 2);
  assert.equal(report.measurement.coverage.exactAttributionPercent, 100);
  assert.equal(report.dashboard.workspace.name, "All workspaces");
  assert.equal(report.dashboard.totals.tasks, 2);
  assert.equal(report.dashboard.totals.operations, 2);
  assert.equal(report.dashboard.totals.toolCalls, 2);
  assert.equal(report.dashboard.totals.rawVerifyTokens, 1500);
  assert.equal(report.dashboard.totals.estimatedContextAvoidedTokens, 1350);
  assert.equal(report.dashboard.verifiedSavings.last7Days.length, 7);
  assert.equal(report.dashboard.verifiedSavings.today.date, localDateKey(Date.now()));
  assert.equal(report.dashboard.verifiedSavings.allTime.contextTokens, 850);
  assert.equal(report.dashboard.verifiedSavings.methodology.deduplication, "operation-id");
  assert.equal(report.dashboard.latestTask.id, "run_second-project");
  assert.deepEqual(report.dashboard.trend.map((entry) => entry.id), [
    "run_first-project",
    "run_second-project"
  ]);
  assert.equal(report.byCommand.verify.count, 1);
  assert.equal(report.byCommand.fix.count, 1);
  assert.equal(report.privacy.storage, "local-machine-registry");
  assert.equal(report.privacy.workspacePathsExposed, false);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(escapeRegExp(first)));
  assert.doesNotMatch(JSON.stringify(report), new RegExp(escapeRegExp(second)));
  assert.ok(report.recentEvents.some((event) => event.args.includes("<workspace>/target.js")));
});

test("workspace metrics remain the default and ignore the global registry", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-metrics-home-"));
  const first = fixtureWorkspace("workspace-only", {
    eventChars: 320,
    rawChars: 3200,
    command: "verify",
    updatedOffsetMs: -500
  });
  const second = fixtureWorkspace("registered-other", {
    eventChars: 800,
    rawChars: 8000,
    command: "fix",
    updatedOffsetMs: -200
  });
  registerWorkspace(second, { homeDir });

  const report = await metrics(first, { compact: true, homeDir });

  assert.equal(report.scope, "workspace");
  assert.equal(report.workspaceCount, 1);
  assert.equal(report.window.events, 1);
  assert.equal(report.totals.agentShellOutputChars, 320);
  assert.equal(report.dashboard.workspace.name, "workspace-only");
  assert.equal(report.dashboard.totals.tasks, 1);
  assert.equal(report.privacy.storage, "local-workspace-only");
  assert.equal(report.privacy.workspacePathsExposed, false);
  assert.deepEqual(report.topCommands.map((entry) => entry.command), ["verify"]);
  assert.equal(report.outputBudget.maxSerializedChars, 8192);
  assert.equal(report.outputBudget.serializedChars, JSON.stringify(report, null, 2).length);
  assert.ok(report.outputBudget.serializedChars <= report.outputBudget.maxSerializedChars);
});

test("verified savings exclude legacy fallback attribution while backward totals stay available", async () => {
  const root = fixtureWorkspace("legacy-attribution", {
    eventChars: 400,
    rawChars: 4000,
    command: "verify",
    updatedOffsetMs: -100,
    exactAttribution: false
  });

  const report = await metrics(root, { compact: true });

  assert.equal(report.totals.verifyRawOutputChars, 4000);
  assert.equal(report.savings.charsSavedVsRawVerify, 3600);
  assert.equal(report.measurement.attribution.legacyEvents, 1);
  assert.equal(report.tokenAccounting.rawCommandBaseline.availability, "unavailable");
  assert.equal(report.tokenAccounting.verifiedContextSaved.estimatedTokens, null);
  assert.equal(report.dashboard.coverage.verifiedTokenSavingsAvailable, false);
});

test("compact metrics enforce a serialized output budget for oversized run metadata", async () => {
  const root = fixtureWorkspace("oversized-metadata", {
    eventChars: 100,
    rawChars: 1000,
    command: `verify-${"c".repeat(500)}`,
    updatedOffsetMs: -100
  });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x".repeat(1000) }));
  const state = path.join(root, ".agentshell");
  const run = JSON.parse(fs.readFileSync(path.join(state, "active-run.json"), "utf8"));
  run.id = `run_${"r".repeat(1000)}`;
  run.nodes.push({
    type: "change",
    ok: true,
    changedFiles: Array.from({ length: 100 }, (_, index) => `${"deep/".repeat(80)}file-${index}.js`),
    createdAt: run.updatedAt
  }, {
    type: "verify",
    ok: false,
    logRef: `log_${"l".repeat(1000)}`,
    summary: { mainError: "failure ".repeat(1000), failedTests: 1 },
    createdAt: run.updatedAt
  });
  fs.writeFileSync(path.join(state, "active-run.json"), `${JSON.stringify(run)}\n`);

  const report = await metrics(root, { compact: true });
  const serialized = JSON.stringify(report, null, 2);

  assert.equal(report.outputBudget.serializedChars, serialized.length);
  assert.ok(serialized.length <= 8192, `compact metrics emitted ${serialized.length} chars`);
  assert.ok(report.topCommands.length <= 3);
  assert.ok(report.dashboard.trend.length <= 3);
  assert.ok((report.latestRun?.latestChange?.changedFiles.length || 0) <= 3);
});

test("metrics reset immediately invalidates the workspace dashboard snapshot", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-reset-home-"));
  const root = fixtureWorkspace("reset-snapshot", {
    eventChars: 100,
    rawChars: 1000,
    command: "verify",
    updatedOffsetMs: -100
  });
  const directory = path.join(homeDir, ".agentshell", "dashboard-snapshots");
  const id = crypto.createHash("sha256").update(path.resolve(root)).digest("hex");
  const snapshot = path.join(directory, `${id}.json`);
  const unrelated = path.join(directory, "unrelated.json");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(snapshot, "{}\n");
  fs.writeFileSync(unrelated, "{}\n");

  const result = resetMetrics(root, { homeDir });

  assert.equal(result.dashboardSnapshot, "invalidated");
  assert.equal(fs.existsSync(snapshot), false);
  assert.equal(fs.existsSync(unrelated), true);
  assert.equal(fs.statSync(path.join(root, ".agentshell", "metrics-reset.json")).mode & 0o777, 0o600);
});

test("time savings use a median miss baseline instead of the latest outlier", async () => {
  const root = fixtureWorkspace("robust-time", {
    eventChars: 100,
    rawChars: 1000,
    command: "verify",
    updatedOffsetMs: -100
  });
  const history = path.join(root, ".agentshell", "history.jsonl");
  const base = Date.now() - 1000;
  const operations = [100, 100, 10_000].map((durationMs, index) => ({
    id: `miss-${index}`,
    type: "verify",
    ok: true,
    cacheKey: "same-test",
    cacheHit: false,
    rawOutputChars: 1000,
    durationMs,
    createdAt: new Date(base + index).toISOString()
  }));
  operations.push({
    id: "hit",
    type: "verify",
    ok: true,
    cacheKey: "same-test",
    cacheHit: true,
    rawOutputChars: 1000,
    durationMs: 10,
    createdAt: new Date(base + 4).toISOString()
  });
  fs.writeFileSync(history, `${operations.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  const report = await metrics(root, { compact: true });

  assert.equal(report.dashboard.totals.estimatedTimeSavedMs, 90);
  assert.equal(report.dashboard.verifiedSavings.allTime.timeMs, 90);
  assert.equal(report.dashboard.verifiedSavings.methodology.time, "robust-estimated-cache-hit-median-baseline");
  assert.equal(report.measurement.estimation.timeSavings.robust, true);
});

test("empty metrics expose unavailable evidence instead of verified zero values", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-empty-metrics-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "empty-metrics" }));

  const report = await metrics(root, { compact: true });

  assert.equal(report.tokenAccounting.agentShellActualOutput.availability, "unavailable");
  assert.equal(report.tokenAccounting.agentShellActualOutput.outputChars, null);
  assert.equal(report.tokenAccounting.verifiedContextSaved.availability, "unavailable");
  assert.equal(report.dashboard.totals.agentShellEstimatedContextTokens, null);
  assert.equal(report.dashboard.totals.rawVerifyEstimatedContextTokens, null);
  assert.equal(report.dashboard.totals.estimatedTimeSavedMs, null);
  assert.equal(report.dashboard.verifiedSavings.availability.contextTokens, false);
  assert.equal(report.dashboard.verifiedSavings.availability.time, false);
  assert.equal(report.measurement.estimation.contextTokens.availability, "unavailable");
});

function fixtureWorkspace(name, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  const state = path.join(root, ".agentshell");
  const updatedAt = new Date(Date.now() + options.updatedOffsetMs).toISOString();
  const startedAt = new Date(Date.parse(updatedAt) - 1000).toISOString();
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name }));
  fs.writeFileSync(path.join(state, "events.jsonl"), `${JSON.stringify({
    command: options.command,
    args: [options.command, `${root}/target.js`],
    ok: true,
    outputChars: options.eventChars,
    estimatedTokens: Math.ceil(options.eventChars / 4),
    operationIds: options.exactAttribution === false ? undefined : ["shared-operation-id"],
    createdAt: updatedAt
  })}\n`);
  fs.writeFileSync(path.join(state, "history.jsonl"), `${JSON.stringify({
    id: "shared-operation-id",
    type: "verify",
    ok: true,
    rawOutputChars: options.rawChars,
    durationMs: 100,
    createdAt: updatedAt
  })}\n`);
  const run = {
    id: `run_${name}`,
    status: "passed",
    startedAt,
    updatedAt,
    nodes: [{
      type: "verify",
      ok: true,
      summary: { mainError: null, failedTests: 0 },
      durationMs: 100,
      createdAt: updatedAt
    }],
    commandStats: [{ outputChars: options.eventChars, createdAt: updatedAt }]
  };
  fs.writeFileSync(path.join(state, "active-run.json"), `${JSON.stringify(run)}\n`);
  fs.writeFileSync(path.join(state, "runs.jsonl"), `${JSON.stringify(run)}\n`);
  return root;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function localDateKey(value) {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(value));
  const part = (type) => parts.find((entry) => entry.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
