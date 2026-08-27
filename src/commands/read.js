import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fail } from "../core/output.js";
import { resolveInsideWorkspace } from "../core/workspace.js";

const MAX_LINES = 200;
const AROUND_CONTEXT = 40;
const MAX_FULL_READ_BYTES = 8 * 1024 * 1024;
const MAX_BOUNDED_READ_BYTES = 512 * 1024;
const MAX_CONTENT_CHARS = 64 * 1024;
const PROTOCOL_VERSION = "agentshell.read.v1";

export async function readFileRange(root, file, rangeText, readOptions = {}) {
  return readFile(root, file, { lines: rangeText }, readOptions);
}

export async function readFileAround(root, file, query, readOptions = {}) {
  return readFile(root, file, { around: query }, readOptions);
}

export async function readFileHead(root, file, count = 40, readOptions = {}) {
  return readFile(root, file, { head: count }, readOptions);
}

export async function readFileTail(root, file, count = 40, readOptions = {}) {
  return readFile(root, file, { tail: count }, readOptions);
}

async function readFile(root, file, options, readOptions) {
  const resolved = resolveInsideWorkspace(root, file);
  if (!resolved.ok) return fail(resolved.reason, `Cannot read ${file}`);

  const mode = options.head !== undefined ? "head" : options.tail !== undefined ? "tail" : options.lines ? "lines" : "around";
  const boundedCount = mode === "head" || mode === "tail" ? parseCount(options[mode]) : null;
  if ((mode === "head" || mode === "tail") && !boundedCount) {
    return fail("INVALID_RANGE", `Line count must be an integer between 1 and ${MAX_LINES}`, { maxLines: MAX_LINES });
  }

  const opened = openContainedFile(resolved, file);
  if (!opened.ok) return opened.failure;
  const { fd, stat, identity } = opened;

  try {
    readOptions._afterOpen?.({ fd, stat });
    if (!validateOpenedIdentity(resolved, identity)) return swappedFileFailure(file);
    if (!stat.isFile()) return fail("NOT_A_FILE", `Not a file: ${file}`);

    const maxWorkBytes = normalizeWorkLimit(readOptions.maxWorkBytes);
    if (mode !== "head" && mode !== "tail" && stat.size > Math.min(MAX_FULL_READ_BYTES, maxWorkBytes)) {
      return fail("FILE_TOO_LARGE", `File is too large for an unbounded ${mode} scan: ${file}`, {
        byteSize: stat.size,
        maxFullReadBytes: Math.min(MAX_FULL_READ_BYTES, maxWorkBytes)
      }, [
        { command: `agentshell read ${shellQuote(file)} --head 40`, reason: "Inspect a bounded prefix" },
        { command: `agentshell read ${shellQuote(file)} --tail 40`, reason: "Inspect a bounded suffix" }
      ]);
    }
    if (maxWorkBytes < 1 && stat.size > 0) {
      return fail("FILE_TOO_LARGE", `Read work budget is exhausted for ${file}`, { maxWorkBytes });
    }

    const window = readWindow(fd, stat.size, mode, maxWorkBytes);
    readOptions._afterRead?.({ fd, stat, window });
    if (!validateOpenedIdentity(resolved, identity) || !sameStableStat(stat, fs.fstatSync(fd))) {
      return swappedFileFailure(file);
    }

    const rawBuffer = window.buffer;
    let content = rawBuffer.toString("utf8");
    if (mode === "tail" && window.start > 0) {
      const newline = content.indexOf("\n");
      content = newline >= 0 ? content.slice(newline + 1) : "";
    }
    const windowTruncated = window.start > 0 || window.end < stat.size;
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

    const unknownTailLines = mode === "tail" && window.start > 0;
    const numbered = lines
      .slice(start - 1, end)
      .map((line, index) => unknownTailLines ? `? | ${line}` : `${start + index} | ${line}`)
      .join("\n");
    const contentResult = clipContent(numbered);
    const hashScope = windowTruncated ? "window" : "full";

    return {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      file: resolved.relative,
      hash: hashBuffer(rawBuffer),
      hashScope,
      hashBytes: rawBuffer.length,
      hashWindow: hashScope === "window" ? { start: window.start, end: window.end } : null,
      range: unknownTailLines ? null : { start, end },
      lineNumbering: {
        scope: unknownTailLines ? "unknown" : "absolute",
        reason: unknownTailLines ? "tail window excludes the file prefix" : null
      },
      matchedLine: parsed.matchedLine || null,
      totalLines: windowTruncated ? null : lines.length,
      content: contentResult.content,
      mode,
      byteSize: stat.size,
      workBytes: rawBuffer.length,
      bounded: mode === "head" || mode === "tail",
      truncated: {
        value: windowTruncated || contentResult.truncated,
        reason: contentResult.truncated
          ? "content character limit reached"
          : windowTruncated ? "bounded byte window" : null
      }
    };
  } finally {
    fs.closeSync(fd);
  }
}

function openContainedFile(resolved, displayFile) {
  let realRoot;
  let realTarget;
  try {
    realRoot = fs.realpathSync(resolved.absRoot);
    realTarget = fs.realpathSync(resolved.absTarget);
  } catch (error) {
    return {
      ok: false,
      failure: error?.code === "ENOENT"
        ? fail("FILE_NOT_FOUND", `File not found: ${displayFile}`)
        : fail("UNEXPECTED_ERROR", `Cannot securely open ${displayFile}`)
    };
  }
  if (!isInside(realRoot, realTarget)) {
    return { ok: false, failure: fail("FILE_OUTSIDE_WORKSPACE", `Cannot read ${displayFile}`) };
  }

  let fd;
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    fd = fs.openSync(realTarget, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    const identity = { realRoot, dev: stat.dev, ino: stat.ino };
    if (!validateOpenedIdentity(resolved, identity)) {
      fs.closeSync(fd);
      return { ok: false, failure: swappedFileFailure(displayFile) };
    }
    return { ok: true, fd, stat, identity };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    return {
      ok: false,
      failure: error?.code === "ENOENT"
        ? fail("FILE_NOT_FOUND", `File not found: ${displayFile}`)
        : fail("UNEXPECTED_ERROR", `Cannot securely open ${displayFile}`)
    };
  }
}

function validateOpenedIdentity(resolved, identity) {
  try {
    const realRoot = fs.realpathSync(resolved.absRoot);
    const realTarget = fs.realpathSync(resolved.absTarget);
    if (realRoot !== identity.realRoot || !isInside(realRoot, realTarget)) return false;
    const current = fs.statSync(realTarget);
    return current.dev === identity.dev && current.ino === identity.ino;
  } catch {
    return false;
  }
}

function isInside(realRoot, realTarget) {
  const relative = path.relative(realRoot, realTarget);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sameStableStat(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

function swappedFileFailure(file) {
  return fail("FILE_OUTSIDE_WORKSPACE", `File changed during secure read: ${file}`);
}

function normalizeWorkLimit(value) {
  if (value === undefined) return Number.MAX_SAFE_INTEGER;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function readWindow(fd, byteSize, mode, maxWorkBytes) {
  const bounded = mode === "head" || mode === "tail";
  const allowed = bounded
    ? Math.min(byteSize, MAX_BOUNDED_READ_BYTES, maxWorkBytes)
    : byteSize;
  const start = mode === "tail" ? Math.max(0, byteSize - allowed) : 0;
  const buffer = Buffer.alloc(allowed);
  let offset = 0;
  while (offset < allowed) {
    const bytesRead = fs.readSync(fd, buffer, offset, allowed - offset, start + offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return { buffer: buffer.subarray(0, offset), start, end: start + offset };
}

function parseCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count > 0 && count <= MAX_LINES ? count : null;
}

function clipContent(content) {
  if (content.length <= MAX_CONTENT_CHARS) return { content, truncated: false };
  return { content: `${content.slice(0, MAX_CONTENT_CHARS - 3)}...`, truncated: true };
}

function hashBuffer(buffer) {
  return `sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}`;
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
