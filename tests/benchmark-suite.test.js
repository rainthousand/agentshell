import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("benchmark suite reports raw, split, and fix rows for each case", () => {
  const result = spawnSync("node", ["scripts/benchmark-suite.js"], {
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const cases = Object.values(output.cases);

  assert.equal(output.ok, true);
  assert.equal(output.thresholds, undefined);
  assert.ok(cases.length >= 3);
  assert.deepEqual(Object.keys(output.cases).sort(), [
    "array-length",
    "deep-equal-array-elements",
    "deep-equal-array-primitive-replacement",
    "deep-equal-array-removal",
    "deep-equal-extra-property-removal",
    "deep-equal-missing-property",
    "import-path-typo",
    "join-separator-literal",
    "missing-export",
    "missing-property",
    "string-case-transform",
    "truthy-return",
    "typescript-diagnostic",
    "typescript-property-suggestion",
    "wrong-literal"
  ]);

  for (const benchmarkCase of cases) {
    assert.equal(benchmarkCase.ok, true);
    assert.equal(benchmarkCase.rows.raw.ok, false);
    assert.equal(benchmarkCase.rows.split.ok, true);
    assert.equal(benchmarkCase.rows.fix.ok, true);

    assert.equal(benchmarkCase.rows.raw.commands, 1);
    assert.equal(benchmarkCase.rows.split.commands, 3);
    assert.equal(benchmarkCase.rows.fix.commands, 1);

    for (const row of Object.values(benchmarkCase.rows)) {
      assert.equal(row.tokens, Math.ceil(row.chars / 4));
      assert.equal(row.events.length, row.commands);
      assert.ok(row.chars > 0);
      assert.equal(typeof row.durationMs, "number");
      assert.ok(row.durationMs >= 0);

      for (const event of row.events) {
        assert.equal(typeof event.durationMs, "number");
        assert.ok(event.durationMs >= 0);
        assert.equal(typeof event.rollbackAvailable, "boolean");
        assert.equal(
          event.rollbackCommand === null || /^agentshell undo op_/.test(event.rollbackCommand),
          true
        );
      }
    }

    assert.equal(benchmarkCase.rows.raw.rollbackAvailable, false);
    assert.equal(benchmarkCase.rows.raw.rollbackCommand, null);
    assert.equal(benchmarkCase.rows.split.rollbackAvailable, true);
    assert.match(benchmarkCase.rows.split.rollbackCommand, /^agentshell undo op_/);
    assert.equal(benchmarkCase.rows.fix.rollbackAvailable, true);
    assert.match(benchmarkCase.rows.fix.rollbackCommand, /^agentshell undo op_/);
  }
});

test("benchmark suite can render a markdown report", () => {
  const result = spawnSync("node", ["scripts/benchmark-suite.js", "--markdown"], {
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# AgentShell Benchmark Suite/);
  assert.match(result.stdout, /\| Case \| Path \| Ok \| Commands \| Tokens \| Duration \| Rollback \|/);
  assert.match(result.stdout, /wrong-literal \| raw/);
  assert.match(result.stdout, /wrong-literal \| split/);
  assert.match(result.stdout, /wrong-literal \| fix/);
  assert.match(result.stdout, /agentshell undo op_/);
});

test("benchmark suite writes JSON and Markdown artifact reports", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-benchmark-report-"));
  const jsonReport = path.join(tempDir, "benchmark-report.json");
  const markdownReport = path.join(tempDir, "benchmark-report.md");
  const result = spawnSync("node", [
    "scripts/benchmark-suite.js",
    "--ci",
    "--report",
    jsonReport,
    "--markdown",
    markdownReport
  ], {
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);

  const stdoutReport = JSON.parse(result.stdout);
  const artifactReport = JSON.parse(fs.readFileSync(jsonReport, "utf8"));
  const markdown = fs.readFileSync(markdownReport, "utf8");

  assert.deepEqual(artifactReport, stdoutReport);
  assert.equal(artifactReport.thresholds.ok, true);
  assert.ok(artifactReport.thresholds.checks.some((check) => check.name === "all-cases-ok"));
  assert.match(markdown, /^# AgentShell Benchmark Suite/);
  assert.match(markdown, /## Thresholds/);
  assert.match(markdown, /Checks: \d+\/\d+ passing/);
  assert.match(markdown, /wrong-literal \| raw/);
});

test("benchmark suite passes CI thresholds with the default token ceiling", () => {
  const result = spawnSync("node", ["scripts/benchmark-suite.js", "--ci"], {
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);

  assert.equal(output.ok, true);
  assert.equal(output.thresholds.ok, true);
  assert.equal(output.thresholds.mode, "ci");
  assert.equal(output.thresholds.maxFixTokens, 275);
  assert.equal(output.thresholds.checks.every((check) => check.ok), true);
  assert.ok(output.thresholds.checks.some((check) => check.name === "all-cases-ok"));
  assert.ok(output.thresholds.checks.some((check) => check.name.endsWith(":fix-tokens")));
});

test("benchmark suite fails CI thresholds when the fix token ceiling is too low", () => {
  const result = spawnSync("node", [
    "scripts/benchmark-suite.js",
    "--ci",
    "--max-fix-tokens",
    "1"
  ], {
    encoding: "utf8"
  });

  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stdout);
  const failedChecks = output.thresholds.checks.filter((check) => !check.ok);

  assert.equal(output.ok, true);
  assert.equal(output.thresholds.ok, false);
  assert.equal(output.thresholds.maxFixTokens, 1);
  assert.ok(failedChecks.length > 0);
  assert.ok(failedChecks.every((check) => check.name.endsWith(":fix-tokens")));
  assert.ok(failedChecks.every((check) => check.actual > check.max));
});
