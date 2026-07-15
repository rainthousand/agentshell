import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cli = path.resolve("src/cli.js");

test("run status tracks diagnose, change fill apply, and verify", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-run-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "run-demo",
    type: "module",
    scripts: {
      test: "node test/user.test.js"
    }
  }, null, 2));
  fs.writeFileSync(path.join(dir, "src", "user.js"), [
    "export function createUser(input) {",
    "  return {",
    "    name: input.name,",
    "    email: input.email",
    "  };",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "test", "user.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { createUser } from '../src/user.js';",
    "const user = createUser({ name: 'Ada', email: 'ada@example.com' });",
    "assert.ok(user.id, 'Expected user.id to be present');",
    ""
  ].join("\n"));

  const idleNext = run(dir, ["run", "next"]);
  assert.equal(idleNext.status, 0);
  const idleNextOutput = JSON.parse(idleNext.stdout);
  assert.equal(idleNextOutput.protocolVersion, "agentshell.run-next.v1");
  assert.equal(idleNextOutput.status, "idle");
  assert.equal(idleNextOutput.command, "agentshell diagnose test --compact");

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);
  const diagnosisOutput = JSON.parse(diagnosis.stdout);
  assert.match(diagnosisOutput.runId, /^run_/);

  const diagnosisNext = run(dir, ["run", "next"]);
  assert.equal(diagnosisNext.status, 0);
  const diagnosisNextOutput = JSON.parse(diagnosisNext.stdout);
  assert.equal(diagnosisNextOutput.protocolVersion, "agentshell.run-next.v1");
  assert.equal(diagnosisNextOutput.runId, diagnosisOutput.runId);
  assert.equal(diagnosisNextOutput.status, "failing");
  assert.match(diagnosisNextOutput.command, /^agentshell change fill /);
  assert.match(diagnosisNextOutput.reason, /src\/user\.js/);

  const suggested = run(dir, ["change", "suggest", "--apply", "--compact"]);
  assert.equal(suggested.status, 0);
  const suggestedOutput = JSON.parse(suggested.stdout);
  assert.equal(suggestedOutput.compact, true);
  assert.equal(suggestedOutput.runId, diagnosisOutput.runId);
  assert.equal(suggestedOutput.template, diagnosisOutput.changeTemplate.path);
  assert.match(suggestedOutput.fill, /\.agentshell\/change-templates\/fill_/);
  assert.equal(Object.hasOwn(suggestedOutput, "replacement"), false);
  assert.deepEqual(suggestedOutput.applied.changedFiles, ["src/user.js"]);

  const verify = run(dir, ["verify", "test"]);
  assert.equal(verify.status, 0);
  const verifyOutput = JSON.parse(verify.stdout);
  assert.equal(verifyOutput.runId, diagnosisOutput.runId);

  const status = run(dir, ["run", "status"]);
  assert.equal(status.status, 0);
  const statusOutput = JSON.parse(status.stdout);
  assert.equal(statusOutput.protocolVersion, "agentshell.run-status.v1");
  assert.equal(statusOutput.run.id, diagnosisOutput.runId);
  assert.equal(statusOutput.summary.status, "passed");
  assert.equal(statusOutput.summary.commandCount, 3);
  assert.equal(statusOutput.summary.latestChange.changedFiles[0], "src/user.js");
  assert.equal(statusOutput.summary.latestVerify.ok, true);
  assert.match(statusOutput.summary.rollbackCommand, /^agentshell undo op_/);

  const compactStatus = run(dir, ["run", "status", "--compact"]);
  assert.equal(compactStatus.status, 0);
  const compactOutput = JSON.parse(compactStatus.stdout);
  assert.equal(compactOutput.protocolVersion, "agentshell.run-status.v1");
  assert.equal(compactOutput.compact, true);
  assert.equal(compactOutput.run, null);
  assert.equal(compactOutput.summary.runId, diagnosisOutput.runId);
  assert.ok(compactStatus.stdout.length < status.stdout.length);

  const latestCompact = run(dir, ["run", "latest", "--compact"]);
  assert.equal(latestCompact.status, 0);
  const latestCompactOutput = JSON.parse(latestCompact.stdout);
  assert.equal(latestCompactOutput.protocolVersion, "agentshell.run-status.v1");
  assert.equal(latestCompactOutput.compact, true);
  assert.equal(latestCompactOutput.summary.runId, diagnosisOutput.runId);

  const passedNext = run(dir, ["run", "next"]);
  assert.equal(passedNext.status, 0);
  const passedNextOutput = JSON.parse(passedNext.stdout);
  assert.equal(passedNextOutput.protocolVersion, "agentshell.run-next.v1");
  assert.equal(passedNextOutput.status, "passed");
  assert.equal(passedNextOutput.command, null);
  assert.equal(passedNextOutput.reason, "Run already passed");
  assert.match(passedNextOutput.rollbackCommand, /^agentshell undo op_/);

  const metrics = run(dir, ["metrics", "--compact"]);
  const metricsOutput = JSON.parse(metrics.stdout);
  assert.equal(metricsOutput.protocolVersion, "agentshell.metrics.v2");
  assert.equal(metricsOutput.compact, true);
  assert.equal(metricsOutput.latestRun.runId, diagnosisOutput.runId);
  assert.equal(metricsOutput.latestRun.status, "passed");
  assert.equal(metricsOutput.dashboard.latestTask.status, "passed");
  assert.equal(metricsOutput.measurement.scope, "agentshell-local-tooling");

  const clear = run(dir, ["run", "clear"]);
  assert.equal(clear.status, 0);
  const clearOutput = JSON.parse(clear.stdout);
  assert.equal(clearOutput.protocolVersion, "agentshell.run-clear.v1");
  assert.equal(clearOutput.cleared, true);
  assert.equal(clearOutput.runId, diagnosisOutput.runId);
  assert.equal(clearOutput.summary.runId, diagnosisOutput.runId);
  assert.equal(clearOutput.summary.status, "passed");

  const clearedStatus = run(dir, ["run", "status", "--compact"]);
  assert.equal(clearedStatus.status, 0);
  const clearedStatusOutput = JSON.parse(clearedStatus.stdout);
  assert.equal(clearedStatusOutput.protocolVersion, "agentshell.run-status.v1");
  assert.equal(clearedStatusOutput.run, null);
  assert.equal(clearedStatusOutput.summary, null);

  const clearedNext = run(dir, ["run", "next"]);
  assert.equal(clearedNext.status, 0);
  const clearedNextOutput = JSON.parse(clearedNext.stdout);
  assert.equal(clearedNextOutput.protocolVersion, "agentshell.run-next.v1");
  assert.equal(clearedNextOutput.runId, null);
  assert.equal(clearedNextOutput.status, "idle");
  assert.equal(clearedNextOutput.command, "agentshell diagnose test --compact");

  const latestAfterClear = run(dir, ["run", "latest", "--compact"]);
  assert.equal(latestAfterClear.status, 0);
  const latestAfterClearOutput = JSON.parse(latestAfterClear.stdout);
  assert.equal(latestAfterClearOutput.protocolVersion, "agentshell.run-status.v1");
  assert.equal(latestAfterClearOutput.summary.runId, diagnosisOutput.runId);

  const clearAgain = run(dir, ["run", "clear"]);
  assert.equal(clearAgain.status, 0);
  const clearAgainOutput = JSON.parse(clearAgain.stdout);
  assert.equal(clearAgainOutput.protocolVersion, "agentshell.run-clear.v1");
  assert.equal(clearAgainOutput.cleared, false);
  assert.equal(clearAgainOutput.runId, null);
  assert.equal(clearAgainOutput.summary, null);
});

function run(cwd, args) {
  return spawnSync("node", [cli, ...args], {
    cwd,
    encoding: "utf8"
  });
}
