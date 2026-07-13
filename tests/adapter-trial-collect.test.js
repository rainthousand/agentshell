import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { collectAdapterTrial } from "../scripts/adapter-trial-collect.js";

test("adapter trial collector turns command events into a scored trial", () => {
  const report = collectAdapterTrial({
    host: "codex",
    fixture: "examples/failing-test-demo",
    events: [
      { type: "command", command: "agentshell start --compact", stdout: "ok", durationMs: 100 },
      { type: "command", command: "agentshell fix test --fast --compact", stdout: "rollbackCommand", durationMs: 200 },
      { type: "command", command: "agentshell verify test", stdout: "passed", durationMs: 100 },
      { type: "command", command: "agentshell run status --compact", stdout: "rollback", durationMs: 50 }
    ],
    finalVerification: {
      ok: true,
      command: "agentshell verify test",
      summary: "passed with rollback guidance"
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.protocolVersion, "agentshell.adapter-trial-collect.v1");
  assert.equal(report.trial.commands.length, 4);
  assert.equal(report.scoreReport.protocolVersion, "agentshell.adapter-trial.v1");
  assert.equal(report.summary.score, 100);
  assert.equal(report.summary.interpretation, "strong");
  assert.equal(report.summary.agentShellCommands, 4);
  assert.equal(report.summary.noisyRawCommands, 0);
  assert.equal(report.summary.totalDurationMs, 450);
  assert.ok(report.summary.totalOutputTokens > 0);
});

test("adapter trial collector accepts simple commands and penalizes raw-first runs", () => {
  const report = collectAdapterTrial({
    host: "claude",
    commands: [
      { command: "npm test", stdout: "long failing output", durationMs: 1000 },
      { command: "cat test/user.test.js", stdout: "file body", durationMs: 20 },
      { command: "agentshell diagnose test --compact", stdout: "diagnosis", durationMs: 200 }
    ]
  });

  assert.equal(report.summary.interpretation, "weak");
  assert.equal(report.summary.noisyRawCommands, 2);
  assert.equal(report.scoreReport.criteria.noiseControl.points, 0);
});

test("adapter trial collector CLI writes collection report, trial JSON, and markdown", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-adapter-trial-collect-"));
  const inputPath = path.join(tempRoot, "input.json");
  const trialPath = path.join(tempRoot, "trial.json");
  const reportPath = path.join(tempRoot, "report.json");
  const markdownPath = path.join(tempRoot, "report.md");
  fs.writeFileSync(inputPath, JSON.stringify({
    host: "agents-md",
    fixture: "examples/failing-test-demo",
    commands: [
      { command: "agentshell start --compact", stdout: "ok", durationMs: 100 },
      { command: "agentshell fix test --fast --compact", stdout: "rollback", durationMs: 200 },
      { command: "agentshell verify test", stdout: "passed", durationMs: 100 },
      { command: "agentshell run status --compact", stdout: "status", durationMs: 50 }
    ],
    finalVerification: {
      ok: true,
      command: "agentshell verify test",
      summary: "passed with rollback guidance"
    }
  }, null, 2));

  const result = spawnSync("node", [
    "scripts/adapter-trial-collect.js",
    "--input",
    inputPath,
    "--trial",
    trialPath,
    "--report",
    reportPath,
    "--markdown",
    markdownPath
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const stdout = JSON.parse(result.stdout);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const trial = JSON.parse(fs.readFileSync(trialPath, "utf8"));
  const markdown = fs.readFileSync(markdownPath, "utf8");
  assert.deepEqual(report, stdout);
  assert.equal(trial.host, "agents-md");
  assert.equal(trial.commands.length, 4);
  assert.match(markdown, /^# AgentShell Adapter Trial Collection/m);
  assert.match(markdown, /Score: 100\/100 \(strong\)/);
});

test("adapter trial collector sample produces a strong report", () => {
  const result = spawnSync("node", [
    "scripts/adapter-trial-collect.js",
    "--input",
    "examples/adapter-trial-collect.sample.json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.score, 100);
  assert.equal(report.summary.interpretation, "strong");
});

test("adapter trial collector schema and package script are exposed", () => {
  const schemaResult = spawnSync("node", ["src/cli.js", "schema", "get", "adapter-trial-collect"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(schemaResult.status, 0, schemaResult.stderr);
  const schema = JSON.parse(schemaResult.stdout);
  assert.equal(schema.protocolVersion, "agentshell.schema-get.v1");
  assert.equal(schema.properties.protocolVersion.const, "agentshell.adapter-trial-collect.v1");

  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(packageJson.scripts["adapter:trial:collect"], "node scripts/adapter-trial-collect.js");
});
