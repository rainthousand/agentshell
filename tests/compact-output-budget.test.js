import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_COMPACT_BUDGET,
  applyCompactBudget,
  estimateCompactTokens,
  findCompactBudgetViolations,
  measureCompactOutput
} from "../src/core/compact-budget.js";

test("compact budget deterministically bounds strings, lists, and final JSON", () => {
  const input = {
    ok: true,
    protocolVersion: "agentshell.fixture.v1",
    compact: true,
    summary: { status: "passed", total: 100 },
    results: Array.from({ length: 30 }, (_, index) => ({
      index,
      detail: `result-${index}-${"x".repeat(250)}`
    })),
    extra: "y".repeat(2_000)
  };
  const budget = { maxChars: 1_600, maxEstimatedTokens: 400, maxArrayItems: 4, maxStringChars: 80 };

  const first = applyCompactBudget(input, budget);
  const second = applyCompactBudget(input, budget);
  const measured = measureCompactOutput(first);

  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  assert.equal(first.protocolVersion, "agentshell.fixture.v1");
  assert.deepEqual(first.summary, { status: "passed", total: 100 });
  assert.ok(measured.chars <= budget.maxChars);
  assert.ok(measured.estimatedTokens <= budget.maxEstimatedTokens);
  assert.ok((first.results?.length || 0) <= budget.maxArrayItems);
  assert.equal(first.compactBudget.truncated, true);
  assert.ok(first.compactBudget.omitted.items >= 26);
  assert.ok(first.compactBudget.oversizedPaths.includes("$.results"));
  assert.ok(first.compactBudget.original.chars > measured.chars);
});

test("compact budget reports nested oversized paths before enforcement", () => {
  const value = {
    ok: true,
    protocolVersion: "agentshell.fixture.v1",
    compact: true,
    summary: { status: "ok" },
    groups: [{ lines: ["a", "b", "c", "d"], message: "z".repeat(50) }]
  };
  const violations = findCompactBudgetViolations(value, {
    maxChars: 1_024,
    maxEstimatedTokens: 256,
    maxArrayItems: 3,
    maxStringChars: 20
  });

  assert.ok(violations.some((entry) => entry.path === "$.groups[0].lines" && entry.kind === "array"));
  assert.ok(violations.some((entry) => entry.path === "$.groups[0].message" && entry.kind === "string"));
});

test("compact token estimate and defaults are stable", () => {
  assert.equal(estimateCompactTokens(0), 0);
  assert.equal(estimateCompactTokens(5), 2);
  assert.equal(estimateCompactTokens("12345"), 2);
  assert.deepEqual(DEFAULT_COMPACT_BUDGET, {
    maxChars: 12_000,
    maxEstimatedTokens: 3_000,
    maxArrayItems: 40,
    maxStringChars: 2_000
  });
});

test("minimum supported budget remains hard and preserves protocol identity", () => {
  const output = applyCompactBudget({
    ok: true,
    protocolVersion: "agentshell.fixture.v1",
    compact: true,
    summary: { status: "ok" },
    detail: "x".repeat(10_000)
  }, { maxChars: 768, maxEstimatedTokens: 192, maxArrayItems: 1, maxStringChars: 1 });

  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.fixture.v1");
  assert.ok(measureCompactOutput(output).chars <= 768);
  assert.ok(measureCompactOutput(output).estimatedTokens <= 192);
});
