import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { collectCodexPluginTrials } from "../scripts/codex-plugin-trial-collect.js";

const strongInput = {
  id: "real-codex-run",
  host: "codex",
  fixture: "examples/failing-test-demo",
  events: [
    { type: "command", command: "agentshell start --compact", stdout: "ok", durationMs: 100 },
    { type: "command", command: "agentshell fix test --fast --compact", stdout: "rollbackCommand", durationMs: 200 },
    { type: "command", command: "agentshell run status --compact", stdout: "rollback", durationMs: 50 }
  ],
  finalVerification: {
    ok: true,
    command: "agentshell fix test --fast --compact",
    summary: "passed with rollback guidance"
  }
};

test("codex plugin trial collector wraps real Codex runs in the plugin trial protocol", () => {
  const report = collectCodexPluginTrials([strongInput]);

  assert.equal(report.ok, true);
  assert.equal(report.protocolVersion, "agentshell.codex-plugin-trial.v1");
  assert.equal(report.summary.total, 1);
  assert.equal(report.summary.byInterpretation.strong, 1);
  assert.equal(report.trials[0].kind, "collect");
  assert.equal(report.trials[0].host, "codex");
  assert.equal(report.trials[0].id, "real-codex-run");
  assert.equal(report.trials[0].interpretation, "strong");
  assert.deepEqual(report.compactReport, {
    runs: 1,
    completedRuns: 1,
    placeholderRuns: 0,
    successRate: 100,
    averageScore: 100,
    strongRate: 100,
    tokens: {
      total: 8,
      averagePerRun: 8
    },
    speed: {
      totalDurationMs: 350,
      averageDurationMs: 350
    },
    commands: {
      totalAgentShell: 3,
      totalNoisyRaw: 0,
      unobservedNoiseRuns: 0
    },
    evidenceStatus: "complete",
    claimReadiness: "ready-for-product-evidence"
  });
  assert.match(report.recommendation, /Real Codex plugin runs are strong/);
});

test("codex plugin trial collector does not award noise-control points when raw commands are unobservable", () => {
  const report = collectCodexPluginTrials([{
    ...strongInput,
    evidenceMetadata: {
      captureScope: {
        nonAgentShellCommands: false
      }
    }
  }]);

  assert.equal(report.trials[0].score, 90);
  assert.equal(report.trials[0].interpretation, "strong");
  assert.equal(report.trials[0].criteria.noiseControl.points, 0);
  assert.equal(report.trials[0].observability.noiseControl, "unobserved");
  assert.equal(report.summary.unobservedNoiseRuns, 1);
  assert.equal(report.compactReport.commands.unobservedNoiseRuns, 1);
});

test("codex plugin trial collector rejects non-Codex hosts", () => {
  assert.throws(
    () => collectCodexPluginTrials([{ ...strongInput, host: "claude" }]),
    /must use host/
  );
});

test("codex plugin trial collector CLI writes report and markdown", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-codex-plugin-collect-"));
  const inputPath = path.join(tempRoot, "run-log.json");
  const reportPath = path.join(tempRoot, "report.json");
  const markdownPath = path.join(tempRoot, "report.md");
  fs.writeFileSync(inputPath, JSON.stringify(strongInput, null, 2));

  const result = spawnSync("node", [
    "scripts/codex-plugin-trial-collect.js",
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
  assert.equal(report.protocolVersion, "agentshell.codex-plugin-trial.v1");
  assert.match(markdown, /^# Codex Plugin Real-Run Trial/m);
  assert.match(markdown, /Average score: 100\/100/);
  assert.match(markdown, /Success rate: 100%/);
  assert.match(markdown, /Evidence status: complete/);
});

test("codex plugin trial collector marks placeholder run logs as incomplete evidence", () => {
  const placeholderInput = {
    ...strongInput,
    id: "template-run",
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
      command: "agentshell verify test",
      summary: "REPLACE_WITH_FINAL_VERIFICATION_SUMMARY"
    }
  };

  const report = collectCodexPluginTrials([placeholderInput]);

  assert.equal(report.ok, false);
  assert.equal(report.evidence.status, "incomplete");
  assert.deepEqual(report.evidence.placeholderRuns, ["template-run"]);
  assert.equal(report.compactReport.placeholderRuns, 1);
  assert.equal(report.compactReport.successRate, 100);
  assert.match(report.recommendation, /Fill placeholder run logs/);
  assert.deepEqual(report.trials[0].evidence.placeholderFields, [
    "events[0].stdout",
    "finalVerification.summary"
  ]);
});

test("codex plugin trial collector CLI accepts a suite manifest for compact 3-run evidence", () => {
  const result = spawnSync("node", [
    "scripts/codex-plugin-trial-collect.js",
    "--manifest",
    "artifacts/codex-plugin-real-3run/suite.json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.protocolVersion, "agentshell.codex-plugin-trial.v1");
  assert.equal(report.name, "codex-plugin-real-run-plan");
  assert.equal(report.compactReport.runs, 3);
  assert.equal(report.compactReport.evidenceStatus, "incomplete");
  assert.equal(report.compactReport.placeholderRuns, 3);
  assert.equal(report.summary.totalAgentShellCommands, 9);
  assert.equal(report.summary.successRate, 100);
});

test("codex plugin new-thread sample produces a strong report", () => {
  const result = spawnSync("node", [
    "scripts/codex-plugin-trial-collect.js",
    "--input",
    "examples/codex-plugin-new-thread.sample.json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.protocolVersion, "agentshell.codex-plugin-trial.v1");
  assert.equal(report.summary.byInterpretation.strong, 1);
  assert.equal(report.trials[0].sourcePath, path.resolve(process.cwd(), "examples/codex-plugin-new-thread.sample.json"));
});

test("package exposes codex plugin collector script", () => {
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(packageJson.scripts?.["codex:plugin:collect"], "node scripts/codex-plugin-trial-collect.js");
});
