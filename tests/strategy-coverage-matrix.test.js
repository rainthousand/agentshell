import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { buildStrategyCoverageMatrix } from "../scripts/strategy-coverage-matrix.js";

test("strategy coverage matrix is generated from the change-suggest strategy enum", () => {
  const matrix = buildStrategyCoverageMatrix();
  const changeSuggestSchema = JSON.parse(fs.readFileSync("schemas/change-suggest.schema.json", "utf8"));
  const strategies = changeSuggestSchema.properties.strategy.enum.filter((strategy) => strategy !== "unknown");

  assert.equal(matrix.ok, true);
  assert.equal(matrix.protocolVersion, "agentshell.strategy-coverage-matrix.v1");
  assert.deepEqual(matrix.strategies.map((row) => row.strategy), strategies);
  assert.equal(matrix.summary.totalStrategies, strategies.length);

  const matrixSchema = JSON.parse(fs.readFileSync("schemas/strategy-coverage-matrix.schema.json", "utf8"));
  assert.deepEqual(matrixSchema.$defs.strategy.enum, strategies);
});

test("strategy coverage matrix reports current critical coverage without pinning every gap", () => {
  const matrix = buildStrategyCoverageMatrix();
  const rows = Object.fromEntries(matrix.strategies.map((row) => [row.strategy, row]));
  const strategies = Object.keys(rows);

  for (const strategy of strategies) {
    assert.equal(rows[strategy].coverage.unitTests, true, `${strategy} needs unit test coverage`);
    assert.equal(rows[strategy].coverage.benchmarkCases, true, `${strategy} needs benchmark coverage`);
    assert.equal(rows[strategy].coverage.realProjectFixtures, true, `${strategy} needs real-project fixture coverage`);
  }

  assert.deepEqual(matrix.summary.missing.docs, []);
  assert.deepEqual(matrix.summary.missing.benchmarkCases, []);
  assert.deepEqual(matrix.summary.missing.realProjectFixtures, []);
});

test("strategy coverage matrix CLI prints parseable JSON", () => {
  const result = spawnSync("node", ["scripts/strategy-coverage-matrix.js"], {
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);

  assert.equal(output.ok, true);
  assert.equal(output.strategies.length, output.summary.totalStrategies);
  assert.deepEqual(output.summary.missing.benchmarkCases, []);
});
