import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = path.resolve("scripts/cache-benchmark.js");

test("cache benchmark reports first and second verify cache impact", () => {
  const result = spawnSync("node", [script], {
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.command, "agentshell verify test");
  assert.equal(output.commandCount, 2);
  assert.equal(output.summary.commands, 2);
  assert.equal(output.summary.testExecutions, 1);
  assert.equal(output.firstRun.status, 1);
  assert.equal(output.secondRun.status, 1);
  assert.equal(output.firstRun.cacheHit, false);
  assert.equal(output.secondRun.cacheHit, true);
  assert.equal(output.secondRun.cacheKey, output.firstRun.cacheKey);
  assert.equal(output.testExecutions, 1);
  assert.ok(output.firstRun.durationMs > output.secondRun.durationMs);
  assert.equal(output.secondRun.durationMs, 0);
  assert.ok(output.durationDelta > 0);
  assert.ok(output.speedupPercent > 0);
  assert.ok(output.firstRun.chars > 0);
  assert.ok(output.secondRun.chars > 0);
  assert.ok(output.firstRun.estimatedTokens > 0);
  assert.ok(output.secondRun.estimatedTokens > 0);
  assert.equal(output.summary.totalEstimatedTokens, output.firstRun.estimatedTokens + output.secondRun.estimatedTokens);
  assert.equal(output.summary.totalChars, output.firstRun.chars + output.secondRun.chars);
  assert.equal(output.summary.durationDelta, output.durationDelta);
  assert.equal(output.summary.estimatedTokenDelta, output.estimatedTokenDelta);
  assert.equal(typeof output.wallDurationDelta, "number");
  assert.equal(typeof output.wallSpeedupPercent, "number");
  assert.equal(typeof output.charsDelta, "number");
  assert.equal(typeof output.estimatedTokenDelta, "number");
});
