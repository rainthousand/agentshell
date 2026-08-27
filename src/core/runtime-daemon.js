import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { getProjectInfo } from "./project.js";

export const RUNTIME_PROTOCOL_VERSION = "agentshell.runtime.v1";
export const RUNTIME_SCHEMA_VERSION = 1;
export const RUNTIME_OWNERSHIP_MARKER = ".agentshell-runtime-owner.json";

const RUNTIME_OWNERSHIP_KIND = "agentshell.runtime-directory.v1";

const DEFAULT_TTL_MS = 30_000;
const MAX_TTL_MS = 5 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 750;
const MAX_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_SOCKET_PATH_BYTES = 100;
const FINGERPRINT_FILES = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "go.mod",
  "go.sum",
  "go.work",
  "go.work.sum",
  ".agentshell.json"
];
const ACTIONS = new Set(["ping", "metadata.get", "cache.invalidate", "stop"]);

export function runtimePaths(options = {}) {
  const directory = path.resolve(options.runtimeDir || path.join(os.homedir(), ".agentshell", "runtime"));
  const socketPath = path.resolve(options.socketPath || path.join(directory, "runtime.sock"));
  assertSafeRuntimePaths(directory, socketPath);
  return {
    directory,
    socketPath,
    statePath: path.join(directory, "runtime.json"),
    lockPath: path.join(directory, "runtime.lock"),
    markerPath: path.join(directory, RUNTIME_OWNERSHIP_MARKER)
  };
}

export async function startRuntimeDaemon(options = {}) {
  assertSupportedPlatform(options.platform || process.platform);
  const paths = runtimePaths(options);
  assertSocketPath(paths.socketPath);
  ensurePrivateDirectory(paths, options);

  const existing = await probeRuntime(paths, options);
  if (existing?.ok) return reusedSession(existing, paths);

  recoverStaleRuntime(paths, options);
  acquireRuntimeLock(paths, options);

  const instanceId = options.instanceId || crypto.randomUUID();
  const cache = new Map();
  const inflight = new Map();
  const stats = { requests: 0, cacheHits: 0, cacheMisses: 0, invalidations: 0 };
  const config = {
    ttlMs: boundedTtl(options.ttlMs),
    maxRequestBytes: boundedRequestBytes(options.maxRequestBytes),
    requestTimeoutMs: boundedTimeout(options.requestTimeoutMs),
    metadataReader: options.metadataReader || readProjectMetadata,
    now: options.now || Date.now
  };

  let closed = false;
  let stopRequested = false;
  let close = async () => {};
  const server = net.createServer({ allowHalfOpen: true }, (socket) => handleConnection(socket, context()));
  server.on("error", () => {});

  function context() {
    return {
      cache,
      config,
      inflight,
      instanceId,
      paths,
      server,
      stats,
      requestStop() {
        if (stopRequested) return;
        stopRequested = true;
        setImmediate(() => close());
      }
    };
  }

  try {
    await listen(server, paths.socketPath);
    fs.chmodSync(paths.socketPath, 0o600);
    const state = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      pid: process.pid,
      uid: currentUid(options.uid),
      instanceId,
      socketPath: paths.socketPath,
      startedAt: new Date(config.now()).toISOString(),
      ttlMs: config.ttlMs
    };
    writeJsonAtomic(paths.statePath, state, 0o600);

    close = async () => {
      if (closed) return;
      closed = true;
      await closeServer(server);
      releaseRuntime(paths, instanceId, options);
    };

    return {
      server,
      close,
      report: {
        ok: true,
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        running: true,
        reused: false,
        pid: process.pid,
        instanceId,
        socketPath: paths.socketPath,
        ttlMs: config.ttlMs,
        capabilities: runtimeCapabilities()
      }
    };
  } catch (error) {
    try { server.close(); } catch {}
    releaseRuntime(paths, instanceId, options);
    throw error;
  }
}

export async function runtimeStatus(options = {}) {
  const paths = runtimePaths(options);
  try {
    const response = await requestRuntime({ action: "ping" }, { ...options, paths });
    if (!response.ok) return stoppedStatus(paths, response.error?.code || "unavailable");
    return {
      ok: true,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      running: true,
      state: readJson(paths.statePath),
      runtime: response.runtime,
      stats: response.stats
    };
  } catch (error) {
    return stoppedStatus(paths, runtimeErrorCode(error));
  }
}

export async function stopRuntimeDaemon(options = {}) {
  const paths = runtimePaths(options);
  try {
    const response = await requestRuntime({ action: "stop" }, { ...options, paths });
    if (!response.ok) return { ...response, stopped: false };
    await waitForSocketRemoval(paths.socketPath, boundedTimeout(options.requestTimeoutMs));
    return { ...response, stopped: true };
  } catch (error) {
    const recovered = recoverStaleRuntime(paths, options, { quiet: true });
    return {
      ok: true,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      stopped: false,
      running: false,
      recoveredStale: recovered,
      reason: runtimeErrorCode(error)
    };
  }
}

export async function requestRuntime(request, options = {}) {
  const paths = options.paths || runtimePaths(options);
  const envelope = normalizeRequest(request, options.requestId);
  const serialized = `${JSON.stringify(envelope)}\n`;
  const maxRequestBytes = boundedRequestBytes(options.maxRequestBytes);
  if (Buffer.byteLength(serialized) > maxRequestBytes) {
    return unavailable("REQUEST_TOO_LARGE", "Runtime request exceeds the configured byte limit");
  }

  try {
    return await exchange(paths.socketPath, serialized, {
      timeoutMs: boundedTimeout(options.requestTimeoutMs),
      maxResponseBytes: options.maxResponseBytes || MAX_RESPONSE_BYTES
    });
  } catch (error) {
    return unavailable(runtimeErrorCode(error), "Runtime daemon is unavailable; use the local read-only fallback", {
      socketPath: paths.socketPath
    });
  }
}

export async function getRuntimeProjectMetadata(root, options = {}) {
  const response = await requestRuntime({ action: "metadata.get", root }, options);
  if (response.ok) return response;
  if (options.fallback === false) return response;

  try {
    const canonicalRoot = canonicalProjectRoot(root);
    const fingerprint = rootFingerprint(canonicalRoot);
    const reader = options.metadataReader || readProjectMetadata;
    const metadata = await reader(canonicalRoot);
    return {
      ok: true,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      source: "fallback",
      cache: { hit: false, ttlMs: 0, expiresAt: null },
      root: canonicalRoot,
      rootFingerprint: fingerprint,
      metadata: serializableMetadata(metadata),
      fallbackReason: response.error?.code || "RUNTIME_UNAVAILABLE"
    };
  } catch (error) {
    return unavailable("METADATA_READ_FAILED", error.message);
  }
}

function handleConnection(socket, context) {
  let bytes = 0;
  let input = "";
  let handled = false;
  socket.setEncoding("utf8");
  socket.setTimeout(context.config.requestTimeoutMs, () => {
    respond(socket, failure(null, "REQUEST_TIMEOUT", "Runtime request timed out"));
  });
  socket.on("data", (chunk) => {
    if (handled) return;
    bytes += Buffer.byteLength(chunk);
    if (bytes > context.config.maxRequestBytes) {
      handled = true;
      respond(socket, failure(null, "REQUEST_TOO_LARGE", "Runtime request exceeds the configured byte limit"));
      return;
    }
    input += chunk;
    const newline = input.indexOf("\n");
    if (newline === -1) return;
    handled = true;
    processRequest(input.slice(0, newline), context)
      .then((result) => respond(socket, result))
      .catch((error) => respond(socket, failure(null, "INTERNAL_ERROR", error.message)));
  });
  socket.on("end", () => {
    if (!handled && input) {
      handled = true;
      processRequest(input, context)
        .then((result) => respond(socket, result))
        .catch((error) => respond(socket, failure(null, "INTERNAL_ERROR", error.message)));
    }
  });
  socket.on("error", () => {});
}

async function processRequest(text, context) {
  let request;
  try { request = JSON.parse(text); } catch { return failure(null, "INVALID_JSON", "Runtime request must be valid JSON"); }
  const invalid = validateRequest(request);
  if (invalid) return failure(request?.requestId || null, invalid.code, invalid.message);

  context.stats.requests += 1;
  if (request.action === "ping") {
    return success(request, {
      runtime: {
        pid: process.pid,
        instanceId: context.instanceId,
        socketPath: context.paths.socketPath,
        capabilities: runtimeCapabilities()
      },
      stats: { ...context.stats }
    });
  }
  if (request.action === "stop") {
    const result = success(request, { stopping: true });
    context.requestStop();
    return result;
  }

  let root;
  try { root = canonicalProjectRoot(request.root); } catch (error) {
    return failure(request.requestId, "INVALID_ROOT", error.message);
  }
  if (request.action === "cache.invalidate") {
    const invalidated = context.cache.delete(root);
    context.stats.invalidations += invalidated ? 1 : 0;
    return success(request, { root, invalidated });
  }
  return metadataResponse(request, root, context);
}

async function metadataResponse(request, root, context) {
  const now = context.config.now();
  const fingerprint = rootFingerprint(root);
  const cached = context.cache.get(root);
  if (cached && cached.expiresAt > now && cached.rootFingerprint === fingerprint) {
    context.stats.cacheHits += 1;
    return success(request, {
      source: "daemon",
      root,
      rootFingerprint: fingerprint,
      cache: { hit: true, ttlMs: context.config.ttlMs, expiresAt: new Date(cached.expiresAt).toISOString() },
      metadata: cached.metadata
    });
  }

  context.stats.cacheMisses += 1;
  const key = `${root}:${fingerprint}`;
  let pending = context.inflight.get(key);
  if (!pending) {
    pending = Promise.resolve(context.config.metadataReader(root))
      .then(serializableMetadata)
      .finally(() => context.inflight.delete(key));
    context.inflight.set(key, pending);
  }
  const metadata = await pending;
  const expiresAt = context.config.now() + context.config.ttlMs;
  context.cache.set(root, { rootFingerprint: fingerprint, metadata, expiresAt });
  return success(request, {
    source: "daemon",
    root,
    rootFingerprint: fingerprint,
    cache: { hit: false, ttlMs: context.config.ttlMs, expiresAt: new Date(expiresAt).toISOString() },
    metadata
  });
}

function validateRequest(request) {
  if (!isPlainObject(request)) return invalid("INVALID_REQUEST", "Runtime request must be an object");
  const allowed = new Set(["protocolVersion", "schemaVersion", "requestId", "action", "root"]);
  if (Object.keys(request).some((key) => !allowed.has(key))) {
    return invalid("UNKNOWN_FIELD", "Runtime request contains an unsupported field");
  }
  if (request.protocolVersion !== RUNTIME_PROTOCOL_VERSION || request.schemaVersion !== RUNTIME_SCHEMA_VERSION) {
    return invalid("PROTOCOL_MISMATCH", "Runtime protocol or schema version is not supported");
  }
  if (typeof request.requestId !== "string" || request.requestId.length < 1 || request.requestId.length > 128) {
    return invalid("INVALID_REQUEST_ID", "Runtime requestId must be a non-empty bounded string");
  }
  if (!ACTIONS.has(request.action)) return invalid("ACTION_NOT_ALLOWED", "Runtime action is not in the read-only control allowlist");
  const needsRoot = request.action === "metadata.get" || request.action === "cache.invalidate";
  if (needsRoot && (typeof request.root !== "string" || !request.root || request.root.length > 4096 || request.root.includes("\0"))) {
    return invalid("INVALID_ROOT", "Runtime action requires a bounded filesystem root");
  }
  if (!needsRoot && request.root !== undefined) return invalid("UNKNOWN_FIELD", "This runtime action does not accept a root");
  return null;
}

function normalizeRequest(request, requestId) {
  const input = isPlainObject(request) ? request : {};
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    requestId: requestId || crypto.randomUUID(),
    ...input
  };
}

function readProjectMetadata(root) {
  return getProjectInfo(root);
}

function serializableMetadata(value) {
  const source = value || null;
  if (source === null) return null;
  const commands = boundedRecord(source.commands, 32, 4096);
  const rawScripts = boundedRecord(source.rawScripts, 64, 4096);
  const dependencies = boundedRecord(source.dependencies, 256, 512);
  const metadata = {
    kind: boundedString(source.kind, 64),
    root: boundedString(source.root, 4096),
    path: boundedString(source.path, 4096),
    manifest: boundedString(source.manifest, 128),
    name: boundedString(source.name, 512),
    manager: boundedString(source.manager, 64),
    commands,
    rawScripts,
    dependencies,
    dependencyCount: isPlainObject(source.dependencies) ? Object.keys(source.dependencies).length : 0,
    profileNames: isPlainObject(source.profiles) ? Object.keys(source.profiles).slice(0, 64) : [],
    moduleCount: Array.isArray(source.modules) ? source.modules.length : 0,
    issues: Array.isArray(source.issues) ? source.issues.slice(0, 64).map(boundedIssue) : []
  };
  const encoded = JSON.stringify(metadata);
  if (Buffer.byteLength(encoded) > MAX_RESPONSE_BYTES / 2) throw new Error("Project metadata exceeds the safe serialized size");
  return metadata;
}

function rootFingerprint(root) {
  const identity = fs.lstatSync(root);
  const hash = crypto.createHash("sha256");
  hash.update(`${root}\0${identity.dev}\0${identity.ino}\0`);
  for (const name of FINGERPRINT_FILES) {
    const file = path.join(root, name);
    let stat;
    try { stat = fs.lstatSync(file); } catch { continue; }
    hash.update(`${name}\0${stat.mode}\0${stat.size}\0${stat.mtimeMs}\0`);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024) {
      hash.update(fs.readFileSync(file));
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

function canonicalProjectRoot(root) {
  if (typeof root !== "string" || !root || root.length > 4096 || root.includes("\0")) {
    throw new Error("Project root must be a non-empty bounded path");
  }
  const resolved = fs.realpathSync(path.resolve(root));
  if (!fs.statSync(resolved).isDirectory()) throw new Error("Project root must be a directory");
  return resolved;
}

async function probeRuntime(paths, options) {
  if (!isSocket(paths.socketPath)) return null;
  const response = await requestRuntime({ action: "ping" }, { ...options, paths });
  return response.ok ? response : null;
}

function recoverStaleRuntime(paths, options = {}, recoveryOptions = {}) {
  if (!isOwnedRuntimeDirectory(paths, options)) {
    if (recoveryOptions.quiet) return false;
    throw runtimeError("UNOWNED_RUNTIME_DIRECTORY", "Refusing to clean a runtime directory without a valid AgentShell ownership marker");
  }
  const socket = safeLstat(paths.socketPath);
  const state = readJson(paths.statePath);
  const lock = readJson(paths.lockPath);
  if (!socket && !state && !lock) return false;
  const uid = currentUid(options.uid);
  for (const candidate of [[paths.socketPath, socket], [paths.statePath, safeLstat(paths.statePath)], [paths.lockPath, safeLstat(paths.lockPath)]]) {
    if (candidate[1] && uid !== null && candidate[1].uid !== uid) {
      if (recoveryOptions.quiet) return false;
      throw runtimeError("UNSAFE_RUNTIME_OWNER", `Refusing to modify runtime path owned by uid ${candidate[1].uid}`);
    }
  }
  if (socket && !socket.isSocket()) {
    if (recoveryOptions.quiet) return false;
    throw runtimeError("UNSAFE_SOCKET_PATH", "Runtime socket path exists but is not a Unix socket");
  }
  const ownerPid = state?.pid || lock?.pid;
  if (ownerPid && isProcessAlive(ownerPid)) {
    if (recoveryOptions.quiet) return false;
    throw runtimeError("RUNTIME_UNHEALTHY", "Runtime owner is alive but the socket did not answer; refusing split-brain recovery");
  }
  fs.rmSync(paths.socketPath, { force: true });
  fs.rmSync(paths.statePath, { force: true });
  fs.rmSync(paths.lockPath, { force: true });
  return true;
}

function acquireRuntimeLock(paths, options) {
  const owner = {
    pid: process.pid,
    uid: currentUid(options.uid),
    createdAt: new Date().toISOString()
  };
  try {
    const descriptor = fs.openSync(paths.lockPath, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`);
    fs.closeSync(descriptor);
  } catch (error) {
    if (error?.code === "EEXIST") throw runtimeError("RUNTIME_START_BUSY", "Another runtime start is in progress");
    throw error;
  }
}

function releaseRuntime(paths, instanceId, options = {}) {
  if (!isOwnedRuntimeDirectory(paths, options)) return false;
  const state = readJson(paths.statePath);
  if (!state || !instanceId || state.instanceId === instanceId) {
    fs.rmSync(paths.socketPath, { force: true });
    fs.rmSync(paths.statePath, { force: true });
    fs.rmSync(paths.lockPath, { force: true });
    return true;
  }
  return false;
}

function ensurePrivateDirectory(paths, options = {}) {
  const { directory, markerPath } = paths;
  const existed = fs.existsSync(directory);
  if (!existed) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  const uid = currentUid(options.uid);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw runtimeError("UNSAFE_RUNTIME_DIRECTORY", "Runtime path must be a real directory");
  if (uid !== null && stat.uid !== uid) throw runtimeError("UNSAFE_RUNTIME_OWNER", "Runtime directory must be owned by the current user");

  const marker = readOwnershipMarker(markerPath);
  if (!marker) {
    if (existed && !isDefaultRuntimeDirectory(directory)) {
      throw runtimeError("UNOWNED_RUNTIME_DIRECTORY", "Custom runtime directory already exists without an AgentShell ownership marker");
    }
    writeJsonExclusive(markerPath, ownershipMarker(directory, uid), 0o600);
  }
  if (!isOwnedRuntimeDirectory(paths, options)) {
    throw runtimeError("INVALID_RUNTIME_MARKER", "Runtime ownership marker does not match this directory or user");
  }
  fs.chmodSync(directory, 0o700);
  fs.chmodSync(markerPath, 0o600);
}

function ownershipMarker(directory, uid) {
  return {
    kind: RUNTIME_OWNERSHIP_KIND,
    directory,
    uid,
    createdAt: new Date().toISOString()
  };
}

function isOwnedRuntimeDirectory(paths, options = {}) {
  const directoryStat = safeLstat(paths.directory);
  const markerStat = safeLstat(paths.markerPath);
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) return false;
  if (!markerStat?.isFile() || markerStat.isSymbolicLink()) return false;
  const uid = currentUid(options.uid);
  if (uid !== null && (directoryStat.uid !== uid || markerStat.uid !== uid)) return false;
  const marker = readOwnershipMarker(paths.markerPath);
  return marker?.kind === RUNTIME_OWNERSHIP_KIND
    && marker.directory === paths.directory
    && marker.uid === uid;
}

function readOwnershipMarker(markerPath) {
  const marker = readJson(markerPath);
  return isPlainObject(marker) ? marker : null;
}

function isDefaultRuntimeDirectory(directory) {
  return directory === path.resolve(os.homedir(), ".agentshell", "runtime");
}

function runtimeCapabilities() {
  return {
    transport: "unix-socket",
    localOnly: true,
    readOnlyMetadata: true,
    arbitraryExecution: false,
    actions: [...ACTIONS]
  };
}

function success(request, fields = {}) {
  return {
    ok: true,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    requestId: request.requestId,
    ...fields
  };
}

function failure(requestId, code, message, details = {}) {
  return {
    ok: false,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    requestId,
    error: { code, message, details },
    fallback: { allowed: true, mode: "local-read" }
  };
}

function unavailable(code, message, details = {}) {
  return failure(null, code, message, details);
}

function respond(socket, value) {
  if (socket.destroyed) return;
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized) > MAX_RESPONSE_BYTES) {
    socket.end(`${JSON.stringify(failure(value?.requestId || null, "RESPONSE_TOO_LARGE", "Runtime response exceeds the safe byte limit"))}\n`);
  } else {
    socket.end(serialized);
  }
}

function exchange(socketPath, serialized, options) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let bytes = 0;
    let output = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(options.timeoutMs, () => finish(reject, runtimeError("RUNTIME_TIMEOUT", "Runtime request timed out")));
    socket.on("connect", () => socket.end(serialized));
    socket.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > options.maxResponseBytes) {
        finish(reject, runtimeError("RESPONSE_TOO_LARGE", "Runtime response exceeds the configured byte limit"));
        return;
      }
      output += chunk;
      const newline = output.indexOf("\n");
      if (newline !== -1) {
        try { finish(resolve, JSON.parse(output.slice(0, newline))); }
        catch { finish(reject, runtimeError("INVALID_RESPONSE", "Runtime returned invalid JSON")); }
      }
    });
    socket.on("error", (error) => finish(reject, error));
    socket.on("end", () => {
      if (!settled) finish(reject, runtimeError("EMPTY_RESPONSE", "Runtime closed without a response"));
    });
  });
}

function listen(server, socketPath) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

async function waitForSocketRemoval(socketPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!fs.existsSync(socketPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function reusedSession(response, paths) {
  return {
    server: null,
    close: async () => {},
    report: {
      ok: true,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      running: true,
      reused: true,
      pid: response.runtime.pid,
      instanceId: response.runtime.instanceId,
      socketPath: paths.socketPath,
      capabilities: response.runtime.capabilities
    }
  };
}

function stoppedStatus(paths, reason) {
  return {
    ok: true,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    running: false,
    state: null,
    socketPath: paths.socketPath,
    reason
  };
}

function writeJsonAtomic(file, value, mode) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, mode);
}

function writeJsonExclusive(file, value, mode) {
  const descriptor = fs.openSync(file, "wx", mode);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function safeLstat(file) {
  try { return fs.lstatSync(file); } catch { return null; }
}

function isSocket(file) {
  return safeLstat(file)?.isSocket() === true;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function currentUid(requestedUid) {
  if (Number.isInteger(requestedUid)) return requestedUid;
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function boundedTtl(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return DEFAULT_TTL_MS;
  return Math.min(number, MAX_TTL_MS);
}

function boundedTimeout(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.min(number, MAX_REQUEST_TIMEOUT_MS);
}

function boundedRequestBytes(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1024) return DEFAULT_MAX_REQUEST_BYTES;
  return Math.min(number, DEFAULT_MAX_REQUEST_BYTES);
}

function boundedRecord(value, limit, maxLength) {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, limit).map(([key, entry]) => [
    String(key).slice(0, 128),
    boundedString(entry, maxLength)
  ]));
}

function boundedIssue(value) {
  if (!isPlainObject(value)) return { code: "UNKNOWN", reason: boundedString(value, 512) };
  return Object.fromEntries(Object.entries(value).slice(0, 8).map(([key, entry]) => [
    String(key).slice(0, 64),
    typeof entry === "string" ? entry.slice(0, 512) : entry === null || typeof entry === "boolean" || typeof entry === "number" ? entry : String(entry).slice(0, 512)
  ]));
}

function boundedString(value, maxLength) {
  return value === null || value === undefined ? null : String(value).slice(0, maxLength);
}

function assertSupportedPlatform(platform) {
  if (platform !== "darwin" && platform !== "linux") {
    throw runtimeError("UNSUPPORTED_PLATFORM", "Runtime daemon requires macOS or Linux Unix sockets");
  }
}

function assertSocketPath(socketPath) {
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw runtimeError("SOCKET_PATH_TOO_LONG", "Runtime Unix socket path is too long");
  }
}

function assertSafeRuntimePaths(directory, socketPath) {
  const filesystemRoot = path.parse(directory).root;
  if (directory === filesystemRoot || directory === path.resolve(os.homedir())) {
    throw runtimeError("UNSAFE_RUNTIME_DIRECTORY", "Runtime directory cannot be the filesystem root or home directory");
  }
  if (path.dirname(socketPath) !== directory) {
    throw runtimeError("UNSAFE_SOCKET_PATH", "Runtime socket must be located directly inside the owned runtime directory");
  }
}

function runtimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function runtimeErrorCode(error) {
  if (typeof error?.code === "string") {
    if (["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(error.code)) return "RUNTIME_UNAVAILABLE";
    return error.code;
  }
  return "RUNTIME_UNAVAILABLE";
}

function invalid(code, message) {
  return { code, message };
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
