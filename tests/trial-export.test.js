import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { exportTrial } from "../src/commands/trial-export.js";

test("trial export writes a redacted collector-ready evidence bundle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-trial-export-"));
  const state = path.join(root, ".agentshell");
  const out = path.join(root, "shared", "trial.json");
  const now = Date.now();
  const startedAt = new Date(now - 2_000).toISOString();
  const firstFinishedAt = new Date(now - 1_800).toISOString();
  const verificationAt = new Date(now - 1_000).toISOString();
  const finishedAt = new Date(now - 800).toISOString();
  fs.mkdirSync(state, { recursive: true });

  const events = [
    {
      command: "start",
      args: ["start", "--compact"],
      ok: true,
      outputChars: 120,
      estimatedTokens: 30,
      durationMs: 40,
      createdAt: firstFinishedAt
    },
    {
      command: "fix",
      args: ["fix", "test", "--fast", "--compact", root, "secret query"],
      ok: true,
      outputChars: 280,
      estimatedTokens: 70,
      durationMs: 300,
      createdAt: finishedAt
    }
  ];
  fs.writeFileSync(path.join(state, "events.jsonl"), `${events.map(JSON.stringify).join("\n")}\n`);
  fs.writeFileSync(path.join(state, "history.jsonl"), `${JSON.stringify({
    type: "verify",
    rawOutputChars: 4000,
    createdAt: verificationAt
  })}\n`);
  fs.writeFileSync(path.join(state, "active-run.json"), JSON.stringify({
    id: "run_test",
    status: "passed",
    startedAt,
    updatedAt: finishedAt,
    nodes: [
      { type: "diagnose", verificationOk: false, durationMs: 120 },
      { type: "verify", ok: true, durationMs: 180, summary: `passed in ${root}` }
    ],
    commandStats: events.slice(1)
  }));

  const result = await exportTrial(root, {
    out,
    id: "Beta User 1",
    fixture: "Private Node App",
    rating: 5
  });
  const bundle = JSON.parse(fs.readFileSync(out, "utf8"));
  const serialized = JSON.stringify(bundle);

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.trial-export.v1");
  assert.equal(result.summary.evidenceReady, true);
  assert.equal(bundle.host, "codex");
  assert.equal(bundle.id, "beta-user-1");
  assert.equal(bundle.fixture, "private-node-app");
  assert.equal(bundle.events.length, 2);
  assert.equal(bundle.events[0].command, "agentshell start --compact");
  assert.equal(bundle.events[1].command, "agentshell fix test --fast --compact <redacted> <redacted>");
  assert.equal(bundle.finalVerification.ok, true);
  assert.equal(bundle.evidenceMetadata.userFeedback.rating, 5);
  assert.equal(bundle.evidenceMetadata.captureScope.codexModelTokens, false);
  assert.equal(bundle.evidenceMetadata.measurement.agentShellEstimatedTokens, 100);
  assert.equal(bundle.evidenceMetadata.measurement.rawVerifyEstimatedTokens, 1000);
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes(os.userInfo().username), false);
  assert.equal(serialized.includes("secret query"), false);
  assert.equal(Object.hasOwn(bundle.events[0], "stdout"), false);

  const collected = spawnSync("node", ["scripts/codex-plugin-trial-collect.js", "--input", out], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(collected.status, 0, collected.stderr);
  const report = JSON.parse(collected.stdout);
  assert.equal(report.evidence.status, "complete");
  assert.equal(report.compactReport.runs, 1);
  assert.equal(report.compactReport.successRate, 100);
  assert.equal(report.summary.totalOutputTokens, 100);
  assert.equal(report.trials[0].score, 75);
  assert.equal(report.trials[0].interpretation, "usable");
  assert.equal(report.trials[0].observability.noiseControl, "unobserved");
});

test("trial export CLI validates the optional rating", () => {
  const result = spawnSync("node", ["src/cli.js", "trial", "export", "--rating", "6"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(result.status, 2);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.match(output.error.message, /1 to 5/);
});

test("trial export refuses to create an unverified or stale evidence file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-trial-empty-"));
  const out = path.join(root, "trial.json");
  const result = await exportTrial(root, { out });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "TRIAL_NOT_READY");
  assert.equal(fs.existsSync(out), false);
  assert.ok(result.error.suggestedNextActions.some((item) => item.command === "agentshell fix test --fast --compact"));
});

test("trial export schema is exposed through the CLI registry", () => {
  const result = spawnSync("node", ["src/cli.js", "schema", "get", "trial-export"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const schema = JSON.parse(result.stdout);
  assert.equal(schema.properties.protocolVersion.const, "agentshell.trial-export.v1");
  assert.equal(schema.properties.privacy.properties.redacted.const, true);
});
