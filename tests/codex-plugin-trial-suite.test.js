import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { runCodexPluginTrialSuite } from "../scripts/codex-plugin-trial-suite.js";

const strongRun = {
  id: "codex-run-a",
  host: "codex",
  fixture: "examples/failing-test-demo",
  events: [
    { type: "command", command: "agentshell start --compact", stdout: "{\"ok\":true}", durationMs: 100 },
    { type: "command", command: "agentshell fix test --fast --compact", stdout: "{\"ok\":true,\"rollbackCommand\":\"agentshell undo op_a\"}", durationMs: 200 },
    { type: "command", command: "agentshell run status --compact", stdout: "{\"ok\":true,\"rollbackCommand\":\"agentshell undo op_a\"}", durationMs: 50 }
  ],
  finalVerification: {
    ok: true,
    command: "agentshell fix test --fast --compact",
    summary: "passed with rollback guidance"
  }
};

test("codex plugin trial suite aggregates real Codex run logs", () => {
  const report = runCodexPluginTrialSuite({
    name: "suite",
    runs: [
      { id: "first", input: strongRun },
      { id: "second", input: { ...strongRun, id: "ignored-inner-id" }, notes: "external user run" }
    ]
  });

  assert.equal(report.ok, true);
  assert.equal(report.protocolVersion, "agentshell.codex-plugin-trial-suite.v1");
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.averageScore, 100);
  assert.equal(report.summary.strongRate, 100);
  assert.equal(report.evidence.status, "complete");
  assert.equal(report.evidence.claimReadiness, "ready-for-product-evidence");
  assert.equal(report.summary.byInterpretation.strong, 2);
  assert.equal(report.summary.averageDurationMs, 350);
  assert.equal(report.trials[0].id, "first");
  assert.equal(report.trials[0].evidence.complete, true);
  assert.equal(report.trials[1].notes, "external user run");
  assert.match(report.recommendation, /All real Codex plugin runs are strong/);
});

test("codex plugin trial suite marks placeholder templates as incomplete evidence", () => {
  const placeholderRun = {
    ...strongRun,
    events: [
      {
        type: "command",
        command: "agentshell start --compact",
        stdout: "PASTE_COMPACT_JSON_STDOUT_HERE",
        durationMs: 0
      }
    ],
    finalVerification: {
      ok: true,
      command: "agentshell start --compact",
      summary: "REPLACE_WITH_FINAL_VERIFICATION_SUMMARY"
    }
  };

  const report = runCodexPluginTrialSuite({
    name: "incomplete-suite",
    runs: [{ id: "placeholder", input: placeholderRun }]
  });

  assert.equal(report.ok, false);
  assert.equal(report.evidence.status, "incomplete");
  assert.deepEqual(report.evidence.placeholderRuns, ["placeholder"]);
  assert.equal(report.evidence.claimReadiness, "not-ready-fill-placeholder-run-logs");
  assert.equal(report.trials[0].evidence.complete, false);
  assert.ok(report.trials[0].evidence.placeholderFields.includes("events[0].stdout"));
  assert.match(report.recommendation, /Fill placeholder run logs/);
});

test("codex plugin trial suite CLI reads manifest and writes reports", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-codex-plugin-suite-"));
  const runPath = path.join(tempRoot, "run-log.json");
  const manifestPath = path.join(tempRoot, "suite.json");
  const reportPath = path.join(tempRoot, "report.json");
  const markdownPath = path.join(tempRoot, "report.md");
  fs.writeFileSync(runPath, JSON.stringify(strongRun, null, 2));
  fs.writeFileSync(manifestPath, JSON.stringify({
    name: "cli-suite",
    runs: [{ id: "cli-run", path: "run-log.json" }]
  }, null, 2));

  const result = spawnSync("node", [
    "scripts/codex-plugin-trial-suite.js",
    "--manifest",
    manifestPath,
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
  assert.equal(report.protocolVersion, "agentshell.codex-plugin-trial-suite.v1");
  assert.equal(report.trials[0].sourcePath, "run-log.json");
  assert.match(markdown, /^# Codex Plugin Real-Run Suite/m);
  assert.match(markdown, /Strong rate: 100%/);
  assert.match(markdown, /Evidence status: complete/);
});

test("codex plugin suite sample produces a strong aggregate report", () => {
  const result = spawnSync("node", [
    "scripts/codex-plugin-trial-suite.js",
    "--manifest",
    "examples/codex-plugin-suite.sample.json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.protocolVersion, "agentshell.codex-plugin-trial-suite.v1");
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.byInterpretation.strong, 2);
  assert.equal(report.evidence.status, "complete");
});

test("codex plugin trial suite schema and package script are exposed", () => {
  const schemaResult = spawnSync("node", ["src/cli.js", "schema", "get", "codex-plugin-trial-suite"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(schemaResult.status, 0, schemaResult.stderr);
  const schema = JSON.parse(schemaResult.stdout);
  assert.equal(schema.properties.protocolVersion.const, "agentshell.codex-plugin-trial-suite.v1");
  assert.equal(schema.properties.ok.type, "boolean");
  assert.equal(schema.$defs.trialResult.properties.host.const, "codex");
  assert.equal(schema.$defs.evidence.properties.status.enum.includes("incomplete"), true);

  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(packageJson.scripts?.["codex:plugin:suite"], "node scripts/codex-plugin-trial-suite.js");
});
