import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startDashboard } from "../src/commands/dashboard.js";
import { metrics } from "../src/commands/metrics.js";

test("metrics v2 separates measured, estimated, and unavailable values", async () => {
  const root = fixtureWorkspace();
  const report = await metrics(root, { compact: true });

  assert.equal(report.protocolVersion, "agentshell.metrics.v2");
  assert.equal(report.measurement.scope, "agentshell-local-tooling");
  assert.ok(report.measurement.measured.includes("commandExecutionMs"));
  assert.ok(report.measurement.estimated.includes("contextAvoidedTokens"));
  assert.ok(report.measurement.unavailable.includes("codexModelTokens"));
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
  assert.equal(report.dashboard.latestTask.verificationOk, true);
});

test("dashboard serves local read-only UI and metrics with security headers", async () => {
  const root = fixtureWorkspace();
  const session = await startDashboard(root, { port: 0, open: false });
  try {
    assert.equal(session.report.protocolVersion, "agentshell.dashboard.v1");
    assert.match(session.report.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(session.report.readOnly, true);
    assert.equal(session.report.surface, "none");
    assert.equal(typeof session.report.nativeAppAvailable, "boolean");
    assert.equal(session.report.privacy.networkUpload, false);

    const page = await fetch(session.report.url);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    assert.match(html, /AgentShell Dashboard/);
    assert.match(html, /Tokens saved/);
    assert.match(html, /Time saved/);

    const api = await fetch(new URL("/api/metrics", session.report.url));
    const data = await api.json();
    assert.equal(api.status, 200);
    assert.equal(data.protocolVersion, "agentshell.metrics.v2");
    assert.equal(data.dashboard.totals.estimatedContextAvoidedTokens, 900);

    const denied = await fetch(new URL("/api/metrics", session.report.url), { method: "POST" });
    assert.equal(denied.status, 405);
  } finally {
    await new Promise((resolve) => session.server.close(resolve));
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
    createdAt: new Date(now - 500).toISOString()
  })}\n`);
  fs.writeFileSync(path.join(state, "history.jsonl"), `${JSON.stringify({
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
