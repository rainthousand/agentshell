import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dashboardStatus, startDashboard } from "../src/commands/dashboard.js";
import { exportMetrics, metrics, resetMetrics } from "../src/commands/metrics.js";

test("metrics v2 separates measured, estimated, and unavailable values", async () => {
  const root = fixtureWorkspace();
  const report = await metrics(root, { compact: true });

  assert.equal(report.protocolVersion, "agentshell.metrics.v2");
  assert.equal(report.measurement.scope, "agentshell-local-tooling");
  assert.ok(report.measurement.measured.includes("commandExecutionMs"));
  assert.ok(report.measurement.estimated.includes("contextAvoidedTokens"));
  assert.ok(report.measurement.unavailable.includes("codexModelTokens"));
  assert.equal(report.measurement.attribution.exactEvents, 1);
  assert.equal(report.measurement.attribution.legacyEvents, 0);
  assert.equal(report.measurement.freshness.status, "fresh");
  assert.equal(report.measurement.coverage.observedToolCalls, 1);
  assert.equal(report.measurement.coverage.managedRuns, 1);
  assert.equal(report.measurement.coverage.exactAttributionPercent, 100);
  assert.equal(report.measurement.coverage.verifiedTokenSavingsAvailable, true);
  assert.equal(report.measurement.coverage.verifiedTimeSavingsAvailable, false);
  assert.equal(report.dashboard.workspace.name, "dashboard-fixture");
  assert.equal(report.dashboard.health, "ready");
  assert.equal(report.dashboard.totals.tasks, 1);
  assert.equal(report.dashboard.totals.managedRuns, 1);
  assert.equal(report.dashboard.totals.operations, 1);
  assert.equal(report.dashboard.totals.toolCalls, 1);
  assert.equal(report.dashboard.totals.successRate, 100);
  assert.equal(report.dashboard.totals.agentShellOutputTokens, 100);
  assert.equal(report.dashboard.totals.rawVerifyTokens, 1000);
  assert.equal(report.dashboard.totals.estimatedContextAvoidedTokens, 900);
  assert.equal(report.dashboard.totals.contextAvoidedPercent, 90);
  assert.equal(report.dashboard.totals.executionMs, 350);
  assert.equal(report.dashboard.totals.estimatedTimeSavedMs, null);
  assert.equal(report.dashboard.latestTask.verificationOk, true);
  assert.equal(report.dashboard.latestTask.stale, false);
  assert.equal(report.dashboard.latestTask.lifecycle, "complete");
});

test("metrics reset preserves history while starting a fresh measurement window", async () => {
  const root = fixtureWorkspace();
  const before = await metrics(root, { compact: true });
  assert.equal(before.dashboard.totals.estimatedContextAvoidedTokens, 900);
  const exported = await exportMetrics(root, "evidence/metrics.json");
  assert.equal(exported.ok, true);
  assert.equal(fs.existsSync(exported.output), true);

  const reset = resetMetrics(root);
  assert.equal(reset.preservedHistory, true);
  const after = await metrics(root, { compact: true });
  assert.equal(after.dashboard.totals.operations, 0);
  assert.equal(after.dashboard.totals.toolCalls, 0);
  assert.equal(after.dashboard.totals.estimatedContextAvoidedTokens, null);
  assert.equal(fs.existsSync(path.join(root, ".agentshell", "history.jsonl")), true);
});

test("time saved counts verified cache hits, not ordinary runtime variance", async () => {
  const root = fixtureWorkspace();
  fs.appendFileSync(path.join(root, ".agentshell", "history.jsonl"), `${JSON.stringify({
    id: "op_cached",
    type: "verify",
    ok: false,
    cacheHit: true,
    cacheKey: "fixture-key",
    durationMs: 0,
    rawOutputChars: 4000,
    createdAt: new Date().toISOString()
  })}\n`);
  const historyFile = path.join(root, ".agentshell", "history.jsonl");
  const first = JSON.parse(fs.readFileSync(historyFile, "utf8").split("\n")[0]);
  first.cacheKey = "fixture-key";
  first.cacheHit = false;
  first.durationMs = 350;
  const rest = fs.readFileSync(historyFile, "utf8").split("\n").slice(1).filter(Boolean);
  fs.writeFileSync(historyFile, `${[JSON.stringify(first), ...rest].join("\n")}\n`);
  const report = await metrics(root, { compact: true });
  assert.equal(report.dashboard.totals.estimatedTimeSavedMs, 350);
  assert.equal(report.dashboard.coverage.verifiedTimeSavingsAvailable, true);
});

test("stale unfinished runs remain visible without counting as evaluated failures", async () => {
  const root = fixtureWorkspace();
  const state = path.join(root, ".agentshell");
  const staleAt = new Date(Date.now() - (25 * 60 * 60 * 1000)).toISOString();
  const run = JSON.parse(fs.readFileSync(path.join(state, "active-run.json"), "utf8"));
  run.status = "in_progress";
  run.updatedAt = staleAt;
  run.nodes = run.nodes.slice(0, 2);
  fs.writeFileSync(path.join(state, "active-run.json"), JSON.stringify(run));
  fs.writeFileSync(path.join(state, "runs.jsonl"), `${JSON.stringify(run)}\n`);
  for (const file of ["events.jsonl", "history.jsonl"]) {
    const entry = JSON.parse(fs.readFileSync(path.join(state, file), "utf8"));
    entry.createdAt = staleAt;
    fs.writeFileSync(path.join(state, file), `${JSON.stringify(entry)}\n`);
  }

  const report = await metrics(root, { compact: true });
  assert.equal(report.dashboard.freshness.status, "stale");
  assert.equal(report.dashboard.coverage.activeManagedRuns, 0);
  assert.equal(report.dashboard.coverage.staleManagedRuns, 1);
  assert.equal(report.dashboard.totals.successRate, null);
  assert.equal(report.dashboard.latestTask.stale, true);
  assert.equal(report.dashboard.latestTask.lifecycle, "stale");
});

test("dashboard serves local read-only UI and metrics with security headers", async () => {
  const root = fixtureWorkspace();
  const session = await startDashboard(root, { port: 0, open: false, singleton: false });
  try {
    assert.equal(session.report.protocolVersion, "agentshell.dashboard.v1");
    assert.match(session.report.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(session.report.readOnly, true);
    assert.equal(session.report.reused, false);
    assert.equal(session.report.surface, "none");
    assert.equal(typeof session.report.nativeAppAvailable, "boolean");
    assert.equal(session.report.privacy.networkUpload, false);

    const page = await fetch(session.report.url);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    assert.match(html, /AgentShell Dashboard/);
    assert.match(html, /Verified context saved/);
    assert.match(html, /Verified time saved/);

    const api = await fetch(new URL("/api/metrics", session.report.url));
    const data = await api.json();
    assert.equal(api.status, 200);
    assert.equal(data.protocolVersion, "agentshell.metrics.v2");
    assert.equal(data.dashboard.scope, "global");
    assert.ok(data.dashboard.totals);

    const health = await fetch(new URL("/api/health", session.report.url));
    const healthData = await health.json();
    assert.equal(healthData.protocolVersion, "agentshell.dashboard.v1");
    assert.equal(typeof healthData.instanceId, "string");
    assert.ok(healthData.instanceId.length > 10);

    const projectApi = await fetch(new URL("/api/metrics?scope=workspace", session.report.url));
    const projectData = await projectApi.json();
    assert.equal(projectApi.status, 200);
    assert.equal(projectData.dashboard.scope, "workspace");
    assert.equal(projectData.dashboard.workspace.name, "dashboard-fixture");
    assert.equal(projectData.dashboard.totals.estimatedContextAvoidedTokens, 900);

    const invalidScope = await fetch(new URL("/api/metrics?scope=machine", session.report.url));
    assert.equal(invalidScope.status, 400);
    assert.deepEqual(await invalidScope.json(), {
      ok: false,
      error: "INVALID_SCOPE",
      allowed: ["global", "workspace"]
    });

    const denied = await fetch(new URL("/api/metrics", session.report.url), { method: "POST" });
    assert.equal(denied.status, 405);
  } finally {
    await session.close();
  }
});

test("dashboard reuses one healthy user-level server", async () => {
  const root = fixtureWorkspace();
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-dashboard-runtime-"));
  const first = await startDashboard(root, { port: 0, open: false, runtimeDir, monitorParent: false });
  try {
    const second = await startDashboard(root, { port: 0, open: false, runtimeDir, monitorParent: false });
    assert.equal(second.server, null);
    assert.equal(second.report.reused, true);
    assert.equal(second.report.pid, process.pid);
    assert.equal(second.report.url, first.report.url);
    const status = await dashboardStatus({ runtimeDir });
    assert.equal(status.running, true);
    assert.equal(status.state.port, first.report.port);
    const lock = JSON.parse(fs.readFileSync(path.join(runtimeDir, "dashboard.lock"), "utf8"));
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.instanceId, status.state.instanceId);
  } finally {
    await first.close();
  }
  assert.equal(fs.existsSync(path.join(runtimeDir, "dashboard.lock")), false);
  assert.equal(fs.existsSync(path.join(runtimeDir, "dashboard.json")), false);
});

test("managed global Dashboard is reused from a different project root", async () => {
  const firstRoot = fixtureWorkspace();
  const secondRoot = fixtureWorkspace();
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-dashboard-global-runtime-"));
  const first = await startDashboard(firstRoot, {
    port: 0,
    open: false,
    runtimeDir,
    monitorParent: false,
    globalService: true
  });
  try {
    const second = await startDashboard(secondRoot, {
      port: 0,
      open: false,
      runtimeDir,
      monitorParent: false
    });
    assert.equal(second.report.reused, true);
    assert.equal(second.report.pid, first.report.pid);
    assert.equal(second.report.url, first.report.url);
  } finally {
    await first.close();
  }
});

test("dashboard replaces a dead singleton state when its lock identity matches", async () => {
  const root = fixtureWorkspace();
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-dashboard-dead-runtime-"));
  const dead = { pid: 999999, instanceId: "dead-instance", root, version: "old", url: "http://127.0.0.1:1/" };
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, "dashboard.json"), JSON.stringify(dead));
  fs.writeFileSync(path.join(runtimeDir, "dashboard.lock"), JSON.stringify({ pid: dead.pid, instanceId: dead.instanceId }));

  const session = await startDashboard(root, { port: 0, open: false, runtimeDir, monitorParent: false });
  try {
    assert.equal(session.report.reused, false);
    assert.equal(session.report.pid, process.pid);
  } finally {
    await session.close();
  }
});

function fixtureWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-dashboard-"));
  const state = path.join(root, ".agentshell");
  const now = Date.now();
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "dashboard-fixture" }));
  fs.writeFileSync(path.join(state, "events.jsonl"), `${JSON.stringify({
    command: "fix",
    args: ["fix", "test", "--fast", "--compact"],
    ok: true,
    outputChars: 400,
    estimatedTokens: 100,
    durationMs: 350,
    operationIds: ["op_dashboard"],
    createdAt: new Date(now - 500).toISOString()
  })}\n`);
  fs.writeFileSync(path.join(state, "history.jsonl"), `${JSON.stringify({
    id: "op_dashboard",
    type: "verify",
    ok: true,
    rawOutputChars: 4000,
    rawEstimatedTokens: 1000,
    createdAt: new Date(now - 600).toISOString()
  })}\n`);
  const run = {
    id: "run_dashboard",
    status: "passed",
    startedAt: new Date(now - 2000).toISOString(),
    updatedAt: new Date(now - 500).toISOString(),
    nodes: [
      { type: "diagnose", verificationOk: false, durationMs: 150 },
      { type: "change", ok: true, changedFiles: ["src/user.js"], durationMs: 50 },
      { type: "verify", ok: true, summary: { mainError: null, failedTests: 0 }, durationMs: 150 }
    ],
    commandStats: [{ outputChars: 400 }]
  };
  fs.writeFileSync(path.join(state, "active-run.json"), JSON.stringify(run));
  fs.writeFileSync(path.join(state, "runs.jsonl"), `${JSON.stringify(run)}\n`);
  return root;
}
