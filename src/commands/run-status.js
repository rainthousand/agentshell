import { clearActiveRun, readActiveRun, readRuns } from "../core/store.js";

const RUN_STATUS_PROTOCOL_VERSION = "agentshell.run-status.v1";
const RUN_NEXT_PROTOCOL_VERSION = "agentshell.run-next.v1";
const RUN_CLEAR_PROTOCOL_VERSION = "agentshell.run-clear.v1";

export async function runStatus(root, action = "status", options = {}) {
  if (action === "next") {
    return runNext(root);
  }
  if (action === "clear") {
    return runClear(root);
  }

  const run = action === "latest" ? latestRun(root) : readActiveRun(root);
  if (!run) {
    return {
      ok: true,
      protocolVersion: RUN_STATUS_PROTOCOL_VERSION,
      compact: Boolean(options.compact),
      run: null,
      summary: null
    };
  }

  return {
    ok: true,
    protocolVersion: RUN_STATUS_PROTOCOL_VERSION,
    compact: Boolean(options.compact),
    run: options.compact ? null : compactRun(run),
    summary: summarizeRun(run)
  };
}

export function runNext(root) {
  const run = readActiveRun(root);
  if (!run) {
    return {
      ok: true,
      protocolVersion: RUN_NEXT_PROTOCOL_VERSION,
      runId: null,
      status: "idle",
      command: "agentshell diagnose test --compact",
      reason: "No active run found"
    };
  }

  const summary = summarizeRun(run);
  return {
    ok: true,
    protocolVersion: RUN_NEXT_PROTOCOL_VERSION,
    runId: run.id,
    status: summary.status,
    command: summary.nextBestAction,
    reason: nextReason(summary),
    rollbackCommand: summary.rollbackCommand
  };
}

export function runClear(root) {
  const run = clearActiveRun(root);
  return {
    ok: true,
    protocolVersion: RUN_CLEAR_PROTOCOL_VERSION,
    cleared: Boolean(run),
    runId: run?.id || null,
    summary: run ? summarizeRun(run) : null
  };
}

function latestRun(root) {
  const runs = readRuns(root);
  return runs.at(-1) || readActiveRun(root);
}

function compactRun(run) {
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    nodes: run.nodes,
    commandStats: run.commandStats
  };
}

export function summarizeRun(run) {
  const outputChars = sum(run.commandStats.map((stat) => stat.outputChars || 0));
  const durationMs = sum(run.nodes.map((node) => node.durationMs || 0));
  const verify = run.nodes.findLast((node) => node.type === "verify");
  const change = run.nodes.findLast((node) => node.type === "change");
  const diagnosis = run.nodes.find((node) => node.type === "diagnose");

  return {
    runId: run.id,
    status: run.status,
    commandCount: run.commandStats.length,
    nodeCount: run.nodes.length,
    outputChars,
    estimatedTokens: Math.ceil(outputChars / 4),
    durationMs,
    diagnosis: diagnosis ? {
      verificationOk: diagnosis.verificationOk,
      logRef: diagnosis.logRef,
      confidence: diagnosis.fixPlan?.confidence || null,
      targetFile: diagnosis.fixPlan?.target?.file || null
    } : null,
    latestChange: change ? {
      ok: change.ok,
      changedFiles: change.changedFiles || []
    } : null,
    latestVerify: verify ? {
      ok: verify.ok,
      logRef: verify.logRef,
      summary: verify.summary
    } : null,
    rollbackCommand: change?.operationId ? `agentshell undo ${change.operationId}` : null,
    nextBestAction: nextBestAction(run)
  };
}

function nextBestAction(run) {
  if (run.status === "passed") return null;
  const hasChange = run.nodes.some((node) => node.type === "change" && node.ok);
  if (hasChange) return "agentshell verify test";
  const diagnosis = run.nodes.find((node) => node.type === "diagnose");
  if (diagnosis?.changeTemplate?.path) {
    return `agentshell change fill ${diagnosis.changeTemplate.path} <fill.json> --apply`;
  }
  return "agentshell diagnose test --compact";
}

function nextReason(summary) {
  if (summary.status === "passed") return "Run already passed";
  if (summary.latestChange?.ok) return "A change was applied and should be verified";
  if (summary.diagnosis?.targetFile) return `Diagnosis points to ${summary.diagnosis.targetFile}`;
  return "Start with compact test diagnosis";
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}
