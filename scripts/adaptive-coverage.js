#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADAPTIVE_COVERAGE_PROTOCOL_VERSION,
  adaptiveCoverage,
  normalizeAdaptiveCoverageInput
} from "../src/core/adaptive-coverage.js";

const USAGE = "node scripts/adaptive-coverage.js [--root <workspace>] [--input <observations.json|jsonl>] [--limit N] [--candidate-min-observations N] [--candidate-min-score N] [--promotion-min-observations N] [--promotion-min-sources N] [--promotion-min-score N] [--gate]";

export function parseAdaptiveCoverageArgs(argv) {
  const options = { root: process.cwd(), input: null, limit: 10, gate: false, thresholds: {} };
  const thresholdFlags = {
    "--candidate-min-observations": "candidateMinObservations",
    "--candidate-min-score": "candidateMinPriorityScore",
    "--promotion-min-observations": "promotionMinObservations",
    "--promotion-min-sources": "promotionMinSources",
    "--promotion-min-score": "promotionMinPriorityScore"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--gate") {
      options.gate = true;
      continue;
    }
    if (["--root", "--input", "--limit"].includes(argument) || thresholdFlags[argument]) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--root" || argument === "--input") options[argument.slice(2)] = path.resolve(value);
      else if (argument === "--limit") options.limit = numericValue(value, argument);
      else options.thresholds[thresholdFlags[argument]] = numericValue(value, argument);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

export function readAdaptiveCoverageInput(file) {
  const text = fs.readFileSync(path.resolve(file), "utf8");
  if (!text.trim()) throw new Error("Adaptive coverage input is empty");
  try {
    return normalizeAdaptiveCoverageInput(JSON.parse(text));
  } catch (error) {
    if (!looksLikeJsonLines(text)) throw error;
    return normalizeAdaptiveCoverageInput(text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line)));
  }
}

export function runAdaptiveCoverage(options) {
  const observations = options.input ? readAdaptiveCoverageInput(options.input) : undefined;
  return adaptiveCoverage(options.root, {
    observations,
    limit: options.limit,
    thresholds: options.thresholds
  });
}

function main() {
  try {
    const options = parseAdaptiveCoverageArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    const report = runAdaptiveCoverage(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (options.gate && report.summary.promotableCandidateCount === 0) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      protocolVersion: ADAPTIVE_COVERAGE_PROTOCOL_VERSION,
      error: {
        code: "ADAPTIVE_COVERAGE_INVALID",
        message: safeErrorMessage(error),
        suggestedNextActions: [{ action: "review-input-contract", reason: "Use privacy-safe command observations and valid numeric thresholds" }]
      }
    })}\n`);
    process.exitCode = 2;
  }
}

function numericValue(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${flag} requires a number`);
  return number;
}

function looksLikeJsonLines(text) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.length > 1 && lines.every((line) => line.startsWith("{") && line.endsWith("}"));
}

function safeErrorMessage(error) {
  if (error?.code && ["ENOENT", "EACCES", "EISDIR"].includes(error.code)) {
    return "Adaptive coverage input could not be read";
  }
  if (error instanceof SyntaxError) return "Adaptive coverage input is not valid JSON or JSONL";
  const message = typeof error?.message === "string" ? error.message : "Adaptive coverage request is invalid";
  return message.length <= 240 ? message : `${message.slice(0, 237)}...`;
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) main();
