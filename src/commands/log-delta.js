import fs from "node:fs";
import path from "node:path";

import { summarizeLogText } from "./errors-from-log.js";
import {
  MAX_INCREMENTAL_LOG_BYTES,
  readIncrementalBytes,
  resetIncrementalLogCursor
} from "../core/incremental-log.js";
import { fail } from "../core/output.js";
import { resolveInsideWorkspace } from "../core/workspace.js";

const PROTOCOL_VERSION = "agentshell.log-delta.v1";
const MAX_ERRORS = 12;
const MAX_STATUS_CHANGES = 16;
const MAX_MESSAGE_CHARS = 180;

const STATUS_PATTERNS = [
  { kind: "ready", level: "success", regex: /\b(?:ready|listening|started|healthy|up and running)\b/i },
  { kind: "completed", level: "success", regex: /\b(?:passed|succeeded|success(?:ful)?|completed|finished)\b/i },
  { kind: "retrying", level: "warning", regex: /\b(?:retrying|retry attempt|reconnecting|backoff)\b/i },
  { kind: "restarting", level: "warning", regex: /\b(?:restarting|restart scheduled|watching for changes|rebuilding)\b/i },
  { kind: "degraded", level: "warning", regex: /\b(?:warning|warn|degraded|unhealthy)\b/i },
  { kind: "failed", level: "error", regex: /\b(?:failed|fatal|crashed|terminated|killed)\b/i },
  { kind: "stopped", level: "info", regex: /\b(?:stopped|shut(?:ting)? down|exited)\b/i }
];

export async function logDelta(root, file, options = {}) {
  const parsed = parseLogDeltaOptions(file, options);
  if (!parsed.ok) return parsed;

  const resolved = resolveInsideWorkspace(root, parsed.value.path);
  if (!resolved.ok) return fail(resolved.reason, `Cannot inspect ${parsed.value.path}`);

  if (parsed.value.reset) {
    const reset = resetIncrementalLogCursor(root, resolved.absTarget, {
      consumerId: parsed.value.consumerId
    });
    return {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      compact: parsed.value.compact,
      action: "reset",
      source: { path: resolved.relative },
      cursor: { id: reset.cursorId, wasPresent: reset.wasPresent },
      suggestedNextActions: [
        { command: `agentshell log delta ${quoteArgument(resolved.relative)} --compact`, reason: "Read this log from the beginning on the next call" }
      ]
    };
  }

  if (!fs.existsSync(resolved.absTarget)) {
    return fail("FILE_NOT_FOUND", `File not found: ${parsed.value.path}`, { path: resolved.relative, exists: false });
  }

  const safeTarget = realFileInsideRoot(resolved.absRoot, resolved.absTarget);
  if (!safeTarget.ok) return fail(safeTarget.code, `Cannot inspect ${parsed.value.path}`);
  let stat;
  try {
    stat = fs.statSync(safeTarget.path);
  } catch {
    return fail("LOG_READ_FAILED", `Log changed before it could be inspected: ${parsed.value.path}`);
  }
  if (!stat.isFile()) return fail("NOT_A_FILE", `Not a file: ${parsed.value.path}`);

  let delta;
  try {
    delta = readIncrementalBytes(resolved.absRoot, safeTarget.path, {
      maxBytes: parsed.value.maxBytes,
      cursorKeyPath: resolved.absTarget,
      cursor: parsed.value.cursor,
      consumerId: parsed.value.consumerId
    });
  } catch (error) {
    if (["INVALID_MAX_BYTES", "INVALID_CURSOR", "INVALID_CONSUMER_ID"].includes(error?.code)) {
      return fail("INVALID_ARGUMENT", error.message);
    }
    return fail("LOG_READ_FAILED", `Log changed before its new bytes could be read: ${parsed.value.path}`);
  }

  const text = delta.buffer.toString("utf8");
  const errorSummary = summarizeLogText(text, { compact: true, root: resolved.absRoot });
  const errors = errorSummary.errors.slice(0, MAX_ERRORS).map(compactError);
  const statusChanges = extractStatusChanges(text);
  const summary = {
    newBytes: delta.bytesRead,
    newLines: countLines(text),
    errorCount: errorSummary.summary.errorCount,
    returnedErrors: errors.length,
    statusChangeCount: statusChanges.length,
    noChanges: delta.bytesRead === 0
  };

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: parsed.value.compact,
    action: "read",
    source: {
      path: resolved.relative,
      sizeBytes: delta.sizeBytes,
      readBytes: delta.bytesRead,
      maxBytes: delta.maxBytes,
      capped: delta.capped
    },
    cursor: {
      id: delta.cursorId,
      token: delta.cursor,
      previousOffset: delta.previousOffset,
      nextOffset: delta.nextOffset,
      resetReason: delta.resetReason,
      recovered: delta.cursorRecovered,
      moreAvailable: delta.moreAvailable
    },
    summary,
    errors,
    statusChanges,
    suggestedNextActions: nextActions(resolved.relative, delta, errors, statusChanges, parsed.value.consumerId)
  };
}

export function parseLogDeltaOptions(file, options = {}) {
  if (!file || String(file).startsWith("--")) {
    return fail("INVALID_ARGUMENT", "Usage: agentshell log delta <file> [--cursor CURSOR] [--max-bytes N] [--reset] --compact");
  }
  const maxBytes = options.maxBytes === undefined ? undefined : Number(options.maxBytes);
  if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_INCREMENTAL_LOG_BYTES)) {
    return fail("INVALID_ARGUMENT", `--max-bytes must be an integer between 1 and ${MAX_INCREMENTAL_LOG_BYTES}`);
  }
  return {
    ok: true,
    value: {
      path: String(file),
      compact: options.compact === undefined ? true : Boolean(options.compact),
      reset: Boolean(options.reset),
      maxBytes,
      cursor: options.cursor === undefined ? undefined : String(options.cursor),
      consumerId: Object.hasOwn(options, "consumerId")
        ? resolveConsumerId(options.consumerId)
        : resolveConsumerId(undefined)
    }
  };
}

export function extractStatusChanges(text) {
  const changes = [];
  const seen = new Set();
  const lines = String(text || "").split(/\r?\n/);

  for (let index = 0; index < lines.length && changes.length < MAX_STATUS_CHANGES; index += 1) {
    const message = cleanLine(lines[index]);
    if (!message) continue;
    if (/\b(?:0|no)\s+(?:tests?\s+)?failed\b/i.test(message)) continue;
    const pattern = STATUS_PATTERNS.find((entry) => entry.regex.test(message));
    if (!pattern) continue;
    const key = `${pattern.kind}\0${message.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    changes.push({
      kind: pattern.kind,
      level: pattern.level,
      message: limitText(message, MAX_MESSAGE_CHARS),
      line: index + 1
    });
  }
  return changes;
}

function compactError(error) {
  return {
    type: error.type,
    message: error.message,
    file: error.file,
    line: error.line,
    column: error.column,
    confidence: error.confidence
  };
}

function realFileInsideRoot(root, target) {
  let realTarget;
  try {
    realTarget = fs.realpathSync(target);
  } catch {
    return { ok: false, code: "FILE_NOT_FOUND" };
  }
  const relative = path.relative(fs.realpathSync(root), realTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return { ok: false, code: "FILE_OUTSIDE_WORKSPACE" };
  return { ok: true, path: realTarget };
}

function nextActions(file, delta, errors, statusChanges, consumerId) {
  const quoted = quoteArgument(file);
  const cursorFlag = consumerId ? "" : ` --cursor ${quoteArgument(delta.cursor)}`;
  if (delta.moreAvailable) {
    return [{ command: `agentshell log delta ${quoted}${cursorFlag} --compact`, reason: "More unread log bytes remain after the bounded read" }];
  }
  if (errors.length > 0) {
    const first = errors[0];
    if (first.file && first.line) return [{
      command: `agentshell read ${quoteArgument(first.file)} --lines ${first.line}:${first.line}`,
      reason: "Inspect the newest high-confidence failure"
    }];
    if (first.file) return [{ command: `agentshell read ${quoteArgument(first.file)} --head 120`, reason: "Inspect the newest high-confidence failure" }];
  }
  return [{
    command: `agentshell log delta ${quoted}${cursorFlag} --compact`,
    reason: statusChanges.length > 0 ? "Check for the next status transition" : "Check only bytes appended after this cursor"
  }];
}

function resolveConsumerId(value) {
  if (value === null || value === false) return null;
  if (value !== undefined && value !== "") return String(value);
  return process.env.AGENTSHELL_LOG_CONSUMER_ID
    || process.env.CODEX_THREAD_ID
    || process.env.CODEX_SESSION_ID
    || null;
}

function quoteArgument(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:@+-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

function cleanLine(value) {
  return String(value || "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function limitText(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
}

function countLines(text) {
  if (!text) return 0;
  return text.endsWith("\n") ? text.split(/\r?\n/).length - 1 : text.split(/\r?\n/).length;
}
