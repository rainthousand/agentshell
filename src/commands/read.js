import fs from "node:fs";
import crypto from "node:crypto";
import { fail } from "../core/output.js";
import { resolveInsideWorkspace } from "../core/workspace.js";
import { sha256 } from "../core/hash.js";

const MAX_LINES = 200;
const AROUND_CONTEXT = 40;
const MAX_FULL_READ_BYTES = 8 * 1024 * 1024;
const MAX_BOUNDED_READ_BYTES = 512 * 1024;
const MAX_CONTENT_CHARS = 64 * 1024;
const PROTOCOL_VERSION = "agentshell.read.v1";

export async function readFileRange(root, file, rangeText) {
  return readFile(root, file, { lines: rangeText });
}

export async function readFileAround(root, file, query) {
  return readFile(root, file, { around: query });
}

export async function readFileHead(root, file, count = 40) {
  return readFile(root, file, { head: count });
}

export async function readFileTail(root, file, count = 40) {
  return readFile(root, file, { tail: count });
}

async function readFile(root, file, options) {
  const resolved = resolveInsideWorkspace(root, file);
  if (!resolved.ok) return fail(resolved.reason, `Cannot read ${file}`);
  if (!fs.existsSync(resolved.absTarget)) return fail("FILE_NOT_FOUND", `File not found: ${file}`);
  const stat = fs.statSync(resolved.absTarget);
  if (!stat.isFile()) return fail("NOT_A_FILE", `Not a file: ${file}`);

  const mode = options.head !== undefined ? "head" : options.tail !== undefined ? "tail" : options.lines ? "lines" : "around";
  const boundedCount = mode === "head" || mode === "tail" ? parseCount(options[mode]) : null;
  if ((mode === "head" || mode === "tail") && !boundedCount) {
    return fail("INVALID_RANGE", `Line count must be an integer between 1 and ${MAX_LINES}`, { maxLines: MAX_LINES });
  }
  if (stat.size > MAX_FULL_READ_BYTES && mode !== "head" && mode !== "tail") {
    return fail("FILE_TOO_LARGE", `File is too large for an unbounded ${mode} scan: ${file}`, {
      byteSize: stat.size,
      maxFullReadBytes: MAX_FULL_READ_BYTES
    }, [
      { command: `agentshell read ${shellQuote(file)} --head 40`, reason: "Inspect a bounded prefix" },
      { command: `agentshell read ${shellQuote(file)} --tail 40`, reason: "Inspect a bounded suffix" }
    ]);
  }

  const content = mode === "head" || mode === "tail"
    ? readBoundedContent(resolved.absTarget, stat.size, mode)
    : fs.readFileSync(resolved.absTarget, "utf8");
  const windowTruncated = stat.size > Buffer.byteLength(content);
  const lines = content.split(/\r?\n/);
  const parsed = mode === "head"
    ? { start: 1, end: Math.min(lines.length, boundedCount) }
    : mode === "tail"
      ? { start: Math.max(1, lines.length - boundedCount + 1), end: lines.length }
      : options.lines ? parseRange(options.lines) : rangeAround(lines, options.around);
  if (!parsed) {
    return options.lines
      ? fail("INVALID_RANGE", "Line range must look like A:B")
      : fail("QUERY_NOT_FOUND", `Query not found in ${file}`, {}, [{
        command: `agentshell find ${JSON.stringify(options.around)}`,
        reason: "Search the workspace for the query"
      }]);
  }

  const start = Math.max(1, parsed.start);
  const end = Math.min(lines.length, parsed.end);
  const count = end - start + 1;

  if (count < 1) return fail("INVALID_RANGE", "Line range is empty");
  if (count > MAX_LINES) {
    return fail("RANGE_TOO_LARGE", `Read range is ${count} lines; max is ${MAX_LINES}`, {
      maxLines: MAX_LINES
    }, [{
      command: `agentshell read ${file} --lines ${start}:${start + MAX_LINES - 1}`,
      reason: "Read a smaller range"
    }]);
  }

  const sourceStart = mode === "tail" && stat.size > Buffer.byteLength(content)
    ? Math.max(1, estimateTailStartLine(resolved.absTarget, stat.size))
    : 1;
  const numbered = lines
    .slice(start - 1, end)
    .map((line, index) => `${sourceStart + start + index - 1} | ${line}`)
    .join("\n");
  const contentResult = clipContent(numbered);
  const actualStart = sourceStart + start - 1;
  const actualEnd = sourceStart + end - 1;

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    file: resolved.relative,
    hash: hashFile(resolved.absTarget, content, stat.size, windowTruncated),
    range: { start: actualStart, end: actualEnd },
    matchedLine: parsed.matchedLine || null,
    totalLines: windowTruncated ? null : lines.length,
    content: contentResult.content,
    mode,
    byteSize: stat.size,
    bounded: mode === "head" || mode === "tail",
    truncated: {
      value: windowTruncated || contentResult.truncated,
      reason: contentResult.truncated
        ? "content character limit reached"
        : windowTruncated ? "bounded byte window" : null
    }
  };
}

function parseCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count > 0 && count <= MAX_LINES ? count : null;
}

function readBoundedContent(file, byteSize, mode) {
  const length = Math.min(byteSize, MAX_BOUNDED_READ_BYTES);
  const start = mode === "tail" ? Math.max(0, byteSize - length) : 0;
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    let content = buffer.subarray(0, bytesRead).toString("utf8");
    if (mode === "tail" && start > 0) {
      const newline = content.indexOf("\n");
      content = newline >= 0 ? content.slice(newline + 1) : "";
    }
    return content;
  } finally {
    fs.closeSync(fd);
  }
}

function estimateTailStartLine(file, byteSize) {
  if (byteSize <= MAX_BOUNDED_READ_BYTES) return 1;
  const fd = fs.openSync(file, "r");
  try {
    let position = 0;
    let newlines = 0;
    const buffer = Buffer.alloc(64 * 1024);
    const end = Math.max(0, byteSize - MAX_BOUNDED_READ_BYTES);
    while (position < end) {
      const length = Math.min(buffer.length, end - position);
      const bytesRead = fs.readSync(fd, buffer, 0, length, position);
      if (!bytesRead) break;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] === 10) newlines += 1;
      }
      position += bytesRead;
    }
    return newlines + 2;
  } finally {
    fs.closeSync(fd);
  }
}

function clipContent(content) {
  if (content.length <= MAX_CONTENT_CHARS) return { content, truncated: false };
  return { content: `${content.slice(0, MAX_CONTENT_CHARS - 3)}...`, truncated: true };
}

function hashFile(file, content, byteSize, windowTruncated) {
  if (!windowTruncated) return sha256(content);
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(256 * 1024);
    let position = 0;
    while (position < byteSize) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  return `sha256:${hash.digest("hex")}`;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function parseRange(text) {
  const match = /^(\d+):(\d+)$/.exec(text || "");
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) return null;
  return { start, end };
}

function rangeAround(lines, query) {
  if (!query) return null;
  const matchedIndex = lines.findIndex((line) => line.includes(query));
  if (matchedIndex < 0) return null;
  const matchedLine = matchedIndex + 1;
  return {
    start: Math.max(1, matchedLine - AROUND_CONTEXT),
    end: Math.min(lines.length, matchedLine + AROUND_CONTEXT),
    matchedLine
  };
}
