import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { buildPerformanceSummary } from "../scripts/performance-summary.js";

test("performance summary aggregates existing benchmark artifacts without rerunning them", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-performance-summary-"));
  writeJson(path.join(root, "suite.json"), {
    ok: true,
    cases: {
      a: { rows: { fix: { tokens: 100, durationMs: 200, commands: 1 } } },
      b: { rows: { fix: { tokens: 120, durationMs: 300, commands: 1 } } }
    }
  });
  writeJson(path.join(root, "cold.json"), {
    ok: true,
    runs: 2,
    summary: {
      commandCount: 4,
      totalCommandInvocations: 8,
      slowestAverageWallTimeMs: 90,
      fastestAverageWallTimeMs: 20,
      totalAverageEstimatedTokens: 180
    }
  });
  writeJson(path.join(root, "cache.json"), {
    ok: true,
    command: "agentshell verify test",
    commandCount: 2,
    speedupPercent: 100,
    durationDelta: 80,
    estimatedTokenDelta: 10,
    testExecutions: 1
  });

  const report = buildPerformanceSummary(root, {
    benchmarkSuite: "suite.json",
    coldStart: "cold.json",
    cache: "cache.json"
  });

  assert.equal(report.ok, true);
  assert.equal(report.protocolVersion, "agentshell.performance-summary.v1");
  assert.equal(report.summary.benchmarkCases, 2);
  assert.equal(report.summary.averageFixTokens, 110);
  assert.equal(report.summary.averageFixCommands, 1);
  assert.equal(report.summary.coldStartCommandCount, 4);
  assert.equal(report.summary.coldStartTotalCommandInvocations, 8);
  assert.equal(report.summary.coldStartSlowestAverageWallTimeMs, 90);
  assert.equal(report.summary.coldStartTotalAverageEstimatedTokens, 180);
  assert.equal(report.summary.cacheCommandCount, 2);
  assert.equal(report.summary.cacheSpeedupPercent, 100);
  assert.match(report.recommendation, /ready for product reporting/);
});

test("performance summary CLI writes JSON and Markdown reports", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-performance-summary-cli-"));
  const reportPath = path.join(root, "summary.json");
  const markdownPath = path.join(root, "summary.md");
  writeJson(path.join(root, "suite.json"), {
    ok: true,
    cases: {
      a: { rows: { fix: { tokens: 100, durationMs: 200, commands: 1 } } }
    }
  });

  const result = spawnSync("node", [
    "scripts/performance-summary.js",
    "--benchmark-suite",
    path.join(root, "suite.json"),
    "--cold-start",
    path.join(root, "missing-cold.json"),
    "--cache",
    path.join(root, "missing-cache.json"),
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
  assert.equal(report.summary.benchmarkCases, 1);
  assert.equal(report.sources.coldStart.present, false);
  assert.equal(report.sources.coldStart.valid, false);
  assert.match(report.recommendation, /Run missing performance reports/);
  assert.match(markdown, /^# AgentShell Performance Summary/m);
});

test("performance summary treats malformed artifacts as missing evidence instead of crashing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-performance-summary-bad-"));
  fs.writeFileSync(path.join(root, "bad.json"), "");

  const report = buildPerformanceSummary(root, {
    benchmarkSuite: "bad.json",
    coldStart: "missing-cold.json",
    cache: "missing-cache.json"
  });

  assert.equal(report.ok, true);
  assert.equal(report.sources.benchmarkSuite.present, true);
  assert.equal(report.sources.benchmarkSuite.valid, false);
  assert.match(report.sources.benchmarkSuite.error, /Unexpected end of JSON input/);
  assert.equal(report.summary.benchmarkCases, 0);
  assert.match(report.recommendation, /benchmark suite/);
});

test("package exposes performance summary script", () => {
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(packageJson.scripts?.["performance:summary"], "node scripts/performance-summary.js");
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
