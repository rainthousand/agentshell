import fs from "node:fs";
import path from "node:path";

import { fail } from "../core/output.js";
import { resolveInsideWorkspace } from "../core/workspace.js";

const PROTOCOL_VERSION = "agentshell.errors-from-log.v1";
const MAX_LOG_BYTES = 512 * 1024;
const MAX_ERRORS = 20;
const MAX_SNIPPET_CHARS = 280;
const CONTEXT_BEFORE_LINES = 0;
const CONTEXT_AFTER_LINES = 4;

const ERROR_LINE_PATTERNS = [
  { type: "assertion", regex: /\bAssertionError(?:\s+\[[^\]]+\])?:?\s*(.*)$/ },
  { type: "node-error", regex: /\b(?:Error|TypeError|ReferenceError|SyntaxError|RangeError):\s*(.+)$/ },
  { type: "panic", regex: /\bpanic:\s*(.+)$/ },
  { type: "tap-fail", regex: /^(?:#\s*)?not ok\b(?:\s+\d+)?(?:\s*[-:]\s*(.+))?/ },
  { type: "go-test-fail", regex: /^--- FAIL:\s+(\S+)(?:\s+\([^)]+\))?/ },
  { type: "go-test-fail", regex: /^FAIL(?:\s+(.+))?$/ }
];

export async function errorsFromLog(root, file, options = {}) {
  const parsed = parseErrorsFromLogOptions(file, options);
  if (!parsed.ok) return parsed;

  if (parsed.value.path === "-") {
    return summarizeLogText(String(options.stdin || ""), {
      compact: parsed.value.compact,
      source: {
        kind: "stdin",
        path: "-",
        sizeBytes: Buffer.byteLength(String(options.stdin || ""), "utf8"),
        readBytes: Buffer.byteLength(String(options.stdin || ""), "utf8"),
        lineCount: countLines(String(options.stdin || "")),
        truncated: false
      }
    });
  }

  const resolved = resolveInsideWorkspace(root, parsed.value.path);
  if (!resolved.ok) return fail(resolved.reason, `Cannot inspect ${parsed.value.path}`);
  if (!fs.existsSync(resolved.absTarget)) {
    return fail("FILE_NOT_FOUND", `File not found: ${parsed.value.path}`, {
      path: resolved.relative,
      exists: false
    });
  }

  const stat = fs.statSync(resolved.absTarget);
  if (!stat.isFile()) return fail("NOT_A_FILE", `Not a file: ${parsed.value.path}`);

  const buffer = readLogPrefix(resolved.absTarget);
  const text = buffer.toString("utf8");
  return summarizeLogText(text, {
    compact: parsed.value.compact,
    source: {
      kind: "file",
      path: resolved.relative,
      sizeBytes: stat.size,
      readBytes: buffer.length,
      lineCount: countLines(text),
      truncated: stat.size > buffer.length
    },
    root: resolved.absRoot
  });
}

export function parseErrorsFromLogOptions(file, options = {}) {
  if (!file || String(file).startsWith("--")) {
    return fail("INVALID_ARGUMENT", "Usage: agentshell errors from-log <file> --compact");
  }
  return {
    ok: true,
    value: {
      path: String(file),
      compact: options.compact === undefined ? true : Boolean(options.compact)
    }
  };
}

export function summarizeLogText(text, options = {}) {
  const lines = String(text || "").split(/\r?\n/);
  const allErrors = extractErrors(lines, options.root || null);
  const errors = allErrors.slice(0, MAX_ERRORS);
  const omittedErrors = Math.max(0, allErrors.length - errors.length);
  const summary = {
    errorCount: errors.length + omittedErrors,
    returnedErrors: errors.length,
    omittedErrors,
    truncated: Boolean(options.source?.truncated)
  };

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: options.compact === undefined ? true : Boolean(options.compact),
    source: options.source || {
      kind: "text",
      path: null,
      sizeBytes: Buffer.byteLength(String(text || ""), "utf8"),
      readBytes: Buffer.byteLength(String(text || ""), "utf8"),
      lineCount: countLines(String(text || "")),
      truncated: false
    },
    summary,
    errors,
    suggestedNextActions: suggestedNextActions(errors, summary)
  };
}

function extractErrors(lines, root) {
  const errors = [];
  const seen = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const cleanLine = cleanLogLine(rawLine);
    const pattern = ERROR_LINE_PATTERNS.find((entry) => entry.regex.test(cleanLine));
    const goLocation = parseGoDiagnostic(cleanLine, root);
    const stackLocation = parseStackLocation(cleanLine, root);

    if (!pattern && !goLocation && !stackLocation) continue;

    const matched = pattern ? cleanLine.match(pattern.regex) : null;
    const lookahead = lines.slice(index + 1, index + 8).map(cleanLogLine);
    const location = goLocation || stackLocation || firstLocation(lookahead, root);
    const message = messageFor({
      line: cleanLine,
      match: matched,
      type: pattern?.type || "stack",
      lookahead,
      goLocation
    });
    const type = pattern?.type || (goLocation ? "go-diagnostic" : "stack");

    const error = {
      message: trimMessage(message),
      type,
      file: location?.file || null,
      line: location?.line || null,
      column: location?.column || null,
      confidence: confidenceFor(type, location),
      snippet: snippetFor(lines, index)
    };
    const key = [error.type, error.message, error.file, error.line].join("\x1f");
    if (seen.has(key)) continue;
    seen.add(key);
    errors.push(error);
  }

  return errors;
}

function messageFor({ line, match, type, lookahead, goLocation }) {
  if (goLocation?.message) return goLocation.message;
  if (type === "tap-fail") {
    const nested = lookahead.find((entry) => /\b(?:AssertionError|Error|TypeError|ReferenceError|SyntaxError|RangeError):/.test(entry));
    return nested || match?.[1] || line;
  }
  if (type === "go-test-fail") {
    const nested = lookahead.find((entry) => /^\S+\.go:\d+:\s+/.test(entry) || /^\s+\S+\.go:\d+:\s+/.test(entry));
    const detail = nested ? parseGoDiagnostic(nested)?.message : null;
    return detail ? `${match?.[1] || "go test"} failed: ${detail}` : line;
  }
  return match?.[1] || line;
}

function parseGoDiagnostic(line, root = null) {
  const match = line.match(/^\s*(\S+\.go):(\d+):(?:\s*(.+))?$/);
  if (!match) return null;
  return {
    file: normalizeLogPath(match[1], root),
    line: Number(match[2]),
    column: null,
    message: match[3] || line.trim()
  };
}

function firstLocation(lines, root) {
  for (const line of lines) {
    const stack = parseStackLocation(line, root);
    if (stack) return stack;
    const go = parseGoDiagnostic(line, root);
    if (go) return go;
    const fileLocation = parseFileLocation(line, root);
    if (fileLocation) return fileLocation;
  }
  return null;
}

function parseStackLocation(line, root) {
  const match = line.match(/\bat\s+(?:.+?\s+\()?(.+?):(\d+):(\d+)\)?$/);
  if (!match) return null;
  return {
    file: normalizeLogPath(match[1], root),
    line: Number(match[2]),
    column: Number(match[3])
  };
}

function parseFileLocation(line, root) {
  const match = line.match(/([./~\w:-][^:\s()]*\.[A-Za-z0-9]+):(\d+)(?::(\d+))?/);
  if (!match) return null;
  return {
    file: normalizeLogPath(match[1], root),
    line: Number(match[2]),
    column: match[3] ? Number(match[3]) : null
  };
}

function normalizeLogPath(value, root) {
  let clean = String(value || "")
    .replace(/^file:\/\//, "")
    .replace(/^webpack:\/\/\/?/, "")
    .trim();
  if (root && path.isAbsolute(clean)) {
    const relative = path.relative(root, clean);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) clean = relative;
  }
  return clean || null;
}

function snippetFor(lines, index) {
  const start = Math.max(0, index - CONTEXT_BEFORE_LINES);
  const end = Math.min(lines.length, index + CONTEXT_AFTER_LINES + 1);
  return limitText(lines.slice(start, end).map(cleanLogLine).filter(Boolean).join("\n"), MAX_SNIPPET_CHARS);
}

function cleanLogLine(line) {
  return String(line || "")
    .replace(/^\s*#\s?/, "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trimEnd();
}

function trimMessage(message) {
  return limitText(String(message || "Unknown error").trim(), 180);
}

function limitText(value, maxLength) {
  const text = String(value || "").replace(/\s+\n/g, "\n").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function confidenceFor(type, location) {
  if (location && ["assertion", "node-error", "panic", "go-test-fail"].includes(type)) return 0.95;
  if (["assertion", "node-error", "panic", "go-test-fail", "tap-fail"].includes(type)) return 0.85;
  return location ? 0.75 : 0.6;
}

function suggestedNextActions(errors, summary) {
  if (errors.length === 0) {
    return [
      { command: "agentshell verify test --compact", reason: "No recognized error pattern was found in the log" }
    ];
  }
  const first = errors[0];
  const target = first.file && first.line ? `${first.file}:${first.line}` : first.file || "<reported file>";
  const actions = [
    { command: `agentshell read ${target}`, reason: "Inspect the highest-confidence failure location" }
  ];
  if (summary.truncated) {
    actions.push({ command: "agentshell errors from-log <full-log> --compact", reason: "The input log was truncated before analysis" });
  }
  return actions;
}

function readLogPrefix(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(MAX_LOG_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, MAX_LOG_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function countLines(text) {
  if (!text) return 0;
  return text.endsWith("\n") ? text.split(/\r?\n/).length - 1 : text.split(/\r?\n/).length;
}
