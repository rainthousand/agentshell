import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { buildStrategyIntake } from "../scripts/strategy-intake.js";

test("strategy intake prioritizes concrete unsupported samples", () => {
  const input = JSON.parse(readFileSync("examples/strategy-intake.sample.json", "utf8"));
  const report = buildStrategyIntake(input);

  assert.equal(report.ok, true);
  assert.equal(report.protocolVersion, "agentshell.strategy-intake.v1");
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.byPriority.high, 2);
});

test("strategy intake blocks samples without enough evidence", () => {
  const report = buildStrategyIntake({
    samples: [{ failureClass: "unknown", commands: [] }]
  });

  assert.equal(report.summary.blocked, 1);
  assert.equal(report.samples[0].readyForImplementation, false);
  assert.ok(report.samples[0].blockers.includes("unknown failureClass"));
});

test("strategy intake CLI prints parseable JSON", () => {
  const result = spawnSync("node", ["scripts/strategy-intake.js", "--input", "examples/strategy-intake.sample.json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.summary.total, 2);
});

test("strategy intake schema is exposed through schema get", () => {
  const result = spawnSync("node", ["src/cli.js", "schema", "get", "strategy-intake"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const schema = JSON.parse(result.stdout);
  assert.equal(schema.protocolVersion, "agentshell.schema-get.v1");
  assert.equal(schema.properties.protocolVersion.const, "agentshell.strategy-intake.v1");
  assert.ok(schema.$defs.failureClass.enum.includes("import-path"));
  assert.ok(schema.$defs.priority.enum.includes("needs-reproduction"));
  assert.equal(schema.$defs.sample.additionalProperties, false);
});

test("package exposes strategy intake script", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(packageJson.scripts?.["strategy:intake"], "node scripts/strategy-intake.js");
});
