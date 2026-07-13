import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildBetaFunnel,
  classifyBetaEvidence,
  renderBetaFunnelMarkdown
} from "../scripts/beta-funnel.js";

const SUCCESS = {
  ok: true,
  protocolVersion: "agentshell.trial-export.v1",
  summary: {
    trialId: "trial-success-1",
    eventCount: 3,
    finalVerificationOk: true,
    evidenceReady: true
  },
  file: "/redacted/evidence.json"
};

const REAL_FAILURE_SHAPE = {
  ok: false,
  error: {
    code: "TRIAL_NOT_READY",
    message: "No recent verified AgentShell run is ready to export.",
    details: {
      eventCount: 0,
      runStatus: "missing",
      maximumRunAgeHours: 6
    }
  }
};

test("classifies a successful trial export through every funnel stage", () => {
  const result = classifyBetaEvidence(SUCCESS);

  assert.deepEqual(result, {
    id: "attempt-1",
    inputType: "trial-export",
    stages: {
      attempted: true,
      cliAvailable: true,
      activated: true,
      verified: true,
      exported: true
    },
    failureReason: null
  });
});

test("classifies the real TRIAL_NOT_READY envelope as activation evidence missing", () => {
  const result = classifyBetaEvidence(REAL_FAILURE_SHAPE);

  assert.equal(result.inputType, "failure-envelope");
  assert.deepEqual(result.stages, {
    attempted: true,
    cliAvailable: true,
    activated: false,
    verified: false,
    exported: false
  });
  assert.equal(result.failureReason, "no-agentshell-events");
});

test("mixed evidence reaches the V1 gate at three exports and 80 percent rates", () => {
  const report = buildBetaFunnel([
    SUCCESS,
    { id: "trial-success-2", events: [{ command: "agentshell start" }], finalVerification: { ok: true } },
    {
      ok: true,
      id: "trial-success-3",
      protocolVersion: "agentshell.adapter-trial-collect.v1",
      summary: { agentShellCommands: 2 },
      trial: { commands: [{ command: "agentshell verify test" }], finalVerification: { ok: true } }
    },
    { ...SUCCESS, summary: { ...SUCCESS.summary, trialId: "trial-success-4" } },
    REAL_FAILURE_SHAPE
  ], { now: "2026-07-13T00:00:00.000Z" });

  assert.equal(report.protocolVersion, "agentshell.beta-funnel.v1");
  assert.deepEqual(report.summary.counts, {
    attempted: 5,
    cliAvailable: 5,
    activated: 4,
    verified: 4,
    exported: 4,
    distinctSuccessfulExports: 4
  });
  assert.equal(report.summary.rates.activation, 80);
  assert.equal(report.summary.rates.export, 80);
  assert.equal(report.gate.ready, true);
  assert.equal(report.gate.status, "ready");
  assert.equal(report.gate.checks.successfulExternalExports.required, 3);
  assert.deepEqual(report.summary.failureReasons, { "no-agentshell-events": 1 });
  assert.equal(JSON.stringify(report).includes("/redacted/evidence.json"), false);
  assert.equal(JSON.stringify(report).includes("agentshell start"), false);

  const markdown = renderBetaFunnelMarkdown(report);
  assert.match(markdown, /Gate: \*\*ready\*\*/);
  assert.match(markdown, /\| Exported \| 4 \| 80% \|/);
});

test("V1 gate does not count duplicate exports as distinct external evidence", () => {
  const report = buildBetaFunnel([SUCCESS, SUCCESS, SUCCESS]);

  assert.equal(report.summary.counts.exported, 3);
  assert.equal(report.summary.counts.distinctSuccessfulExports, 1);
  assert.equal(report.gate.ready, false);
  assert.equal(report.gate.checks.successfulExternalExports.actual, 1);
});

test("CLI writes redacted JSON and Markdown reports", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-beta-funnel-"));
  const successPath = path.join(root, "private-user-name-success.json");
  const failurePath = path.join(root, "private-user-name-failure.json");
  const reportPath = path.join(root, "report.json");
  const markdownPath = path.join(root, "report.md");
  fs.writeFileSync(successPath, JSON.stringify(SUCCESS));
  fs.writeFileSync(failurePath, JSON.stringify(REAL_FAILURE_SHAPE));

  const result = spawnSync(process.execPath, [
    "scripts/beta-funnel.js",
    "--input", successPath,
    "--input", failurePath,
    "--report", reportPath,
    "--markdown", markdownPath
  ], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.summary.counts.attempted, 2);
  assert.equal(JSON.stringify(report).includes(root), false);
  assert.match(fs.readFileSync(markdownPath, "utf8"), /^# AgentShell External Beta Funnel/);
});

test("rejects malformed JSON without exposing its input path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-beta-malformed-"));
  const input = path.join(root, "secret-customer-name.json");
  fs.writeFileSync(input, "{not-json");

  const result = spawnSync(process.execPath, ["scripts/beta-funnel.js", "--input", input], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.error.code, "BETA_FUNNEL_INPUT_INVALID");
  assert.equal(result.stderr.includes(root), false);
  assert.equal(result.stderr.includes("secret-customer-name"), false);
});

test("rejects structurally unrecognized evidence", () => {
  assert.throws(
    () => buildBetaFunnel([{ arbitrary: "data" }]),
    /Unrecognized beta evidence at index 0/
  );
});
