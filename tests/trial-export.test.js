import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { exportTrial, trialStatus } from "../src/commands/trial-export.js";

function writePackage(root, scripts = { test: "node --test" }) {
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "trial-fixture", scripts }));
}

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
  writePackage(root);

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

test("trial export accepts a recent standalone successful verification", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-trial-verify-"));
  const state = path.join(root, ".agentshell");
  const out = path.join(root, "trial.json");
  const createdAt = new Date(Date.now() - 1_000).toISOString();
  fs.mkdirSync(state, { recursive: true });
  writePackage(root);
  fs.writeFileSync(path.join(state, "history.jsonl"), `${JSON.stringify({
    id: "op_verify",
    type: "verify",
    ok: true,
    verificationMode: "full",
    rawEstimatedTokens: 500,
    createdAt
  })}\n`);
  fs.writeFileSync(path.join(state, "events.jsonl"), `${JSON.stringify({
    command: "verify",
    args: ["verify", "test", "--compact"],
    ok: true,
    operationIds: ["op_verify"],
    estimatedTokens: 50,
    durationMs: 200,
    createdAt: new Date(Date.now() - 900).toISOString()
  })}\n`);

  const result = await exportTrial(root, { out, rating: 5 });
  const bundle = JSON.parse(fs.readFileSync(out, "utf8"));

  assert.equal(result.ok, true);
  assert.equal(bundle.events.length, 1);
  assert.equal(bundle.events[0].command, "agentshell verify test --compact");
  assert.equal(bundle.finalVerification.ok, true);
  assert.equal(bundle.evidenceMetadata.measurement.rawVerifyEstimatedTokens, 500);
});

test("trial export refuses to create an unverified or stale evidence file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-trial-empty-"));
  const out = path.join(root, "trial.json");
  writePackage(root);
  const result = await exportTrial(root, { out });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "TRIAL_NOT_READY");
  assert.equal(fs.existsSync(out), false);
  assert.equal(result.error.details.diagnosis, "no-agentshell-events");
  assert.ok(result.error.suggestedNextActions.some((item) => item.command === "agentshell trial export --verify --rating 1-5"));
});

test("trial status distinguishes wrong directory and conservatively suggests one direct child", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-trial-wrong-dir-"));
  const project = path.join(root, "only-project");
  fs.mkdirSync(project);
  writePackage(project);

  const status = trialStatus(root);

  assert.equal(status.status, "wrong-directory");
  assert.equal(status.ready, false);
  assert.equal(status.project.root, null);
  assert.equal(status.project.suggestedRoot, project);

  const second = path.join(root, "second-project");
  fs.mkdirSync(second);
  writePackage(second);
  assert.equal(trialStatus(root).project.suggestedRoot, null);
});

test("trial status treats a package-like home directory without tests as the wrong directory", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-trial-home-"));
  const project = path.join(home, "real-project");
  writePackage(home, {});
  fs.mkdirSync(project);
  writePackage(project);

  const status = trialStatus(home, { home });

  assert.equal(status.status, "wrong-directory");
  assert.equal(status.project.root, null);
  assert.equal(status.project.suggestedRoot, project);
});

test("trial status distinguishes missing test script and missing AgentShell events", () => {
  const noTest = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-trial-no-test-"));
  writePackage(noTest, { build: "node build.js" });
  assert.equal(trialStatus(noTest).status, "no-test-script");

  const noEvents = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-trial-no-events-"));
  writePackage(noEvents);
  const status = trialStatus(noEvents);
  assert.equal(status.status, "no-agentshell-events");
  assert.equal(status.evidence.eventCount, 0);
});

test("trial status distinguishes stale evidence and a recent failed verification", () => {
  const stale = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-trial-stale-"));
  const staleState = path.join(stale, ".agentshell");
  const old = new Date(Date.now() - 7 * 60 * 60 * 1_000).toISOString();
  writePackage(stale);
  fs.mkdirSync(staleState);
  fs.writeFileSync(path.join(staleState, "events.jsonl"), `${JSON.stringify({ command: "verify", createdAt: old })}\n`);
  fs.writeFileSync(path.join(staleState, "history.jsonl"), `${JSON.stringify({ type: "verify", ok: true, createdAt: old })}\n`);
  assert.equal(trialStatus(stale).status, "stale-evidence");

  const failed = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-trial-failed-"));
  const failedState = path.join(failed, ".agentshell");
  const recent = new Date(Date.now() - 1_000).toISOString();
  writePackage(failed);
  fs.mkdirSync(failedState);
  fs.writeFileSync(path.join(failedState, "history.jsonl"), `${JSON.stringify({ type: "verify", ok: false, createdAt: recent })}\n`);
  assert.equal(trialStatus(failed).status, "failed-verification");

  const activeFailure = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-trial-active-failed-"));
  const activeState = path.join(activeFailure, ".agentshell");
  writePackage(activeFailure);
  fs.mkdirSync(activeState);
  fs.writeFileSync(path.join(activeState, "active-run.json"), JSON.stringify({
    id: "run_failed",
    status: "failing",
    startedAt: recent,
    updatedAt: recent,
    nodes: [{ type: "diagnose", verificationOk: false }],
    commandStats: []
  }));
  assert.equal(trialStatus(activeFailure).status, "failed-verification");
});

test("trial export can verify and export through an injected function API", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-trial-self-rescue-"));
  const state = path.join(root, ".agentshell");
  const out = path.join(root, "trial.json");
  writePackage(root);
  fs.mkdirSync(state);

  const result = await exportTrial(root, {
    out,
    verify: true,
    rating: 4,
    verifyFn: async (verifyRoot, type, options) => {
      assert.equal(verifyRoot, root);
      assert.equal(type, "test");
      assert.equal(options.run, true);
      const operation = {
        id: "op_self_rescue",
        type: "verify",
        ok: true,
        verificationMode: "full",
        rawEstimatedTokens: 900,
        durationMs: 25,
        createdAt: new Date().toISOString()
      };
      fs.writeFileSync(path.join(state, "history.jsonl"), `${JSON.stringify(operation)}\n`);
      return { ok: true, operationId: operation.id, durationMs: 25, summary: { failedTests: 0 } };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(trialStatus(root).status, "ready");
  const bundle = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(bundle.events.at(-1).command, "agentshell verify test --compact");
  assert.equal(bundle.evidenceMetadata.userFeedback.rating, 4);
});

test("trial export verify mode reports failed verification without writing evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-trial-verify-failed-"));
  const out = path.join(root, "trial.json");
  writePackage(root);

  const result = await exportTrial(root, {
    out,
    verify: true,
    verifyFn: async () => ({ ok: false, exitCode: 1, summary: { failedTests: 2 }, logRef: "log_failed" })
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "TRIAL_VERIFICATION_FAILED");
  assert.equal(result.error.details.verification.exitCode, 1);
  assert.equal(fs.existsSync(out), false);
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
