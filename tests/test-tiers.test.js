import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { listTierTests, testTier, tierSummary } from "../scripts/run-test-tier.js";

test("test tiers partition every test file exactly once", () => {
  const all = listTierTests("all");
  const partitioned = ["fast", "integration", "release", "benchmark"].flatMap((tier) => listTierTests(tier));
  assert.deepEqual(new Set(partitioned), new Set(all));
  assert.equal(partitioned.length, all.length);
  assert.ok(Object.values(tierSummary()).every((count) => count > 0));
});

test("known expensive suites stay out of the fast tier", () => {
  assert.equal(testTier("tests/benchmark-suite.test.js"), "benchmark");
  assert.equal(testTier("tests/release-engineering.test.js"), "release");
  assert.equal(testTier("tests/codex-plugin-e2e.test.js"), "integration");
  assert.equal(testTier("tests/grep.test.js"), "fast");
});

test("package scripts expose every tier and keep the default fast", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  assert.equal(pkg.scripts.test, "node scripts/run-test-tier.js fast");
  for (const tier of ["fast", "integration", "release", "benchmark", "all"]) {
    assert.equal(pkg.scripts[`test:${tier}`], `node scripts/run-test-tier.js ${tier}`);
  }
});

test("stateful tiers serialize suites that mutate shared state", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "scripts/run-test-tier.js"), "utf8");
  assert.match(source, /\["integration", "release"\]\.includes\(tier\)/);
  assert.match(source, /--test-concurrency=1/);
});

test("all tiers run sequentially instead of sharing one test process", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "scripts/run-test-tier.js"), "utf8");
  assert.match(source, /for \(const currentTier of TIER_ORDER\)/);
  assert.match(source, /runTier\(currentTier\)/);
});
