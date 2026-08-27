#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-sla-"));
const sample = path.join(directory, "sample.json");
const report = path.resolve(process.env.AGENTSHELL_PERFORMANCE_REPORT || path.join(root, "artifacts", "performance-sla-report.json"));

try {
  run("performance-sla-probe.js", ["--runs", process.env.CI ? "9" : "5", "--cache-runs", "3", "--output", sample]);
  const result = run("performance-sla.js", [
    "--input", sample,
    "--gate",
    "--output", report,
    "--max-cold-start-p95-ms", process.env.AGENTSHELL_SLA_COLD_START_MS || "220",
    "--max-overhead-percent", process.env.AGENTSHELL_SLA_LAUNCHER_OVERHEAD_PERCENT || "15"
  ], false);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

function run(script, args, enforce = true) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024
  });
  if (enforce && result.status !== 0) throw new Error(result.stderr || result.stdout || `${script} failed`);
  return result;
}
