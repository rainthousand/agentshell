import { spawn } from "node:child_process";

import { fail } from "../core/output.js";
import { newId, writeLog } from "../core/store.js";
import { summarizeLogText } from "./errors-from-log.js";

const PROTOCOL_VERSION = "agentshell.errors-from-command.v1";
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_BUFFER_BYTES = 1024 * 1024;

export async function errorsFromCommand(root, commandArgs, options = {}) {
  const parsed = parseCommandArgs(commandArgs);
  if (!parsed.ok) return parsed;
  const started = Date.now();
  const result = await runBounded(parsed.value, root, {
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    maxBufferBytes: options.maxBufferBytes || MAX_BUFFER_BYTES
  });
  const durationMs = Date.now() - started;
  const logRef = newId("log");
  writeLog(root, logRef, result.stdout, result.stderr);
  const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const summary = summarizeLogText(combined, {
    compact: true,
    root,
    source: {
      kind: "command",
      path: null,
      sizeBytes: Buffer.byteLength(combined, "utf8"),
      readBytes: Buffer.byteLength(combined, "utf8"),
      lineCount: combined ? combined.split(/\r?\n/).length : 0,
      truncated: result.truncated
    }
  });

  return {
    ok: result.exitCode === 0,
    protocolVersion: PROTOCOL_VERSION,
    compact: options.compact === undefined ? true : Boolean(options.compact),
    command: parsed.value.join(" "),
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs,
    timedOut: result.timedOut,
    truncated: result.truncated,
    logRef,
    summary: {
      mainError: summary.errors[0]?.message || null,
      errorCount: summary.summary.errorCount,
      returnedErrors: summary.summary.returnedErrors
    },
    errors: summary.errors,
    suggestedNextActions: suggestedNextActions(result, logRef, summary)
  };
}

function parseCommandArgs(values) {
  const separator = values.indexOf("--");
  const commandArgs = separator >= 0 ? values.slice(separator + 1) : values;
  if (commandArgs.length === 0) {
    return fail("INVALID_ARGUMENT", "Usage: agentshell errors from-command [--compact] -- <command...>");
  }
  return { ok: true, value: commandArgs };
}

function runBounded(args, cwd, options) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.AGENTSHELL_PACKAGE_ROOT;
    const child = spawn(args[0], args.slice(1), { cwd, env, shell: false });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    function append(stream, chunk) {
      const next = chunk.toString();
      const current = stream === "stdout" ? stdout : stderr;
      if (Buffer.byteLength(current, "utf8") >= options.maxBufferBytes) {
        truncated = true;
        return;
      }
      const updated = current + next;
      const clipped = clipBytes(updated, options.maxBufferBytes);
      truncated ||= clipped.length < updated.length;
      if (stream === "stdout") stdout = clipped;
      else stderr = clipped;
    }

    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, signal: null, stdout, stderr: `${stderr}\n${error.message}`.trim(), timedOut: false, truncated });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: exitCode ?? (settled ? 124 : 1), signal, stdout, stderr, timedOut: settled, truncated });
    });
  });
}

function clipBytes(value, maxBytes) {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  return buffer.subarray(0, maxBytes).toString("utf8");
}

function suggestedNextActions(result, logRef, summary) {
  const actions = [];
  if (summary.errors[0]?.file && summary.errors[0]?.line) {
    actions.push({
      command: `agentshell read ${summary.errors[0].file} --lines ${summary.errors[0].line}:${summary.errors[0].line}`,
      reason: "Inspect the first reported failure location"
    });
  }
  actions.push({
    command: `agentshell log get ${logRef} --tail 120`,
    reason: "Fetch a bounded raw log tail only if the compact error summary is insufficient"
  });
  if (result.timedOut) {
    actions.unshift({
      command: "agentshell test command --compact",
      reason: "The command timed out; inspect a narrower verification command"
    });
  }
  return actions;
}
