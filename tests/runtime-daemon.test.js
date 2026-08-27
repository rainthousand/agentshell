import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  RUNTIME_OWNERSHIP_MARKER,
  RUNTIME_PROTOCOL_VERSION,
  getRuntimeProjectMetadata,
  requestRuntime,
  runtimePaths,
  runtimeStatus,
  startRuntimeDaemon,
  stopRuntimeDaemon
} from "../src/core/runtime-daemon.js";
import { startRuntimeBackground } from "../src/commands/runtime.js";

test("runtime lifecycle uses a private Unix socket and cleans up state", async (t) => {
  const fixture = runtimeFixture(t);
  const session = await startRuntimeDaemon({ runtimeDir: fixture.runtimeDir, ttlMs: 1000 });
  t.after(() => session.close());

  assert.equal(session.report.ok, true);
  assert.equal(session.report.reused, false);
  assert.equal(session.report.capabilities.arbitraryExecution, false);
  assert.equal(fs.lstatSync(fixture.paths.socketPath).isSocket(), true);
  assert.equal(fs.statSync(fixture.runtimeDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(fixture.runtimeDir, RUNTIME_OWNERSHIP_MARKER)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(fixture.paths.socketPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(fixture.paths.statePath).mode & 0o777, 0o600);

  const status = await runtimeStatus({ runtimeDir: fixture.runtimeDir });
  assert.equal(status.running, true);
  assert.equal(status.runtime.instanceId, session.report.instanceId);

  const stopped = await stopRuntimeDaemon({ runtimeDir: fixture.runtimeDir });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stopped, true);
  assert.equal(fs.existsSync(fixture.paths.socketPath), false);
  assert.equal(fs.existsSync(fixture.paths.statePath), false);
  assert.equal(fs.existsSync(fixture.paths.lockPath), false);
});

test("metadata requests cache serializable reads and expire by TTL", async (t) => {
  const fixture = runtimeFixture(t);
  let now = 1000;
  let reads = 0;
  const metadataReader = async (root) => {
    reads += 1;
    return { kind: "node", root, path: path.join(root, "package.json"), manifest: "package.json", name: `read-${reads}`, manager: "npm", commands: { test: "node --test" }, rawScripts: {}, dependencies: {} };
  };
  const session = await startRuntimeDaemon({ runtimeDir: fixture.runtimeDir, ttlMs: 50, now: () => now, metadataReader });
  t.after(() => session.close());

  const first = await getRuntimeProjectMetadata(fixture.projectRoot, { runtimeDir: fixture.runtimeDir });
  const second = await getRuntimeProjectMetadata(fixture.projectRoot, { runtimeDir: fixture.runtimeDir });
  assert.equal(first.source, "daemon");
  assert.equal(first.cache.hit, false);
  assert.equal(second.cache.hit, true);
  assert.equal(second.metadata.name, "read-1");
  assert.equal(reads, 1);

  now += 51;
  const expired = await getRuntimeProjectMetadata(fixture.projectRoot, { runtimeDir: fixture.runtimeDir });
  assert.equal(expired.cache.hit, false);
  assert.equal(expired.metadata.name, "read-2");
  assert.equal(reads, 2);
});

test("root fingerprint invalidates metadata before TTL expiry", async (t) => {
  const fixture = runtimeFixture(t);
  let reads = 0;
  const session = await startRuntimeDaemon({
    runtimeDir: fixture.runtimeDir,
    ttlMs: 60_000,
    metadataReader: async (root) => ({ kind: "node", root, name: `read-${++reads}`, commands: {}, rawScripts: {}, dependencies: {} })
  });
  t.after(() => session.close());

  const first = await getRuntimeProjectMetadata(fixture.projectRoot, { runtimeDir: fixture.runtimeDir });
  fs.writeFileSync(path.join(fixture.projectRoot, "package.json"), JSON.stringify({ name: "changed", scripts: { test: "node --test" } }));
  const changed = await getRuntimeProjectMetadata(fixture.projectRoot, { runtimeDir: fixture.runtimeDir });
  assert.notEqual(changed.rootFingerprint, first.rootFingerprint);
  assert.equal(changed.cache.hit, false);
  assert.equal(reads, 2);
});

test("concurrent metadata misses are coalesced", async (t) => {
  const fixture = runtimeFixture(t);
  let reads = 0;
  const session = await startRuntimeDaemon({
    runtimeDir: fixture.runtimeDir,
    metadataReader: async (root) => {
      reads += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { kind: "node", root, name: "concurrent", commands: {}, rawScripts: {}, dependencies: {} };
    }
  });
  t.after(() => session.close());

  const results = await Promise.all(Array.from({ length: 12 }, () => (
    getRuntimeProjectMetadata(fixture.projectRoot, { runtimeDir: fixture.runtimeDir })
  )));
  assert.equal(results.every((result) => result.ok && result.metadata.name === "concurrent"), true);
  assert.equal(reads, 1);
});

test("stale sockets are recovered but unsafe socket paths are preserved", async (t) => {
  const fixture = runtimeFixture(t);
  const owner = await startRuntimeDaemon({ runtimeDir: fixture.runtimeDir });
  await owner.close();
  const staleServer = net.createServer();
  await new Promise((resolve) => staleServer.listen(fixture.paths.socketPath, resolve));
  await new Promise((resolve) => staleServer.close(resolve));
  fs.writeFileSync(fixture.paths.statePath, JSON.stringify({ pid: 999999, instanceId: "dead" }), { mode: 0o600 });
  fs.writeFileSync(fixture.paths.lockPath, JSON.stringify({ pid: 999999 }), { mode: 0o600 });

  const recovered = await startRuntimeDaemon({ runtimeDir: fixture.runtimeDir });
  t.after(() => recovered.close());
  assert.equal(recovered.report.running, true);
  await recovered.close();

  fs.writeFileSync(fixture.paths.socketPath, "not a socket", { mode: 0o600 });
  await assert.rejects(
    startRuntimeDaemon({ runtimeDir: fixture.runtimeDir }),
    (error) => error.code === "UNSAFE_SOCKET_PATH"
  );
  assert.equal(fs.readFileSync(fixture.paths.socketPath, "utf8"), "not a socket");
});

test("custom runtime directories require a path-bound ownership marker before chmod or cleanup", async (t) => {
  const fixture = runtimeFixture(t);
  fs.mkdirSync(fixture.runtimeDir, { mode: 0o755 });
  const sentinel = path.join(fixture.runtimeDir, "keep.txt");
  fs.writeFileSync(sentinel, "preserve me");

  await assert.rejects(
    startRuntimeDaemon({ runtimeDir: fixture.runtimeDir }),
    (error) => error.code === "UNOWNED_RUNTIME_DIRECTORY"
  );
  assert.equal(fs.statSync(fixture.runtimeDir).mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve me");

  fs.writeFileSync(path.join(fixture.runtimeDir, RUNTIME_OWNERSHIP_MARKER), JSON.stringify({
    kind: "agentshell.runtime-directory.v1",
    directory: path.join(fixture.base, "different"),
    uid: typeof process.getuid === "function" ? process.getuid() : null
  }));
  await assert.rejects(
    startRuntimeDaemon({ runtimeDir: fixture.runtimeDir }),
    (error) => error.code === "INVALID_RUNTIME_MARKER"
  );
  assert.equal(fs.existsSync(sentinel), true);
});

test("background startup timeout terminates the detached process group and reports escalation", async (t) => {
  const fixture = runtimeFixture(t);
  const signals = [];
  const child = {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    unref() {}
  };
  const result = await startRuntimeBackground({
    runtimeDir: fixture.runtimeDir,
    spawn: () => child,
    kill: (pid, signal) => { signals.push({ pid, signal }); },
    startupAttempts: 1,
    startupPollMs: 1,
    terminationGraceMs: 1
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "RUNTIME_START_TIMEOUT");
  assert.deepEqual(signals, [
    { pid: -4242, signal: "SIGTERM" },
    { pid: -4242, signal: "SIGKILL" }
  ]);
  assert.deepEqual(result.error.details.termination, {
    attempted: true,
    pid: 4242,
    processGroup: -4242,
    signal: "SIGKILL",
    escalated: true,
    exited: false,
    exitCode: null,
    exitSignal: null
  });
});

test("protocol rejects execution-shaped, oversized, and mismatched requests", async (t) => {
  const fixture = runtimeFixture(t);
  const session = await startRuntimeDaemon({ runtimeDir: fixture.runtimeDir, maxRequestBytes: 1024 });
  t.after(() => session.close());

  const execution = await requestRuntime({ action: "exec", command: "rm -rf /" }, { runtimeDir: fixture.runtimeDir });
  assert.equal(execution.ok, false);
  assert.equal(execution.error.code, "UNKNOWN_FIELD");
  assert.equal(execution.fallback.mode, "local-read");

  const mismatch = await rawExchange(fixture.paths.socketPath, {
    protocolVersion: "agentshell.runtime.v0",
    schemaVersion: 1,
    requestId: "mismatch",
    action: "ping"
  });
  assert.equal(mismatch.error.code, "PROTOCOL_MISMATCH");

  const oversized = await requestRuntime({ action: "metadata.get", root: `/${"x".repeat(2000)}` }, {
    runtimeDir: fixture.runtimeDir,
    maxRequestBytes: 1024
  });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error.code, "REQUEST_TOO_LARGE");
});

test("missing daemon has explicit fallback and local metadata semantics", async (t) => {
  const fixture = runtimeFixture(t);
  const unavailable = await requestRuntime({ action: "ping" }, { runtimeDir: fixture.runtimeDir, requestTimeoutMs: 50 });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.fallback.allowed, true);

  const fallback = await getRuntimeProjectMetadata(fixture.projectRoot, { runtimeDir: fixture.runtimeDir, requestTimeoutMs: 50 });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.source, "fallback");
  assert.equal(fallback.metadata.name, "runtime-fixture");
  assert.match(fallback.rootFingerprint, /^sha256:/);
});

test("runtime schema and state expose explicit versions", async (t) => {
  const fixture = runtimeFixture(t);
  const schema = JSON.parse(fs.readFileSync(new URL("../schemas/runtime.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.$defs.request.properties.protocolVersion.const, RUNTIME_PROTOCOL_VERSION);
  assert.equal(schema.$defs.request.properties.schemaVersion.const, 1);
  assert.deepEqual(schema.$defs.request.properties.action.enum, ["ping", "metadata.get", "cache.invalidate", "stop"]);

  const session = await startRuntimeDaemon({ runtimeDir: fixture.runtimeDir });
  t.after(() => session.close());
  const state = JSON.parse(fs.readFileSync(fixture.paths.statePath, "utf8"));
  assert.equal(state.protocolVersion, RUNTIME_PROTOCOL_VERSION);
  assert.equal(state.schemaVersion, 1);
});

function runtimeFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "as-runtime-"));
  const runtimeDir = path.join(base, "r");
  const projectRoot = path.join(base, "p");
  fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({
    name: "runtime-fixture",
    scripts: { test: "node --test" },
    dependencies: { fixture: "1.0.0" }
  }));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, runtimeDir, projectRoot, paths: runtimePaths({ runtimeDir }) };
}

function rawExchange(socketPath, value) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let output = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(`${JSON.stringify(value)}\n`));
    socket.on("data", (chunk) => { output += chunk; });
    socket.on("end", () => {
      try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
    });
    socket.on("error", reject);
  });
}
