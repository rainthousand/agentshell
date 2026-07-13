#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const demo = path.join(root, "examples", "noisy-test-demo");

const raw = run("npm", ["test"], demo);
const compact = run("node", ["../../src/cli.js", "verify", "test"], demo);
const withTail = run("node", ["../../src/cli.js", "verify", "test", "--tail", "40"], demo);
const compactOutput = JSON.parse(compact.output);
const log = run("node", ["../../src/cli.js", "log", "get", compactOutput.logRef, "--tail", "40"], demo);

const rows = {
  rawTest: measure(raw.output),
  verifyCompact: measure(compact.output),
  verifyWithTail40: measure(withTail.output),
  logGetTail40: measure(log.output)
};

const reduction = Math.round((1 - rows.verifyCompact.chars / rows.rawTest.chars) * 100);

console.log(JSON.stringify({
  ok: true,
  demo,
  reductionPercent: reduction,
  rows
}, null, 2));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8"
  });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`
  };
}

function measure(output) {
  return {
    chars: output.length,
    estimatedTokens: Math.ceil(output.length / 4)
  };
}
