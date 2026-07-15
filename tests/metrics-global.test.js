import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { metrics } from "../src/commands/metrics.js";
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
  assert.equal(report.measurement.attribution.exactEvents, 2);
  assert.equal(report.measurement.freshness.status, "fresh");
  assert.equal(report.measurement.coverage.observedToolCalls, 2);
  assert.equal(report.measurement.coverage.managedRuns, 2);
  assert.equal(report.measurement.coverage.exactAttributionPercent, 100);
  assert.equal(report.dashboard.workspace.name, "All workspaces");
  assert.equal(report.dashboard.totals.tasks, 2);
  assert.equal(report.dashboard.totals.operations, 2);
  assert.equal(report.dashboard.totals.toolCalls, 2);
  assert.equal(report.dashboard.totals.rawVerifyTokens, 1500);
  assert.equal(report.dashboard.totals.estimatedContextAvoidedTokens, 1350);
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
    operationIds: ["shared-operation-id"],
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
