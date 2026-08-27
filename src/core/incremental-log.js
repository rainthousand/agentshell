import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensureState } from "./store.js";

export const DEFAULT_INCREMENTAL_LOG_BYTES = 128 * 1024;
export const MAX_INCREMENTAL_LOG_BYTES = 1024 * 1024;

const CURSOR_VERSION = 1;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_WAIT_MS = 10;
const STALE_LOCK_MS = 30000;

export function incrementalLogCursorId(root, absoluteFile, consumerId = null) {
  const consumerScope = consumerId ? consumerFingerprint(consumerId) : "stateless";
  const identity = `${canonicalPath(root)}\0${canonicalPath(absoluteFile)}\0${consumerScope}`;
  return `log_${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

export function readIncrementalBytes(root, absoluteFile, options = {}) {
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const consumerId = normalizeConsumerId(options.consumerId);
  const cursorId = incrementalLogCursorId(root, options.cursorKeyPath || absoluteFile, consumerId);
  const cursorFile = consumerId ? cursorPath(root, cursorId) : null;
  const operation = () => readWithCursor(root, absoluteFile, cursorId, cursorFile, maxBytes, options.cursor);
  return cursorFile ? withCursorLock(`${cursorFile}.lock`, operation, options) : operation();
}

function readWithCursor(root, absoluteFile, cursorId, cursorFile, maxBytes, explicitCursor) {
  const loaded = explicitCursor
    ? { cursor: decodeCursor(explicitCursor, cursorId), recovered: false }
    : cursorFile
      ? loadCursor(cursorFile, cursorId)
      : { cursor: null, recovered: false };
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(absoluteFile, flags);

  try {
    const before = fs.fstatSync(fd);
    const identity = fileIdentity(before);
    let offset = loaded.cursor?.offset || 0;
    let resetReason = null;

    if (loaded.cursor && !sameIdentity(loaded.cursor.identity, identity)) {
      offset = 0;
      resetReason = "rotation";
    } else if (before.size < offset) {
      offset = 0;
      resetReason = "truncation";
    }

    const availableBytes = Math.max(0, before.size - offset);
    const bytesToRead = Math.min(maxBytes, availableBytes);
    const buffer = Buffer.alloc(bytesToRead);
    const rawBytesRead = bytesToRead > 0 ? fs.readSync(fd, buffer, 0, bytesToRead, offset) : 0;
    const bytesRead = completeUtf8PrefixLength(buffer.subarray(0, rawBytesRead));
    const nextOffset = offset + bytesRead;
    const after = fs.fstatSync(fd);
    const moreAvailable = after.size > nextOffset;

    const cursor = {
      version: CURSOR_VERSION,
      id: cursorId,
      offset: nextOffset,
      identity: fileIdentity(after),
      updatedAt: new Date().toISOString()
    };
    if (cursorFile) writeCursor(cursorFile, cursor);

    return {
      cursorId,
      cursor: encodeCursor(cursor),
      buffer: buffer.subarray(0, bytesRead),
      previousOffset: offset,
      nextOffset,
      sizeBytes: after.size,
      availableBytes,
      bytesRead,
      maxBytes,
      capped: availableBytes > bytesRead,
      moreAvailable,
      resetReason,
      cursorRecovered: loaded.recovered
    };
  } finally {
    fs.closeSync(fd);
  }
}

function completeUtf8PrefixLength(buffer) {
  if (buffer.length === 0) return 0;
  let continuationBytes = 0;
  for (let index = buffer.length - 1; index >= 0 && continuationBytes < 3; index -= 1) {
    if ((buffer[index] & 0xc0) !== 0x80) break;
    continuationBytes += 1;
  }

  const leadIndex = buffer.length - continuationBytes - 1;
  if (leadIndex < 0) return buffer.length;
  const expected = utf8SequenceLength(buffer[leadIndex]);
  if (expected <= 1) return buffer.length;
  return continuationBytes + 1 < expected ? leadIndex : buffer.length;
}

function utf8SequenceLength(byte) {
  if ((byte & 0x80) === 0) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 1;
}

export function resetIncrementalLogCursor(root, absoluteFile, options = {}) {
  const consumerId = normalizeConsumerId(options.consumerId);
  const cursorId = incrementalLogCursorId(root, absoluteFile, consumerId);
  if (!consumerId) return { cursorId, wasPresent: false };
  const file = cursorPath(root, cursorId);
  return withCursorLock(`${file}.lock`, () => {
    const wasPresent = fs.existsSync(file);
    if (wasPresent) fs.unlinkSync(file);
    return { cursorId, wasPresent };
  }, options);
}

function normalizeMaxBytes(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_INCREMENTAL_LOG_BYTES;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_INCREMENTAL_LOG_BYTES) {
    const error = new Error(`maxBytes must be an integer between 1 and ${MAX_INCREMENTAL_LOG_BYTES}`);
    error.code = "INVALID_MAX_BYTES";
    throw error;
  }
  return parsed;
}

function cursorPath(root, cursorId) {
  const directory = path.join(ensureState(root), "log-cursors");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return path.join(directory, `${cursorId}.json`);
}

function loadCursor(file, cursorId) {
  if (!fs.existsSync(file)) return { cursor: null, recovered: false };
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!validCursor(value, cursorId)) return { cursor: null, recovered: true };
    return { cursor: value, recovered: false };
  } catch {
    return { cursor: null, recovered: true };
  }
}

function validCursor(value, cursorId) {
  return value?.version === CURSOR_VERSION
    && value?.id === cursorId
    && Number.isSafeInteger(value?.offset)
    && value.offset >= 0
    && typeof value?.identity?.dev === "string"
    && typeof value?.identity?.ino === "string";
}

function encodeCursor(cursor) {
  return Buffer.from(JSON.stringify({
    version: cursor.version,
    id: cursor.id,
    offset: cursor.offset,
    identity: cursor.identity
  })).toString("base64url");
}

function decodeCursor(value, cursorId) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (!validCursor(parsed, cursorId)) throw new Error("invalid cursor");
    return parsed;
  } catch {
    const error = new Error("Incremental log cursor is malformed or belongs to another file or consumer");
    error.code = "INVALID_CURSOR";
    throw error;
  }
}

function writeCursor(file, cursor) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(cursor)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function fileIdentity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameIdentity(left, right) {
  return left?.dev === right.dev && left?.ino === right.ino;
}

function normalizeConsumerId(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value);
  if (text.length > 256) {
    const error = new Error("consumerId must be at most 256 characters");
    error.code = "INVALID_CONSUMER_ID";
    throw error;
  }
  return text;
}

function consumerFingerprint(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function canonicalPath(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function withCursorLock(lock, callback, options) {
  const deadline = Date.now() + Number(options.lockTimeoutMs ?? LOCK_TIMEOUT_MS);
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(lock, "wx", 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (removeStaleLock(lock, options)) continue;
      if (Date.now() >= deadline) {
        const timeout = new Error(`Timed out waiting for incremental log cursor lock: ${lock}`);
        timeout.code = "INCREMENTAL_LOG_LOCK_TIMEOUT";
        throw timeout;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
    }
  }
  try {
    return callback();
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(lock, { force: true });
  }
}

function removeStaleLock(lock, options) {
  let stat;
  try {
    stat = fs.statSync(lock);
  } catch {
    return true;
  }
  if (Date.now() - stat.mtimeMs < Number(options.staleLockMs ?? STALE_LOCK_MS)) return false;
  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(lock, "utf8"));
  } catch {
    owner = null;
  }
  if (Number.isInteger(owner?.pid) && processIsAlive(owner.pid)) return false;
  try {
    fs.rmSync(lock);
    return true;
  } catch {
    return false;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
