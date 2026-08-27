import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import {
  classifyExternalCommand,
  commandCoverage,
  ingestExternalCommandObservations,
  observeExternalCommand,
  readCommandObservations,
  resetCommandCoverage
} from "../src/core/command-coverage.js";
import { appendEvent } from "../src/core/store.js";
import { metrics } from "../src/commands/metrics.js";

const cli = path.resolve("src/cli.js");
const adapterIngest = path.resolve("scripts/coverage-adapter-ingest.js");

test("external command classification covers common inspection and test fallbacks", () => {
  assert.deepEqual(classifyExternalCommand(["rg", "secret", "."]), {
    ok: true,
    executable: "rg",
    category: "search",
    supportedReplacement: true,
    replacement: "agentshell grep <query> --compact"
  });
  assert.equal(classifyExternalCommand(["go", "test", "./..."]).replacement, "agentshell verify test --compact");
  assert.equal(classifyExternalCommand(["go", "list", "./..."]).replacement, "agentshell exec --compact -- go list <args...>");
  assert.equal(classifyExternalCommand(["go", "mod", "graph"]).replacement, "agentshell exec --compact -- go mod graph <args...>");
  assert.equal(classifyExternalCommand(["go", "tool", "pprof", "cpu.pprof"]).category, "go-performance");
  assert.equal(classifyExternalCommand(["govulncheck", "./..."]).category, "go-security");
  assert.equal(classifyExternalCommand(["golangci-lint", "run"]).supportedReplacement, true);
  assert.equal(classifyExternalCommand(["git", "status", "--short"]).replacement, "agentshell git status --compact");
  assert.equal(classifyExternalCommand(["curl", "https://example.test"]).supportedReplacement, false);
  assert.equal(classifyExternalCommand(["agentshell", "grep", "x"]).ok, false);
});

test("coverage stores only privacy-safe command families and computes a real denominator", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-coverage-"));
  appendEvent(root, { command: "grep", ok: true, outputChars: 40, estimatedTokens: 10 });
  appendEvent(root, { command: "verify", ok: true, outputChars: 80, estimatedTokens: 20 });

  observeExternalCommand(root, ["rg", "private-token", "/private/workspace"], { source: "Codex Desktop" });
  observeExternalCommand(root, ["curl", "https://secret.test/api?token=abc"], { source: "Codex Desktop" });

  const observations = readCommandObservations(root);
  assert.equal(observations.length, 2);
  assert.equal(observations[0].source, "codex-desktop");
  assert.equal(observations[0].executable, "rg");
  const stored = fs.readFileSync(path.join(root, ".agentshell", "command-observations.jsonl"), "utf8");
  assert.doesNotMatch(stored, /private-token|private\/workspace|secret\.test|token=abc/);

  const report = commandCoverage(root);
  assert.equal(report.status, "available");
  assert.equal(report.totals.observedCommands, 4);
  assert.equal(report.totals.agentShellHits, 2);
  assert.equal(report.totals.externalCommands, 2);
  assert.equal(report.totals.eligibleFallbacks, 1);
  assert.equal(report.rates.commandCoveragePercent, 50);
  assert.equal(report.rates.replacementOpportunityPercent, 50);
  assert.equal(report.opportunities[0].replacement, "agentshell grep <query> --compact");

  const metricsReport = await metrics(root, { compact: true });
  assert.equal(metricsReport.measurement.coverage.externalCommandTelemetryAvailable, true);
  assert.equal(metricsReport.measurement.coverage.externalCommandCount, 2);
  assert.equal(metricsReport.measurement.coverage.commandCoveragePercent, 50);

  const reset = resetCommandCoverage(root);
  assert.equal(reset.removedObservations, 2);
  assert.equal(commandCoverage(root).rates.commandCoveragePercent, null);
});

test("coverage CLI reports unavailable external telemetry and accepts adapter observations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-coverage-cli-"));
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture","type":"module"}\n');

  const initial = spawnSync(process.execPath, [cli, "coverage", "status", "--compact"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(initial.status, 0, initial.stderr);
  const initialOutput = JSON.parse(initial.stdout);
  assert.equal(initialOutput.status, "partial");
  assert.equal(initialOutput.rates.commandCoveragePercent, null);

  const observed = spawnSync(process.execPath, [
    cli,
    "coverage",
    "observe",
    "--source",
    "codex",
    "--",
    "grep",
    "password=do-not-store",
    "."
  ], { cwd: root, encoding: "utf8" });
  assert.equal(observed.status, 0, observed.stderr);
  const observedOutput = JSON.parse(observed.stdout);
  assert.equal(observedOutput.recorded.executable, "grep");
  assert.equal(observedOutput.recorded.replacement, "agentshell grep <query> --compact");

  const report = spawnSync(process.execPath, [cli, "coverage", "--compact"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(report.status, 0, report.stderr);
  const reportOutput = JSON.parse(report.stdout);
  assert.equal(reportOutput.telemetry.externalCommandTelemetryAvailable, true);
  assert.equal(reportOutput.totals.externalCommands, 1);
});

test("command coverage schema is registered and parseable", () => {
  const schema = JSON.parse(fs.readFileSync(path.resolve("schemas/command-coverage.schema.json"), "utf8"));
  assert.equal(schema.$defs.report.properties.protocolVersion.const, "agentshell.command-coverage.v1");
  assert.equal(schema.$defs.adapterIngestPayload.properties.protocolVersion.const, "agentshell.adapter-command-observation.v1");
});

test("adapter batches dedupe stable events and persist no raw identifiers or command details", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-coverage-ingest-"));
  appendEvent(root, { command: "grep", ok: true, outputChars: 40, estimatedTokens: 10 });
  appendEvent(root, { command: "verify", ok: true, outputChars: 80, estimatedTokens: 20 });
  const payload = {
    protocolVersion: "agentshell.adapter-command-observation.v1",
    source: "codex",
    observations: [
      {
        eventId: "tool-call-secret-1",
        argv: ["rg", "password=never-store", "/private/customer/repo"],
        stdout: "private output",
        stderr: "private error"
      },
      { eventId: "tool-call-secret-1", executableFamily: "rg" },
      { eventId: "tool-call-secret-2", executableFamily: "git", operation: "status" }
    ]
  };

  const first = ingestExternalCommandObservations(root, payload);
  assert.equal(first.received, 3);
  assert.equal(first.recorded, 2);
  assert.equal(first.duplicates, 1);
  assert.equal(first.totals.observedCommands, 4);
  assert.equal(first.rates.commandCoveragePercent, 50);

  const replay = ingestExternalCommandObservations(root, payload);
  assert.equal(replay.recorded, 0);
  assert.equal(replay.duplicates, 3);
  assert.equal(commandCoverage(root).rates.commandCoveragePercent, 50);

  const stored = fs.readFileSync(path.join(root, ".agentshell", "command-observations.jsonl"), "utf8");
  assert.doesNotMatch(stored, /tool-call-secret|never-store|private|customer|stdout|stderr/);
  const observations = readCommandObservations(root);
  assert.equal(observations.length, 2);
  assert.match(observations[0].eventFingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(Object.hasOwn(observations[0], "argv"), false);
});

test("event identifiers are scoped by adapter source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-coverage-source-"));
  const observation = {
    protocolVersion: "agentshell.adapter-command-observation.v1",
    source: "host-default",
    observations: [{ eventId: "shared-id", executableFamily: "grep" }]
  };
  assert.equal(ingestExternalCommandObservations(root, observation, { source: "codex" }).recorded, 1);
  assert.equal(ingestExternalCommandObservations(root, observation, { source: "claude-code" }).recorded, 1);
  assert.equal(readCommandObservations(root).length, 2);
});

test("adapter ingest rejects invalid events transactionally", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-coverage-invalid-"));
  const invalid = ingestExternalCommandObservations(root, {
    protocolVersion: "agentshell.adapter-command-observation.v1",
    source: "codex",
    observations: [
      { eventId: "valid", executableFamily: "grep" },
      { executableFamily: "git", operation: "status" }
    ]
  });
  assert.equal(invalid.ok, false);
  assert.equal(readCommandObservations(root).length, 0);

  const self = ingestExternalCommandObservations(root, {
    protocolVersion: "agentshell.adapter-command-observation.v1",
    source: "codex",
    observations: [{ eventId: "self", executableFamily: "agentshell" }]
  });
  assert.equal(self.ok, false);
  assert.equal(readCommandObservations(root).length, 0);
});

test("adapter helper ingests stdin payload and makes replay idempotent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-coverage-helper-"));
  const payload = JSON.stringify({
    protocolVersion: "agentshell.adapter-command-observation.v1",
    source: "codex",
    observations: [{ eventId: "call-42", executableFamily: "go", operation: "test" }]
  });
  const first = spawnSync(process.execPath, [adapterIngest, "--root", root], { input: payload, encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).recorded, 1);

  const second = spawnSync(process.execPath, [adapterIngest, "--root", root], { input: payload, encoding: "utf8" });
  assert.equal(second.status, 0, second.stderr);
  const report = JSON.parse(second.stdout);
  assert.equal(report.recorded, 0);
  assert.equal(report.duplicates, 1);
  assert.equal(report.totals.externalCommands, 1);
});

test("concurrent adapter retries record one denominator event", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-coverage-concurrent-"));
  const payload = JSON.stringify({
    protocolVersion: "agentshell.adapter-command-observation.v1",
    source: "codex",
    observations: [{ eventId: "concurrent-call", executableFamily: "rg" }]
  });
  const [first, second] = await Promise.all([
    runAdapterHelper(root, payload),
    runAdapterHelper(root, payload)
  ]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(first.stdout).recorded + JSON.parse(second.stdout).recorded, 1);
  assert.equal(readCommandObservations(root).length, 1);
});

function runAdapterHelper(root, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [adapterIngest, "--root", root], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(payload);
  });
}
