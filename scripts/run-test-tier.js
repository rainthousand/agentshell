#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_ROOT = path.join(ROOT, "tests");
const TIER_ORDER = ["fast", "integration", "release", "benchmark"];
const RULES = [
  ["benchmark", /(benchmark|performance-summary|noise-matrix|cache-benchmark|cold-start|first-round)/],
  ["release", /(release|lifecycle|install|setup-codex|v1-clean-machine|build-standalone|ci-delivery|security|share-package|marketplace)/],
  ["integration", /(adapter-|beta-funnel|codex-|dashboard|go-|mcp-|plugin-|real-project|trial-|verify-log|workspace-registry)/]
];

export function testTier(file) {
  const name = path.basename(file);
  return RULES.find(([, pattern]) => pattern.test(name))?.[0] || "fast";
}

export function listTierTests(tier, root = TEST_ROOT) {
  const files = fs.readdirSync(root)
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => path.join(root, name));
  if (tier === "all") return files;
  return files.filter((file) => testTier(file) === tier);
}

export function tierSummary(root = TEST_ROOT) {
  return Object.fromEntries(TIER_ORDER.map((tier) => [tier, listTierTests(tier, root).length]));
}

function main(argv) {
  const tier = argv[0] || "fast";
  if (![...TIER_ORDER, "all"].includes(tier)) {
    process.stderr.write(`Unknown test tier: ${tier}\n`);
    process.exitCode = 2;
    return;
  }
  const files = listTierTests(tier);
  if (argv.includes("--list")) {
    process.stdout.write(`${JSON.stringify({ tier, count: files.length, files: files.map((file) => path.relative(ROOT, file)), tiers: tierSummary() }, null, 2)}\n`);
    return;
  }
  if (files.length === 0) {
    process.stderr.write(`No tests found for tier: ${tier}\n`);
    process.exitCode = 2;
    return;
  }
  if (tier === "all") {
    for (const currentTier of TIER_ORDER) {
      process.stdout.write(`\n== AgentShell test tier: ${currentTier} ==\n`);
      const result = runTier(currentTier);
      if (result.status !== 0) {
        process.exitCode = result.status ?? 1;
        return;
      }
    }
    return;
  }
  const result = runTier(tier);
  process.exitCode = result.status ?? 1;
}

function runTier(tier) {
  const files = listTierTests(tier);
  const testArgs = ["--test"];
  // Integration and release suites share installation, daemon, and packaging
  // fixtures, so cross-file concurrency can corrupt otherwise isolated runs.
  if (["integration", "release"].includes(tier)) testArgs.push("--test-concurrency=1");
  testArgs.push(...files);
  return spawnSync(process.execPath, testArgs, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2));
}
