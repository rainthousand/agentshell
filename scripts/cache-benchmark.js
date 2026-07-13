#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "src", "cli.js");

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-cache-benchmark-"));
fs.mkdirSync(path.join(fixture, "test"));
fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({
  name: "cache-benchmark-demo",
  type: "module",
  scripts: {
    test: "node test/cache-failure.js"
  }
}, null, 2));
fs.writeFileSync(path.join(fixture, "test", "cache-failure.js"), [
  "import fs from 'node:fs';",
  "const countFile = new URL('../run-count.txt', import.meta.url);",
  "const current = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;",
  "fs.writeFileSync(countFile, String(current + 1));",
  "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);",
  "for (let i = 0; i < 40; i += 1) console.log(`cache benchmark noise ${i}`);",
  "console.error('Expected cache benchmark failure in test/cache-failure.js:1');",
  "process.exit(1);",
  ""
].join("\n"));

const firstRun = runVerify(fixture);
const secondRun = runVerify(fixture);
const durationDelta = firstRun.durationMs - secondRun.durationMs;
const speedupPercent = firstRun.durationMs > 0
  ? Math.round((durationDelta / firstRun.durationMs) * 100)
  : null;
const charsDelta = firstRun.chars - secondRun.chars;
const runCountPath = path.join(fixture, "run-count.txt");
const testExecutions = fs.existsSync(runCountPath)
  ? Number(fs.readFileSync(runCountPath, "utf8"))
  : 0;
const totalChars = firstRun.chars + secondRun.chars;
const totalEstimatedTokens = firstRun.estimatedTokens + secondRun.estimatedTokens;
const totalWallDurationMs = firstRun.wallDurationMs + secondRun.wallDurationMs;
const wallDurationDelta = firstRun.wallDurationMs - secondRun.wallDurationMs;
const wallSpeedupPercent = firstRun.wallDurationMs > 0
  ? Math.round((wallDurationDelta / firstRun.wallDurationMs) * 100)
  : null;

const output = {
  ok: firstRun.cacheHit === false && secondRun.cacheHit === true && testExecutions === 1,
  fixture,
  command: "agentshell verify test",
  commandCount: 2,
  summary: {
    commands: 2,
    testExecutions,
    totalChars,
    totalEstimatedTokens,
    totalWallDurationMs,
    durationDelta,
    speedupPercent,
    wallDurationDelta,
    wallSpeedupPercent,
    charsDelta,
    estimatedTokenDelta: estimateTokens(charsDelta)
  },
  firstRun,
  secondRun,
  durationDelta,
  speedupPercent,
  wallDurationDelta,
  wallSpeedupPercent,
  charsDelta,
  estimatedTokenDelta: estimateTokens(charsDelta),
  testExecutions
};

console.log(JSON.stringify(output, null, 2));
process.exitCode = output.ok ? 0 : 1;

function runVerify(cwd) {
  const started = Date.now();
  const result = spawnSync("node", [cli, "verify", "test"], {
    cwd,
    encoding: "utf8"
  });
  const combined = `${result.stdout}${result.stderr}`;
  const parsed = JSON.parse(result.stdout);
  return {
    status: result.status,
    cacheHit: parsed.cacheHit,
    cacheKey: parsed.cacheKey,
    durationMs: parsed.durationMs,
    wallDurationMs: Date.now() - started,
    chars: combined.length,
    estimatedTokens: estimateTokens(combined.length),
    logRef: parsed.logRef
  };
}

function estimateTokens(chars) {
  return Math.ceil(Math.abs(chars) / 4) * Math.sign(chars);
}
