import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  ADAPTIVE_COVERAGE_PROTOCOL_VERSION,
  adaptiveCoverage,
  normalizeAdaptiveCoverageInput
} from "../src/core/adaptive-coverage.js";

const script = path.resolve("scripts/adaptive-coverage.js");

test("adaptive coverage ranks unsupported families and emits implementation drafts", () => {
  const observations = [
    ...observed("docker", 8, "codex"),
    ...observed("docker", 4, "claude"),
    ...observed("kubectl", 3, "codex"),
    ...observed("rg", 20, "codex", true)
  ];
  const report = adaptiveCoverage(process.cwd(), { observations });

  assert.equal(report.protocolVersion, ADAPTIVE_COVERAGE_PROTOCOL_VERSION);
  assert.equal(report.status, "candidates-available");
  assert.equal(report.summary.unsupportedObservationCount, 15);
  assert.equal(report.candidates[0].executableFamily, "docker");
  assert.equal(report.candidates[0].promotion.status, "eligible");
  assert.equal(report.candidates[0].profileDraft.match.executableFamily, "docker");
  assert.deepEqual(report.candidates[0].fixtureDraft.scenarios, [
    "successful-noisy-output", "failed-diagnostic-output", "truncated-large-output"
  ]);
  assert.equal(report.candidates.some((candidate) => candidate.executableFamily === "rg"), false);
});

test("priority ordering is deterministic and bounded", () => {
  const observations = [];
  for (let index = 0; index < 40; index += 1) {
    observations.push(...observed(`tool-${String(index).padStart(2, "0")}`, 2, "codex"));
  }
  const first = adaptiveCoverage(process.cwd(), {
    observations,
    limit: 100,
    thresholds: { candidateMinPriorityScore: 0 }
  });
  const second = adaptiveCoverage(process.cwd(), {
    observations: [...observations].reverse(),
    limit: 100,
    thresholds: { candidateMinPriorityScore: 0 }
  });

  assert.equal(first.candidates.length, 25);
  assert.equal(first.bounded.omittedCandidateCount, 15);
  assert.deepEqual(first.candidates, second.candidates);
  assert.equal(first.candidates[0].executableFamily, "tool-00");
});

test("report never exposes arguments, paths, source names, or event fingerprints", () => {
  const report = adaptiveCoverage(process.cwd(), {
    observations: [
      { executable: "curl", category: "unsupported", supportedReplacement: false, source: "private-adapter", eventFingerprint: "a".repeat(64) },
      { executable: "curl", category: "unsupported", supportedReplacement: false, source: "private-adapter-2", eventFingerprint: "b".repeat(64) }
    ],
    thresholds: { candidateMinPriorityScore: 0 }
  });
  const output = JSON.stringify(report);

  assert.doesNotMatch(output, /private-adapter|eventFingerprint|argv|stdout|stderr|\/Users\//u);
  assert.equal(report.candidates[0].sourceCount, 2);
  assert.equal(report.privacy.includesPaths, false);
});

test("raw command details and path-shaped executable families are rejected", () => {
  assert.throws(() => normalizeAdaptiveCoverageInput([{ executable: "curl", supportedReplacement: false, argv: ["curl", "secret"] }]), /privacy-safe/u);
  assert.throws(() => normalizeAdaptiveCoverageInput([{ executable: "/usr/bin/curl", supportedReplacement: false }]), /executable family/u);
});

test("workspace default reads command-observations.jsonl", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-adaptive-workspace-"));
  fs.mkdirSync(path.join(root, ".agentshell"));
  fs.writeFileSync(path.join(root, ".agentshell", "command-observations.jsonl"), `${[
    ...observed("docker", 3, "codex"),
    ...observed("rg", 2, "codex", true)
  ].map((entry, index) => JSON.stringify({ id: `obs-${index}`, createdAt: new Date().toISOString(), ...entry })).join("\n")}\n`);

  const run = spawnSync(process.execPath, [script, "--root", root, "--candidate-min-score", "0"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.summary.observationCount, 5);
  assert.equal(report.candidates[0].executableFamily, "docker");
  assert.doesNotMatch(run.stdout, new RegExp(escapeRegExp(root), "u"));
});

test("CLI accepts JSON and JSONL inputs plus promotion thresholds", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-adaptive-input-"));
  const json = path.join(root, "input.json");
  const jsonl = path.join(root, "input.jsonl");
  const input = [...observed("docker", 3, "codex"), ...observed("docker", 3, "cursor")];
  fs.writeFileSync(json, JSON.stringify({ observations: input }));
  fs.writeFileSync(jsonl, `${input.map(JSON.stringify).join("\n")}\n`);
  const args = [
    "--promotion-min-observations", "6", "--promotion-min-sources", "2",
    "--promotion-min-score", "50", "--candidate-min-score", "0", "--gate"
  ];

  for (const inputFile of [json, jsonl]) {
    const run = spawnSync(process.execPath, [script, "--input", inputFile, ...args], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.thresholds.promotionMinObservations, 6);
    assert.equal(report.summary.promotableCandidateCount, 1);
  }
});

test("CLI gate and invalid input have stable machine-readable behavior", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-adaptive-gate-"));
  const empty = path.join(root, "empty.json");
  const unsafe = path.join(root, "unsafe.json");
  fs.writeFileSync(empty, "[]\n");
  fs.writeFileSync(unsafe, JSON.stringify([{ executable: "curl", supportedReplacement: false, path: "/private/repo" }]));

  const gated = spawnSync(process.execPath, [script, "--input", empty, "--gate"], { encoding: "utf8" });
  assert.equal(gated.status, 1);
  assert.equal(JSON.parse(gated.stdout).status, "no-observations");

  const invalid = spawnSync(process.execPath, [script, "--input", unsafe], { encoding: "utf8" });
  assert.equal(invalid.status, 2);
  const error = JSON.parse(invalid.stdout);
  assert.equal(error.protocolVersion, ADAPTIVE_COVERAGE_PROTOCOL_VERSION);
  assert.equal(error.error.code, "ADAPTIVE_COVERAGE_INVALID");
  assert.doesNotMatch(invalid.stdout, /private\/repo/u);

  const missingPath = path.join(root, "private-customer-input.json");
  const missing = spawnSync(process.execPath, [script, "--input", missingPath], { encoding: "utf8" });
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stdout).error.message, "Adaptive coverage input could not be read");
  assert.doesNotMatch(missing.stdout, /private-customer-input/u);
});

test("schema fixes protocol version and bounded candidate contract", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/adaptive-coverage.schema.json", "utf8"));
  assert.equal(schema.properties.protocolVersion.const, ADAPTIVE_COVERAGE_PROTOCOL_VERSION);
  assert.equal(schema.properties.candidates.maxItems, 25);
  assert.equal(schema.properties.privacy.properties.includesRawArguments.const, false);
});

function observed(executable, count, source, supportedReplacement = false) {
  return Array.from({ length: count }, () => ({
    executable,
    category: supportedReplacement ? "search" : "unsupported",
    supportedReplacement,
    source
  }));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
