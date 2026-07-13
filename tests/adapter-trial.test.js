import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { scoreAdapterTrial } from "../scripts/adapter-trial.js";

test("adapter trial scores a strong AgentShell-first run", () => {
  const report = scoreAdapterTrial({
    host: "codex",
    fixture: "examples/failing-test-demo",
    commands: [
      { command: "agentshell start --compact", outputTokens: 180, durationMs: 120 },
      { command: "agentshell fix test --fast --compact", outputTokens: 310, durationMs: 850 },
      { command: "agentshell verify test", outputTokens: 160, durationMs: 420 },
      { command: "agentshell run status --compact", outputTokens: 120, durationMs: 80 }
    ],
    finalVerification: {
      ok: true,
      command: "agentshell verify test",
      summary: "tests passed; rollback command available"
    },
    notes: "No broad raw logs were needed."
  });

  assert.equal(report.ok, true);
  assert.equal(report.protocolVersion, "agentshell.adapter-trial.v1");
  assert.equal(report.host, "codex");
  assert.equal(report.score, 100);
  assert.equal(report.interpretation, "strong");
  assert.equal(report.metrics.commandCount, 4);
  assert.equal(report.metrics.agentShellCommandCount, 4);
  assert.equal(report.metrics.noisyRawCommandCount, 0);
  assert.equal(report.metrics.firstAgentShellCommandIndex, 0);
  assert.equal(report.metrics.totalOutputTokens, 770);
  assert.equal(report.metrics.totalDurationMs, 1470);
});

test("adapter trial penalizes raw shell-first behavior", () => {
  const report = scoreAdapterTrial({
    host: "claude",
    fixture: "examples/failing-test-demo",
    commands: [
      "npm test",
      "cat test/failing.test.js",
      "agentshell diagnose test --compact"
    ],
    notes: "Fixed the test without recording rollback guidance."
  });

  assert.equal(report.interpretation, "weak");
  assert.equal(report.criteria.firstTwoCommands.points, 0);
  assert.equal(report.criteria.fastRepairPath.points, 0);
  assert.equal(report.criteria.noiseControl.points, 0);
  assert.equal(report.metrics.noisyRawCommandCount, 2);
  assert.equal(report.metrics.firstNoisyRawCommandIndex, 0);
});

test("adapter trial CLI writes JSON and Markdown reports", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-adapter-trial-"));
  const inputPath = path.join(tempRoot, "trial.json");
  const reportPath = path.join(tempRoot, "report.json");
  const markdownPath = path.join(tempRoot, "report.md");
  fs.writeFileSync(inputPath, JSON.stringify({
    host: "agents-md",
    fixture: "examples/failing-test-demo",
    commands: [
      { command: "agentshell start --compact", outputTokens: 100, durationMs: 100 },
      { command: "agentshell fix test --fast --compact", outputTokens: 200, durationMs: 200 },
      { command: "agentshell verify test", outputTokens: 100, durationMs: 100 },
      { command: "agentshell run status --compact", outputTokens: 80, durationMs: 50 }
    ],
    finalVerification: {
      ok: true,
      command: "agentshell verify test",
      summary: "passed with rollback guidance"
    }
  }, null, 2));

  const result = spawnSync("node", [
    "scripts/adapter-trial.js",
    "--input",
    inputPath,
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
  const markdown = fs.readFileSync(markdownPath, "utf8");
  assert.deepEqual(report, stdout);
  assert.equal(report.score, 100);
  assert.match(markdown, /^# AgentShell Adapter Trial Report/m);
  assert.match(markdown, /Score: 100\/100 \(strong\)/);
});

test("adapter trial schema is exposed through schema get", () => {
  const result = spawnSync("node", ["src/cli.js", "schema", "get", "adapter-trial"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const schema = JSON.parse(result.stdout);
  assert.equal(schema.protocolVersion, "agentshell.schema-get.v1");
  assert.equal(schema.properties.protocolVersion.const, "agentshell.adapter-trial.v1");
  assert.equal(schema.properties.host.enum.includes("codex"), true);
  assert.equal(schema.properties.criteria.required.includes("fastRepairPath"), true);
});

test("package exposes adapter trial script", () => {
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(packageJson.scripts["adapter:trial"], "node scripts/adapter-trial.js");
});

test("adapter trial sample scores as a strong run", () => {
  const result = spawnSync("node", [
    "scripts/adapter-trial.js",
    "--input",
    "examples/adapter-trial.sample.json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.score, 100);
  assert.equal(report.interpretation, "strong");
});
