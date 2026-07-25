import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = path.resolve("scripts/noise-matrix-benchmark.js");

test("noise matrix benchmark compares multiple output shapes and cache paths", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-noise-report-"));
  const jsonReport = path.join(tempDir, "report.json");
  const markdownReport = path.join(tempDir, "report.md");
  const result = spawnSync("node", [
    script,
    "--runs", "1",
    "--report", jsonReport,
    "--markdown", markdownReport
  ], {
    encoding: "utf8",
    timeout: 30_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.noise-matrix-benchmark.v1");
  assert.equal(output.methodology.runsPerScenario, 1);
  assert.equal(output.summary.scenarios, 6);
  assert.equal(output.summary.noisyScenarios, 5);
  assert.equal(output.summary.validScenarios, 6);
  assert.equal(output.cases[0].id, "quiet-assertion");
  assert.ok(output.cases.slice(1).every((row) => row.tokenSavings.percent > 0));
  assert.ok(output.cases.every((row) => row.agentshellCold.cacheHit === false));
  assert.ok(output.cases.every((row) => row.agentshellWarm.cacheHit === true));
  assert.ok(output.summary.noisyOnly.tokenSavingsPercent > 70);
  assert.ok(output.summary.all.warmSpeedPercent > 0);
  assert.equal(fs.existsSync(jsonReport), true);
  assert.equal(fs.existsSync(markdownReport), true);

  const saved = JSON.parse(fs.readFileSync(jsonReport, "utf8"));
  assert.equal(saved.protocolVersion, output.protocolVersion);
  assert.match(fs.readFileSync(markdownReport, "utf8"), /Noisy-only token savings/);
});
