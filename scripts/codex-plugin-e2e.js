#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const sourceDemo = path.join(root, "examples", "noisy-test-demo");
const cli = path.join(root, "bin", "agentshell");

const legacy = runLegacyFlow();
const diagnose = runDiagnoseFlow();
const fix = runFixFlow();

const report = {
  ok: legacy.ok && diagnose.ok && fix.ok,
  legacy,
  diagnose,
  fix,
  speedPathDelta: {
    commandReduction: legacy.coreFixFlow.commandCount - diagnose.coreFixFlow.commandCount,
    commandReductionPercent: percentSaved(legacy.coreFixFlow.commandCount, diagnose.coreFixFlow.commandCount),
    outputCharsDelta: diagnose.coreFixFlow.outputChars - legacy.coreFixFlow.outputChars,
    outputTokensDelta: diagnose.coreFixFlow.estimatedTokens - legacy.coreFixFlow.estimatedTokens,
    elapsedMsDelta: diagnose.elapsedMs - legacy.elapsedMs
  },
  oneCommandFixDelta: {
    commandReduction: diagnose.coreFixFlow.commandCount - fix.coreFixFlow.commandCount,
    commandReductionPercent: percentSaved(diagnose.coreFixFlow.commandCount, fix.coreFixFlow.commandCount),
    outputCharsDelta: fix.coreFixFlow.outputChars - diagnose.coreFixFlow.outputChars,
    outputTokensDelta: fix.coreFixFlow.estimatedTokens - diagnose.coreFixFlow.estimatedTokens,
    elapsedMsDelta: fix.elapsedMs - diagnose.elapsedMs
  }
};

console.log(JSON.stringify(report, null, 2));

function runLegacyFlow() {
  const session = createSession("agentshell-codex-legacy-");
  const started = Date.now();

  const doctor = session.run(["doctor"]);
  session.run(["manual"]);
  session.run(["understand"]);
  const verifyFail = session.run(["verify", "test"], { allowFailure: true });
  session.run(["find", "createUser"]);
  const readImpl = session.run(["read", "src/user.js", "--around", "createUser"]);
  session.run(["read", "test/noisy.test.js", "--around", "Expected user.id"]);

  writeChange(session.workspace, JSON.parse(readImpl.output).hash);
  const change = session.run(["change", path.join(session.workspace, "agentshell-change.json")]);
  const verifyPass = session.run(["verify", "test"]);
  const metrics = session.run(["metrics", "--compact"]);

  return buildFlowReport({
    name: "legacy",
    workspace: session.workspace,
    elapsedMs: Date.now() - started,
    events: session.events,
    verifyFail,
    verifyPass,
    change,
    doctor,
    metrics
  });
}

function runDiagnoseFlow() {
  const session = createSession("agentshell-codex-diagnose-");
  const started = Date.now();

  const doctor = session.run(["doctor"]);
  session.run(["manual"]);
  session.run(["understand"]);
  const diagnosis = session.run(["diagnose", "test", "--compact"]);
  const diagnosisJson = JSON.parse(diagnosis.output);
  const impl = diagnosisJson.implementationReads.find((read) => read.file === "src/user.js")
    || diagnosisJson.focusedReads.find((read) => read.file === "src/user.js");
  if (!impl?.hash) throw new Error("diagnose test did not return src/user.js hash");

  const change = session.run(["change", "suggest", "--apply", "--compact"]);
  const verifyPass = session.run(["verify", "test"]);
  const runNext = session.run(["run", "next"]);
  const runStatus = session.run(["run", "status", "--compact"]);
  const metrics = session.run(["metrics", "--compact"]);

  return buildFlowReport({
    name: "diagnose",
    workspace: session.workspace,
    elapsedMs: Date.now() - started,
    events: session.events,
    verifyFail: diagnosis,
    verifyPass,
    change,
    doctor,
    runNext,
    runStatus,
    metrics
  });
}

function runFixFlow() {
  const session = createSession("agentshell-codex-fix-");
  const started = Date.now();

  const doctor = session.run(["doctor"]);
  session.run(["manual"]);
  session.run(["understand"]);
  const fix = session.run(["fix", "test", "--compact"]);
  const runStatus = session.run(["run", "status", "--compact"]);
  const metrics = session.run(["metrics", "--compact"]);

  return buildFlowReport({
    name: "fix",
    workspace: session.workspace,
    elapsedMs: Date.now() - started,
    events: session.events,
    verifyFail: fix,
    verifyPass: fix,
    change: fix,
    doctor,
    runStatus,
    metrics
  });
}

function createSession(prefix) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  copyDir(sourceDemo, workspace);
  const events = [];

  return {
    workspace,
    events,
    run(args, options = {}) {
      const started = Date.now();
      const result = spawnSync("node", [cli, ...args], {
        cwd: workspace,
        encoding: "utf8"
      });
      const durationMs = Date.now() - started;
      const output = `${result.stdout}${result.stderr}`;
      const event = {
        command: `agentshell ${args.join(" ")}`,
        status: result.status,
        output,
        durationMs
      };
      events.push(event);

      if (result.status !== 0 && !options.allowFailure) {
        throw new Error(`${event.command} failed:\n${output}`);
      }
      return event;
    }
  };
}

function writeChange(workspace, expectedHash) {
  fs.writeFileSync(path.join(workspace, "agentshell-change.json"), JSON.stringify({
    reason: "Return a deterministic id from createUser",
    edits: [{
      file: "src/user.js",
      expectedHash,
      range: { start: 2, end: 5 },
      replacement: [
        "  return {",
        "    id: `user_${input.email}`,",
        "    name: input.name,",
        "    email: input.email",
        "  };"
      ].join("\n")
    }]
  }, null, 2));
}

function buildFlowReport({ name, workspace, elapsedMs, events, verifyFail, verifyPass, change, doctor, runNext, runStatus, metrics }) {
  const outputChars = events.reduce((total, event) => total + event.output.length, 0);
  const durationMs = events.reduce((total, event) => total + event.durationMs, 0);
  const coreEvents = events.filter((event) => (
    !event.command.startsWith("agentshell doctor") &&
    !event.command.startsWith("agentshell manual") &&
    !event.command.startsWith("agentshell run next") &&
    !event.command.startsWith("agentshell run status") &&
    !event.command.startsWith("agentshell metrics")
  ));
  const coreOutputChars = coreEvents.reduce((total, event) => total + event.output.length, 0);
  const rawFailureChars = latestRawVerifyChars(workspace);

  return {
    ok: true,
    name,
    workspace,
    elapsedMs,
    commands: events.map((event) => ({
      command: event.command,
      status: event.status,
      chars: event.output.length,
      estimatedTokens: estimateTokens(event.output.length),
      durationMs: event.durationMs
    })),
    totals: {
      commandCount: events.length,
      outputChars,
      estimatedTokens: estimateTokens(outputChars),
      durationMs
    },
    coreFixFlow: {
      commandCount: coreEvents.length,
      outputChars: coreOutputChars,
      estimatedTokens: estimateTokens(coreOutputChars),
      commands: coreEvents.map((event) => event.command),
      rawFailureChars,
      rawFailureEstimatedTokens: rawFailureChars ? estimateTokens(rawFailureChars) : null,
      percentVsSingleRawFailure: rawFailureChars
        ? Math.round((1 - coreOutputChars / rawFailureChars) * 100)
        : null
    },
    firstFailure: summarizeJson(verifyFail.output),
    finalVerify: summarizeJson(verifyPass.output),
    change: summarizeJson(change.output),
    doctor: summarizeJson(doctor.output),
    runNext: runNext ? summarizeJson(runNext.output) : null,
    runStatus: runStatus ? summarizeJson(runStatus.output) : null,
    metrics: summarizeJson(metrics.output),
    rawFailureChars,
    rawFailureEstimatedTokens: rawFailureChars ? estimateTokens(rawFailureChars) : null
  };
}

function summarizeJson(output) {
  const parsed = JSON.parse(output);
  return {
    ok: parsed.ok,
    status: parsed.status || null,
    verificationOk: parsed.verificationOk ?? null,
    summary: parsed.summary || parsed.verification?.summary || null,
    relatedFiles: parsed.relatedFiles || parsed.verification?.relatedFiles || null,
    focusedReadCount: parsed.focusedReads?.length || null,
    implementationReadCount: parsed.implementationReads?.length || null,
    logRef: parsed.logRef || parsed.verification?.logRef || null,
    changedFiles: parsed.changedFiles || null,
    appliedChangedFiles: parsed.applied?.changedFiles || null,
    nextCommand: Object.hasOwn(parsed, "command") ? parsed.command : null,
    reason: parsed.reason || null,
    runSummary: parsed.summary?.runId ? parsed.summary : null,
    fixRunSummary: parsed.runSummary || null,
    finalVerification: parsed.finalVerification || null,
    reduction: parsed.reduction || null,
    totals: parsed.totals || null
  };
}

function latestRawVerifyChars(dir) {
  const historyPath = path.join(dir, ".agentshell", "history.jsonl");
  if (!fs.existsSync(historyPath)) return null;
  const operations = fs.readFileSync(historyPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const verify = operations.find((operation) => operation.type === "verify" && operation.ok === false);
  return verify?.rawOutputChars || null;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === ".agentshell") continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    if (entry.isFile()) fs.copyFileSync(source, target);
  }
}

function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}

function percentSaved(before, after) {
  return before > 0 ? Math.round((1 - after / before) * 100) : 0;
}
