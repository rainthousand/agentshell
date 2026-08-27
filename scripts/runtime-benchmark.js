#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { getProjectInfo } from "../src/core/project.js";
import { getRuntimeProjectMetadata, startRuntimeDaemon } from "../src/core/runtime-daemon.js";

const PROTOCOL_VERSION = "agentshell.runtime-benchmark.v1";

export async function benchmarkRuntime(options = {}) {
  const samples = boundedInteger(options.samples, 50, 5, 500);
  const root = options.root || syntheticProject();
  const ownsRoot = !options.root;
  const runtimeDir = options.runtimeDir || `/tmp/agentshell-runtime-bench-${process.pid}`;
  const session = await startRuntimeDaemon({ runtimeDir, ttlMs: 60_000 });
  try {
    await getRuntimeProjectMetadata(root, { runtimeDir });
    const direct = measure(samples, () => getProjectInfo(root));
    const daemon = await measureAsync(samples, () => getRuntimeProjectMetadata(root, { runtimeDir }));
    return {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      samples,
      direct,
      daemon,
      comparison: {
        medianSpeedup: ratio(direct.medianMs, daemon.medianMs),
        medianSavedMs: round(direct.medianMs - daemon.medianMs)
      },
      scope: "warm in-process project metadata reads; excludes CLI cold start and command execution"
    };
  } finally {
    await session.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    if (ownsRoot) fs.rmSync(root, { recursive: true, force: true });
  }
}

function syntheticProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-runtime-project-"));
  const dependencies = Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [`package-${index}`, `1.${index}.0`]));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "runtime-benchmark",
    scripts: { test: "node --test", build: "node build.js" },
    dependencies
  }));
  return root;
}

function measure(samples, operation) {
  const values = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    operation();
    values.push(performance.now() - started);
  }
  return summarize(values);
}

async function measureAsync(samples, operation) {
  const values = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    await operation();
    values.push(performance.now() - started);
  }
  return summarize(values);
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    medianMs: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95))
  };
}

function percentile(sorted, value) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)];
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`samples must be ${minimum}-${maximum}`);
  return number;
}

function ratio(numerator, denominator) { return denominator > 0 ? round(numerator / denominator) : null; }
function round(value) { return Math.round(value * 1_000) / 1_000; }

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const index = process.argv.indexOf("--samples");
  benchmarkRuntime({ samples: index >= 0 ? process.argv[index + 1] : undefined })
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
