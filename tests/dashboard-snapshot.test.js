import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startDashboard } from "../src/commands/dashboard.js";
import { metrics } from "../src/commands/metrics.js";
import {
  readDashboardSnapshotAggregate,
  readGlobalDashboardSnapshot,
  writeDashboardSnapshot
} from "../src/core/dashboard-snapshot.js";

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

test("corrupt snapshots are quarantined and excluded with path-free diagnostics", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-snapshot-corrupt-"));
  const directory = path.join(home, ".agentshell", "dashboard-snapshots");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "broken.json"), "{ definitely not json\n");

  const aggregate = readDashboardSnapshotAggregate({ home });
  assert.equal(aggregate.report.workspaceCount, 0);
  assert.deepEqual(pickLifecycleCounts(aggregate.diagnostics), {
    discovered: 1,
    refreshed: 0,
    stale: 0,
    ignored: 1,
    retained: 0,
    quarantined: 1,
    retired: 0,
    pruned: 0
  });
  assert.equal(fs.existsSync(path.join(directory, "broken.json")), false);
  assert.equal(fs.readdirSync(path.join(directory, ".quarantine")).length, 1);
  assert.doesNotMatch(JSON.stringify(aggregate.diagnostics), new RegExp(escapeRegExp(home)));
});

test("snapshot retention removes expired entries and bounds retained stale snapshots", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-snapshot-retention-"));
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const roots = [
    fixtureWorkspace("snapshot-fresh", 100, 1000, -100),
    fixtureWorkspace("snapshot-stale-new", 100, 1000, -100),
    fixtureWorkspace("snapshot-stale-old", 100, 1000, -100),
    fixtureWorkspace("snapshot-expired", 100, 1000, -100)
  ];
  const ages = [1_000, 2 * day, 3 * day, 100 * day];
  for (let index = 0; index < roots.length; index += 1) {
    writeDashboardSnapshot(roots[index], await metrics(roots[index], { compact: true }), {
      home,
      now: now - ages[index]
    });
  }

  const aggregate = readDashboardSnapshotAggregate({
    home,
    now,
    retentionMs: 90 * day,
    maxSnapshots: 2
  });
  assert.equal(aggregate.report.workspaceCount, 2);
  assert.deepEqual(pickLifecycleCounts(aggregate.diagnostics), {
    discovered: 4,
    refreshed: 1,
    stale: 1,
    ignored: 2,
    retained: 2,
    quarantined: 0,
    retired: 1,
    pruned: 1
  });
  const directory = path.join(home, ".agentshell", "dashboard-snapshots");
  assert.equal(fs.readdirSync(directory).filter((file) => file.endsWith(".json")).length, 2);
});

test("snapshot writes stay atomic and cleanup leaves active temporary files alone", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-snapshot-atomic-"));
  const root = fixtureWorkspace("snapshot-atomic", 100, 1000, -100);
  const report = await metrics(root, { compact: true });
  const directory = path.join(home, ".agentshell", "dashboard-snapshots");
  fs.mkdirSync(directory, { recursive: true });
  const activeTemp = path.join(directory, "active.tmp");
  const oldTemp = path.join(directory, "old.tmp");
  fs.writeFileSync(activeTemp, "in progress");
  fs.writeFileSync(oldTemp, "abandoned");
  const oldTime = new Date(Date.now() - (2 * 24 * 60 * 60 * 1000));
  fs.utimesSync(oldTemp, oldTime, oldTime);

  await Promise.all(Array.from({ length: 12 }, (_, index) => new Promise((resolve) => {
    setImmediate(() => {
      writeDashboardSnapshot(root, report, { home, now: Date.now() + index });
      resolve();
    });
  })));
  const aggregate = readDashboardSnapshotAggregate({ home });
  assert.equal(aggregate.report.workspaceCount, 1);
  assert.equal(aggregate.diagnostics.cleanedTemporary, 1);
  assert.equal(fs.existsSync(activeTemp), true);
  assert.equal(fs.existsSync(oldTemp), false);
  assert.equal(fs.readdirSync(directory).filter((file) => file.includes(".tmp")).length, 1);
});

test("managed Dashboard exposes snapshot lifecycle diagnostics without changing metrics v2 JSON", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-snapshot-health-"));
  const root = fixtureWorkspace("snapshot-health", 100, 1000, -100);
  writeDashboardSnapshot(root, await metrics(root, { compact: true }), { home });
  const directory = path.join(home, ".agentshell", "dashboard-snapshots");
  fs.writeFileSync(path.join(directory, "invalid.json"), "nope");
  const session = await startDashboard(process.cwd(), {
    port: 0,
    open: false,
    singleton: false,
    globalService: true,
    home
  });
  try {
    const health = await fetch(new URL("/api/health", session.report.url));
    const healthReport = await health.json();
    assert.equal(healthReport.snapshotLifecycle.discovered, 2);
    assert.equal(healthReport.snapshotLifecycle.refreshed, 1);
    assert.equal(healthReport.snapshotLifecycle.ignored, 1);

    const metricsResponse = await fetch(new URL("/api/metrics", session.report.url));
    const metricsReport = await metricsResponse.json();
    assert.equal(metricsResponse.headers.get("x-agentshell-snapshots-discovered"), "1");
    assert.equal(metricsResponse.headers.get("x-agentshell-snapshots-refreshed"), "1");
    assert.equal(metricsResponse.headers.get("x-agentshell-snapshots-stale"), "0");
    assert.equal(metricsResponse.headers.get("x-agentshell-snapshots-ignored"), "0");
    assert.equal("snapshotLifecycle" in metricsReport, false);
  } finally {
    await session.close();
  }
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

function pickLifecycleCounts(diagnostics) {
  return {
    discovered: diagnostics.discovered,
    refreshed: diagnostics.refreshed,
    stale: diagnostics.stale,
    ignored: diagnostics.ignored,
    retained: diagnostics.retained,
    quarantined: diagnostics.quarantined,
    retired: diagnostics.retired,
    pruned: diagnostics.pruned
  };
}
