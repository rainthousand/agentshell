import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startDashboard } from "../src/commands/dashboard.js";
import { metrics } from "../src/commands/metrics.js";
import { readGlobalDashboardSnapshot, writeDashboardSnapshot } from "../src/core/dashboard-snapshot.js";

test("dashboard snapshots aggregate verified values without retaining workspace paths", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-snapshot-home-"));
  const first = fixtureWorkspace("snapshot-one", 400, 4000, -2000);
  const second = fixtureWorkspace("snapshot-two", 200, 2000, -500);
  writeDashboardSnapshot(first, await metrics(first, { compact: true }), { home });
  writeDashboardSnapshot(second, await metrics(second, { compact: true }), { home });

  const report = readGlobalDashboardSnapshot({ home });
  assert.equal(report.scope, "global");
  assert.equal(report.workspaceCount, 2);
  assert.equal(report.totals.verifyRawOutputChars, 6000);
  assert.equal(report.savings.charsSavedVsRawVerify, 5400);
  assert.equal(report.savings.percentSavedVsRawVerify, 90);
  assert.equal(report.dashboard.totals.estimatedContextAvoidedTokens, 1350);
  assert.equal(report.dashboard.totals.successRate, 100);
  assert.equal(report.dashboard.coverage.evaluatedManagedRuns, 2);
  assert.equal(report.dashboard.latestTask.id, "run_snapshot-two");
  assert.doesNotMatch(JSON.stringify(report), new RegExp(escapeRegExp(first)));
  assert.doesNotMatch(JSON.stringify(report), new RegExp(escapeRegExp(second)));
  const stored = fs.readdirSync(path.join(home, ".agentshell", "dashboard-snapshots"))
    .map((file) => fs.readFileSync(path.join(home, ".agentshell", "dashboard-snapshots", file), "utf8")).join("\n");
  assert.doesNotMatch(stored, new RegExp(escapeRegExp(first)));
  assert.doesNotMatch(stored, new RegExp(escapeRegExp(second)));
});

test("managed dashboard serves snapshots after the source workspace disappears", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-snapshot-home-"));
  const root = fixtureWorkspace("snapshot-offline", 300, 3000, -100);
  writeDashboardSnapshot(root, await metrics(root, { compact: true }), { home });
  fs.rmSync(root, { recursive: true, force: true });

  const session = await startDashboard(process.cwd(), {
    port: 0,
    open: false,
    singleton: false,
    globalService: true,
    home
  });
  try {
    const response = await fetch(new URL("/api/metrics", session.report.url));
    const report = await response.json();
    assert.equal(response.status, 200);
    assert.equal(report.workspaceCount, 1);
    assert.equal(report.dashboard.scope, "global");
    assert.equal(report.dashboard.totals.estimatedContextAvoidedTokens, 675);
  } finally {
    await session.close();
  }
});

test("empty snapshot storage returns an explicit unavailable global report", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-snapshot-empty-"));
  const report = readGlobalDashboardSnapshot({ home });
  assert.equal(report.workspaceCount, 0);
  assert.equal(report.dashboard.freshness.status, "empty");
  assert.equal(report.dashboard.coverage.verifiedTokenSavingsAvailable, false);
  assert.equal(report.dashboard.totals.estimatedContextAvoidedTokens, null);
});

function fixtureWorkspace(name, eventChars, rawChars, updatedOffsetMs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  const state = path.join(root, ".agentshell");
  const updatedAt = new Date(Date.now() + updatedOffsetMs).toISOString();
  const startedAt = new Date(Date.parse(updatedAt) - 1000).toISOString();
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name }));
  fs.writeFileSync(path.join(state, "events.jsonl"), `${JSON.stringify({
    command: "verify", args: ["verify", `${root}/target.js`], ok: true,
    outputChars: eventChars, estimatedTokens: Math.ceil(eventChars / 4),
    operationIds: [`operation_${name}`], createdAt: updatedAt
  })}\n`);
  fs.writeFileSync(path.join(state, "history.jsonl"), `${JSON.stringify({
    id: `operation_${name}`, type: "verify", ok: true, rawOutputChars: rawChars,
    durationMs: 100, createdAt: updatedAt
  })}\n`);
  const run = {
    id: `run_${name}`, status: "passed", startedAt, updatedAt,
    nodes: [{ type: "verify", ok: true, summary: { mainError: null, failedTests: 0 }, durationMs: 100, createdAt: updatedAt }],
    commandStats: [{ outputChars: eventChars, createdAt: updatedAt }]
  };
  fs.writeFileSync(path.join(state, "active-run.json"), `${JSON.stringify(run)}\n`);
  fs.writeFileSync(path.join(state, "runs.jsonl"), `${JSON.stringify(run)}\n`);
  return root;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
