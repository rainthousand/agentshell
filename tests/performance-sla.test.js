import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  DEFAULT_PERFORMANCE_THRESHOLDS,
  buildPerformanceSlaReport,
  percentile
} from "../scripts/performance-sla.js";
import { buildProbeSample } from "../scripts/performance-sla-probe.js";

const script = path.resolve("scripts/performance-sla.js");
const fixtureRoot = path.resolve("tests/fixtures/performance-sla");

test("passing fixture satisfies all strict default SLA checks", () => {
  const report = buildPerformanceSlaReport(fixture("passing.json"));

  assert.equal(report.ok, true);
  assert.equal(report.protocolVersion, "agentshell.performance-sla.v1");
  assert.deepEqual(report.thresholds, DEFAULT_PERFORMANCE_THRESHOLDS);
  assert.deepEqual(report.summary, { gateStatus: "passed", total: 4, passed: 4, failed: 0, unavailable: 0 });
  assert.deepEqual(report.checks.map((check) => check.status), ["pass", "pass", "pass", "pass"]);
  assert.equal(check(report, "inspection-cold-start-p95").value, 147);
  assert.equal(check(report, "agentshell-overhead").value, 4);
  assert.equal(check(report, "compact-estimated-tokens").value, 2999);
  assert.equal(check(report, "cache-hit-speedup").value, 52.5);
});

test("boundary values fail strict targets and compact over-budget fails", () => {
  const report = buildPerformanceSlaReport(fixture("failing.json"));

  assert.equal(report.ok, false);
  assert.equal(report.summary.gateStatus, "failed");
  assert.deepEqual(report.checks.map((entry) => entry.status), ["fail", "fail", "fail", "fail"]);
  assert.equal(check(report, "agentshell-overhead").value, 5);
  assert.equal(check(report, "cache-hit-speedup").value, 50);
});

test("missing or non-comparable evidence is unavailable and never passes", () => {
  const report = buildPerformanceSlaReport(fixture("unavailable.json"));

  assert.equal(report.ok, false);
  assert.deepEqual(report.summary, { gateStatus: "unavailable", total: 4, passed: 0, failed: 0, unavailable: 4 });
  for (const entry of report.checks) {
    assert.equal(entry.status, "unavailable");
    assert.equal(entry.value, null);
    assert.ok(entry.reason);
  }
});

test("threshold overrides are deterministic and nearest-rank p95 is stable", () => {
  const report = buildPerformanceSlaReport(fixture("passing.json"), {
    thresholds: { coldStartP95Ms: 140, compactEstimatedTokens: 2500 }
  });

  assert.equal(report.thresholds.overheadPercent, 5);
  assert.equal(check(report, "inspection-cold-start-p95").status, "fail");
  assert.equal(check(report, "compact-estimated-tokens").status, "fail");
  assert.equal(percentile([30, 10, 20, 40], 0.95), 40);
  assert.equal(percentile([], 0.95), null);
});

test("CLI report mode is non-blocking while gate mode enforces failures and unavailable evidence", () => {
  const passing = run(["--input", path.join(fixtureRoot, "passing.json"), "--gate"]);
  const failingReport = run(["--input", path.join(fixtureRoot, "failing.json")]);
  const failingGate = run(["--input", path.join(fixtureRoot, "failing.json"), "--gate"]);
  const unavailableGate = run(["--input", path.join(fixtureRoot, "unavailable.json"), "--gate"]);

  assert.equal(passing.status, 0, passing.stderr);
  assert.equal(failingReport.status, 0, failingReport.stderr);
  assert.equal(failingGate.status, 1, failingGate.stderr);
  assert.equal(unavailableGate.status, 1, unavailableGate.stderr);
});

test("CLI writes a report and accepts configurable thresholds", () => {
  const output = path.join(fs.mkdtempSync("/tmp/agentshell-performance-sla-"), "nested", "report.json");
  const result = run([
    "--input", path.join(fixtureRoot, "passing.json"),
    "--max-cold-start-p95-ms", "140",
    "--output", output
  ]);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(report.thresholds.coldStartP95Ms, 140);
  assert.equal(check(report, "inspection-cold-start-p95").status, "fail");
});

test("probe adapter extracts real artifact values and leaves incomparable overhead unavailable", () => {
  const sample = buildProbeSample({
    coldStart: {
      protocolVersion: "agentshell.cold-start-benchmark.v1",
      commands: [{ id: "pwd-compact", runs: [{ wallTimeMs: 90 }, { wallTimeMs: 110 }] }]
    },
    compact: {
      protocolVersion: "agentshell.compact-contract-audit.v1",
      checks: [{ estimatedTokens: 200 }, { estimatedTokens: 300 }]
    },
    cache: {
      command: "agentshell verify test",
      firstRun: { wallDurationMs: 200 },
      secondRun: { wallDurationMs: 80 }
    }
  });
  const report = buildPerformanceSlaReport(sample);

  assert.deepEqual(sample.measurements.coldStartMs, [90, 110]);
  assert.equal(sample.measurements.overheadComparison, null);
  assert.deepEqual(sample.measurements.compactEstimatedTokens, [200, 300]);
  assert.deepEqual(sample.measurements.cacheComparison, { missMs: 200, hitMs: 80 });
  assert.equal(sample.evidence.coldStartReportOk, null);
  assert.equal(check(report, "agentshell-overhead").status, "unavailable");
  assert.equal(check(report, "cache-hit-speedup").status, "pass");
});

test("measured probe comparisons fail closed when repeated evidence is insufficient", () => {
  const sample = fixture("passing.json");
  sample.measurements.overheadComparison.sampleCount = 2;
  sample.measurements.cacheComparison.sampleCount = 2;
  const report = buildPerformanceSlaReport(sample);
  assert.equal(check(report, "agentshell-overhead").status, "unavailable");
  assert.equal(check(report, "cache-hit-speedup").status, "unavailable");
  assert.equal(report.ok, false);
});

test("report schema is closed and describes nullable unavailable measurements", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/performance-sla.schema.json", "utf8"));

  assert.equal(schema.properties.protocolVersion.const, "agentshell.performance-sla.v1");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.$defs.check.properties.status.enum, ["pass", "fail", "unavailable"]);
  assert.deepEqual(schema.$defs.check.properties.value.type, ["number", "null"]);
  assert.equal(schema.$defs.check.oneOf[2].properties.status.const, "unavailable");
  assert.equal(schema.$defs.check.oneOf[2].properties.value.type, "null");
  assert.equal(schema.$defs.check.additionalProperties, false);
});

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), "utf8"));
}

function check(report, id) {
  return report.checks.find((entry) => entry.id === id);
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}
