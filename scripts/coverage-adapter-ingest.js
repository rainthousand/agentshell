#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ingestExternalCommandObservations } from "../src/core/command-coverage.js";

const usage = "node scripts/coverage-adapter-ingest.js [--root <project>] [--input <payload.json>] [--source <adapter>]";

export function ingestAdapterPayload(root, payload, options = {}) {
  return ingestExternalCommandObservations(path.resolve(root), payload, options);
}

function parseArgs(argv) {
  const result = { root: process.cwd(), input: null, source: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (["--root", "--input", "--source"].includes(argument)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      result[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function readPayload(input) {
  const text = input ? fs.readFileSync(path.resolve(input), "utf8") : fs.readFileSync(0, "utf8");
  if (!text.trim()) throw new Error("Adapter observation payload is empty");
  return JSON.parse(text);
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage}\n`);
      return;
    }
    const report = ingestAdapterPayload(options.root, readPayload(options.input), { source: options.source });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.ok) process.exitCode = 2;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: {
        code: "ADAPTER_OBSERVATION_INVALID",
        message: error.message,
        suggestedNextActions: [{ command: usage, reason: "Review the privacy-safe adapter integration contract" }]
      }
    })}\n`);
    process.exitCode = 2;
  }
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) main();
