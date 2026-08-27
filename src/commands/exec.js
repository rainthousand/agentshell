import path from "node:path";

import { clipUtf8Bytes, compactEvidence, compactOutputPreview, redactCommandOutput } from "../core/compact-command-output.js";
import { boundedProcessOptions, runBoundedProcess } from "../core/bounded-process.js";
import {
  applyHighNoiseSafeDefaults,
  summarizeHighNoiseOutput
} from "../core/high-noise-profiles.js";
import { fail } from "../core/output.js";
import { newId, writeLog } from "../core/store.js";
import { summarizeLogText } from "./errors-from-log.js";

const PROTOCOL_VERSION = "agentshell.exec.v1";

export async function execCommand(root, commandArgs, options = {}) {
  const parsed = parseExecCommandArgs(commandArgs);
  if (!parsed.ok) return parsed;

  const limits = boundedProcessOptions(options);
  const prepared = applyHighNoiseSafeDefaults(parsed.value);
  const execution = await runBoundedProcess(prepared.argv, root, {
    ...limits,
    env: options.env
  });
  const stdoutBytes = Buffer.byteLength(execution.stdout, "utf8");
  const safeStdout = clipUtf8Bytes(redactCommandOutput(execution.stdout), stdoutBytes);
  const safeStderr = clipUtf8Bytes(
    redactCommandOutput(execution.stderr),
    Math.max(0, execution.outputLimitBytes - Buffer.byteLength(safeStdout, "utf8"))
  );
  const combined = [safeStderr, safeStdout].filter(Boolean).join("\n");
  const analyzed = summarizeLogText(combined, {
    compact: true,
    root,
    source: {
      kind: "command",
      path: null,
      sizeBytes: execution.observedBytes,
      readBytes: execution.capturedBytes,
      lineCount: countLines(combined),
      truncated: execution.truncated
    }
  });
  const logRef = newId("log");
  writeLog(root, logRef, safeStdout, safeStderr);

  const profileSummary = prepared.matched
    ? summarizeHighNoiseOutput(prepared.profile, combined, {
        exitCode: execution.exitCode,
        argv: prepared.argv
      })
    : null;
  const acceptedExitCodes = prepared.profile?.successExitCodes || [0];
  const ok = acceptedExitCodes.includes(execution.exitCode) && !execution.timedOut;
  const evidence = compactEvidence(analyzed.errors);
  const executable = path.basename(parsed.value[0]);
  const status = execution.timedOut ? "timeout" : (ok ? "passed" : "failed");
  const preview = prepared.profile?.family === "go" && prepared.profile.id !== "go-run"
    ? null
    : compactOutputPreview(safeStdout, safeStderr, { preferStderr: !ok });

  return {
    ok,
    protocolVersion: PROTOCOL_VERSION,
    compact: true,
    command: {
      executable,
      argumentCount: parsed.value.length - 1,
      shellInterpolation: false,
      explicitShellExecutable: isShellExecutable(executable)
    },
    profile: prepared.profile ? {
      id: prepared.profile.id,
      category: prepared.profile.category,
      family: prepared.profile.family,
      appliedDefaults: prepared.appliedDefaults,
      risk: prepared.profile.risk
    } : null,
    exitCode: execution.exitCode,
    signal: execution.signal,
    durationMs: execution.durationMs,
    timedOut: execution.timedOut,
    truncated: execution.truncated,
    logRef,
    summary: {
      status,
      headline: headlineFor(status, executable, evidence, execution),
      preview,
      errorCount: analyzed.summary.errorCount,
      returnedEvidence: evidence.length,
      capturedBytes: execution.capturedBytes,
      observedBytes: execution.observedBytes,
      outputLimitBytes: execution.outputLimitBytes
    },
    evidence,
    highNoiseSummary: profileSummary,
    privacy: {
      shellInterpolation: false,
      commandArgumentsReturned: false,
      environmentReturned: false,
      rawOutputInline: false,
      logsStoredLocally: true,
      commonSecretsRedacted: true,
      capturedOutputByteLimit: execution.outputLimitBytes
    },
    suggestedNextActions: nextActions({ execution, evidence, logRef })
  };
}

export function parseExecCommandArgs(values) {
  const args = Array.isArray(values) ? values : [];
  const separator = args.indexOf("--");
  if (separator < 0 || separator === args.length - 1) {
    return fail(
      "INVALID_ARGUMENT",
      "Usage: agentshell exec --compact -- <command...>",
      { shellInterpolation: false },
      [{ command: "agentshell exec --compact -- <command...>", reason: "Separate AgentShell options from the executable and literal arguments" }]
    );
  }
  const commandArgs = args.slice(separator + 1);
  if (commandArgs.some((value) => typeof value !== "string" || value.length === 0 || value.includes("\0"))) {
    return fail("INVALID_ARGUMENT", "Command and arguments must be non-empty strings without NUL bytes");
  }
  return { ok: true, value: commandArgs };
}

function headlineFor(status, executable, evidence, execution) {
  if (status === "timeout") return `${executable} timed out after ${execution.durationMs}ms`;
  if (status === "passed") return `${executable} completed successfully`;
  if (evidence[0]?.message) return `${executable} failed: ${evidence[0].message}`;
  return `${executable} failed with exit code ${execution.exitCode}`;
}

function nextActions({ execution, evidence, logRef }) {
  const actions = [];
  const first = evidence.find((entry) => entry.file && entry.line);
  if (first) {
    actions.push({
      command: `agentshell read ${first.file} --lines ${first.line}:${first.line}`,
      reason: "Inspect the highest-confidence failure location"
    });
  }
  if (execution.timedOut) {
    actions.push({
      command: "agentshell exec --compact -- <narrower-command...>",
      reason: "The command exceeded the timeout; narrow its scope before retrying"
    });
  }
  actions.push({
    command: `agentshell log get ${logRef} --tail 120`,
    reason: "Fetch a bounded, locally stored log tail only if the compact summary is insufficient"
  });
  return actions;
}

function isShellExecutable(executable) {
  return new Set(["sh", "bash", "zsh", "fish", "dash", "cmd", "powershell", "pwsh"]).has(executable.toLowerCase());
}

function countLines(text) {
  if (!text) return 0;
  return text.endsWith("\n") ? text.split(/\r?\n/).length - 1 : text.split(/\r?\n/).length;
}
