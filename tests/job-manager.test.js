import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  JOB_PROTOCOL_VERSION,
  cancelJob,
  getJobStatus,
  jobPaths,
  ownedProcessGroupMatches,
  readJobDelta,
  runJobWorker,
  sourceJobWorkerScript,
  startJob
} from "../src/core/job-manager.js";

test("job lifecycle persists private state and supports cursor deltas", async (t) => {
  const fixture = workspaceFixture(t);
  const started = await startJob(fixture.root, [process.execPath, "-e", "console.log('one'); setTimeout(() => console.error('two'), 80)"], { timeoutMs: 15_000 });
  assert.equal(started.ok, true);
  registerCleanup(t, fixture.root, started.job.jobId);

  const completed = await waitForStatus(fixture.root, started.job.jobId, ["completed"]);
  assert.equal(completed.job.exitCode, 0);
  assert.equal(completed.job.timedOut, false);

  const first = await readJobDelta(fixture.root, started.job.jobId);
  assert.equal(first.ok, true);
  assert.match(first.output.stdout, /one/u);
  assert.match(first.output.stderr, /two/u);
  assert.equal(first.bytesRead > 0, true);

  const second = await readJobDelta(fixture.root, started.job.jobId, first.cursor);
  assert.equal(second.output.stdout, "");
  assert.equal(second.output.stderr, "");
  assert.equal(second.bytesRead, 0);

  const paths = jobPaths(fixture.root, started.job.jobId);
  assert.equal(fs.statSync(paths.agentshellDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.jobsDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.jobDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.statePath).mode & 0o777, 0o600);
  for (const file of fs.readdirSync(paths.jobDir).filter((name) => name.endsWith(".log"))) {
    assert.equal(fs.statSync(path.join(paths.jobDir, file)).mode & 0o777, 0o600);
  }
});

test("stdout and stderr logs rotate within configured bounds", async (t) => {
  const fixture = workspaceFixture(t);
  const script = "process.stdout.write('o'.repeat(7000)); process.stderr.write('e'.repeat(7000))";
  const started = await startJob(fixture.root, [process.execPath, "-e", script], {
    segmentBytes: 1024,
    maxSegments: 2,
    timeoutMs: 15_000
  });
  assert.equal(started.ok, true);
  registerCleanup(t, fixture.root, started.job.jobId);
  await waitForStatus(fixture.root, started.job.jobId, ["completed"], 15_000);

  const directory = jobPaths(fixture.root, started.job.jobId).jobDir;
  const files = fs.readdirSync(directory);
  assert.equal(files.filter((name) => name.startsWith("stdout.")).length <= 2, true);
  assert.equal(files.filter((name) => name.startsWith("stderr.")).length <= 2, true);
  const delta = await readJobDelta(fixture.root, started.job.jobId, null, { maxBytes: 4096 });
  assert.equal(delta.truncated, true);
  assert.match(delta.output.stdout, /^o+$/u);
  assert.match(delta.output.stderr, /^e+$/u);
});

test("timeout terminates the owned process group and persists structured state", async (t) => {
  const fixture = workspaceFixture(t);
  const started = await startJob(fixture.root, [process.execPath, "-e", "setInterval(() => console.log('tick'), 20)"], { timeoutMs: 120 });
  assert.equal(started.ok, true);
  registerCleanup(t, fixture.root, started.job.jobId);
  const result = await waitForStatus(fixture.root, started.job.jobId, ["timed_out"], 5000);
  assert.equal(result.job.timedOut, true);
  assert.equal(result.job.terminationReason, "timeout");
  assert.equal(["SIGTERM", "SIGKILL"].includes(result.job.signal), true);
});

test("cancel verifies worker identity and leaves no running command", async (t) => {
  const fixture = workspaceFixture(t);
  const started = await startJob(fixture.root, [process.execPath, "-e", "setInterval(() => {}, 1000)"], { timeoutMs: 30_000 });
  assert.equal(started.ok, true);
  registerCleanup(t, fixture.root, started.job.jobId);
  await waitForStatus(fixture.root, started.job.jobId, ["running"], 15_000);
  const cancelled = await cancelJob(fixture.root, started.job.jobId);
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.instanceVerified, true);
  const result = await waitForStatus(fixture.root, started.job.jobId, ["cancelled"]);
  assert.equal(result.job.cancelRequested, true);
  assert.equal(result.job.terminationReason, "cancelled");
});

test("cancel refuses a live but unrelated PID to prevent PID-reuse signalling", async (t) => {
  const fixture = workspaceFixture(t);
  const paths = jobPaths(fixture.root, "job-fake-1234");
  fs.mkdirSync(paths.jobDir, { recursive: true, mode: 0o700 });
  const now = new Date(Date.now() - 10_000).toISOString();
  fs.writeFileSync(paths.statePath, JSON.stringify({
    protocolVersion: JOB_PROTOCOL_VERSION,
    schemaVersion: 1,
    jobId: "job-fake-1234",
    instanceId: "not-the-current-process",
    status: "running",
    rootFingerprint: "sha256:fake",
    argv: [process.execPath],
    pid: process.pid,
    workerPid: process.pid,
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    timeoutMs: 1000,
    exitCode: null,
    signal: null,
    timedOut: false,
    cancelRequested: false,
    terminationReason: null,
    log: { segmentBytes: 1024, maxSegments: 2, stdoutBytes: 0, stderrBytes: 0 }
  }), { mode: 0o600 });

  const result = await cancelJob(fixture.root, "job-fake-1234");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "JOB_IDENTITY_MISMATCH");
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test("cancel during the startup grace window records intent without signalling an unverified PID", async (t) => {
  const fixture = workspaceFixture(t);
  const started = await startJob(fixture.root, [process.execPath, "-e", "0"], {
    spawn: () => ({ pid: process.pid, unref() {} })
  });
  assert.equal(started.ok, true);
  const result = await cancelJob(fixture.root, started.job.jobId);
  assert.equal(result.ok, true);
  assert.equal(result.cancelled, true);
  assert.equal(result.instanceVerified, false);
  assert.equal(result.signalSent, false);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
  const paths = jobPaths(fixture.root, started.job.jobId);
  const persisted = JSON.parse(fs.readFileSync(paths.statePath, "utf8"));
  assert.equal(persisted.cancelRequested, true);
  assert.equal(fs.existsSync(path.join(paths.jobDir, "command.json")), false);
});

test("concurrency, argv, workspace, and state path limits fail closed", async (t) => {
  const fixture = workspaceFixture(t);
  const running = await startJob(fixture.root, [process.execPath, "-e", "setTimeout(() => {}, 2000)"], { maxJobs: 1, timeoutMs: 30_000 });
  assert.equal(running.ok, true);
  registerCleanup(t, fixture.root, running.job.jobId);
  await waitForStatus(fixture.root, running.job.jobId, ["running"], 15_000);

  const limited = await startJob(fixture.root, [process.execPath, "-e", "0"], { maxJobs: 1 });
  assert.equal(limited.ok, false);
  assert.equal(limited.error.code, "JOB_LIMIT_REACHED");

  const tooMany = await startJob(fixture.root, Array.from({ length: 65 }, () => "x"));
  assert.equal(tooMany.error.code, "ARGUMENT_LIMIT_EXCEEDED");
  const external = await startJob(fixture.root, [process.execPath, "-e", "0"], { stateDir: path.join(fixture.base, "external") });
  assert.equal(external.error.code, "EXTERNAL_STATE_PATH_REJECTED");
  const unsafe = await startJob(os.homedir(), [process.execPath, "-e", "0"]);
  assert.equal(unsafe.error.code, "UNSAFE_WORKSPACE_ROOT");

  await cancelJob(fixture.root, running.job.jobId);
  await waitForStatus(fixture.root, running.job.jobId, ["cancelled"]);
});

test("concurrent starts atomically reserve the workspace job limit", async (t) => {
  const fixture = workspaceFixture(t);
  const fakeSpawn = () => ({ pid: process.pid, unref() {} });
  const attempts = await Promise.all(Array.from({ length: 8 }, () => startJob(
    fixture.root,
    [process.execPath, "-e", "setTimeout(() => {}, 1000)"],
    { maxJobs: 1, spawn: fakeSpawn }
  )));
  const accepted = attempts.filter((result) => result.ok);
  const rejected = attempts.filter((result) => !result.ok);
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 7);
  assert.equal(rejected.every((result) => result.error.code === "JOB_LIMIT_REACHED"), true);
});

test("status marks stale active state as lost", async (t) => {
  const fixture = workspaceFixture(t);
  const paths = jobPaths(fixture.root, "job-stale-1234");
  fs.mkdirSync(paths.jobDir, { recursive: true, mode: 0o700 });
  const now = new Date(Date.now() - 10_000).toISOString();
  fs.writeFileSync(paths.statePath, JSON.stringify({
    protocolVersion: JOB_PROTOCOL_VERSION,
    schemaVersion: 1,
    jobId: "job-stale-1234",
    instanceId: "stale-instance",
    status: "running",
    argv: [process.execPath],
    workerPid: 999999,
    pid: 999999,
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    timeoutMs: 1000,
    exitCode: null,
    signal: null,
    timedOut: false,
    cancelRequested: false,
    terminationReason: null,
    log: { segmentBytes: 1024, maxSegments: 2, stdoutBytes: 0, stderrBytes: 0 }
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(paths.jobDir, "reconcile.json"), JSON.stringify({
    protocolVersion: JOB_PROTOCOL_VERSION,
    jobId: "job-stale-1234",
    instanceId: "stale-instance",
    workerMissingSince: new Date(Date.now() - 10_000).toISOString()
  }), { mode: 0o600 });
  const result = await getJobStatus(fixture.root, "job-stale-1234");
  assert.equal(result.ok, true);
  assert.equal(result.job.status, "lost");
  assert.equal(result.job.terminationReason, "worker-unavailable");
});

test("status gives a vanished short worker time to persist completion instead of reporting lost", async (t) => {
  const fixture = workspaceFixture(t);
  const paths = jobPaths(fixture.root, "job-race-12345");
  fs.mkdirSync(paths.jobDir, { recursive: true, mode: 0o700 });
  const old = new Date(Date.now() - 10_000).toISOString();
  const state = {
    protocolVersion: JOB_PROTOCOL_VERSION,
    schemaVersion: 1,
    jobId: "job-race-12345",
    instanceId: "short-worker-instance",
    status: "running",
    argv: [process.execPath, "-e", "console.log('ready')"],
    workerPid: 999999,
    pid: 999998,
    startedAt: old,
    updatedAt: old,
    completedAt: null,
    timeoutMs: 1000,
    exitCode: null,
    signal: null,
    timedOut: false,
    cancelRequested: false,
    terminationReason: null,
    log: { segmentBytes: 1024, maxSegments: 2, stdoutBytes: 0, stderrBytes: 0 }
  };
  fs.writeFileSync(paths.statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });

  const duringRace = await getJobStatus(fixture.root, state.jobId);
  assert.equal(duringRace.ok, true);
  assert.equal(duringRace.job.status, "running");
  const pending = JSON.parse(fs.readFileSync(paths.statePath, "utf8"));
  const marker = JSON.parse(fs.readFileSync(path.join(paths.jobDir, "reconcile.json"), "utf8"));
  assert.equal(pending.status, "running");
  assert.equal(typeof marker.workerMissingSince, "string");

  fs.writeFileSync(paths.statePath, `${JSON.stringify({
    ...pending,
    status: "completed",
    exitCode: 0,
    completedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const completed = await getJobStatus(fixture.root, state.jobId);
  assert.equal(completed.ok, true);
  assert.equal(completed.job.status, "completed");
  assert.equal(completed.job.exitCode, 0);
});

test("state symlinks are rejected and returned argv/output redact secrets", async (t) => {
  const fixture = workspaceFixture(t);
  const started = await startJob(fixture.root, [process.execPath, "-e", "console.log('api_key=super-secret')", "--", "--password", "hidden-value"], { timeoutMs: 15_000 });
  assert.equal(started.ok, true);
  registerCleanup(t, fixture.root, started.job.jobId);
  assert.deepEqual(started.job.argv.slice(-2), ["--password", "[REDACTED]"]);
  await waitForStatus(fixture.root, started.job.jobId, ["completed"], 15_000);
  const delta = await readJobDelta(fixture.root, started.job.jobId);
  assert.doesNotMatch(delta.output.stdout, /super-secret/u);
  assert.match(delta.output.stdout, /\[REDACTED\]/u);

  const external = path.join(fixture.base, "external-state.json");
  fs.writeFileSync(external, "{}\n");
  const paths = jobPaths(fixture.root, started.job.jobId);
  fs.rmSync(paths.statePath);
  fs.symlinkSync(external, paths.statePath);
  const unsafe = await getJobStatus(fixture.root, started.job.jobId);
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.error.code, "JOB_NOT_FOUND");
});

test("raw argv exists only in a private one-time payload consumed by the worker", async (t) => {
  const fixture = workspaceFixture(t);
  const secret = "one-time-super-secret";
  const started = await startJob(
    fixture.root,
    [process.execPath, "-e", "process.stdout.write(process.argv[1])", `password=${secret}`],
    { timeoutMs: 15_000, spawn: () => ({ pid: process.pid, unref() {} }) }
  );
  assert.equal(started.ok, true);
  const paths = jobPaths(fixture.root, started.job.jobId);
  const stateText = fs.readFileSync(paths.statePath, "utf8");
  const payloadPath = path.join(paths.jobDir, "command.json");
  assert.doesNotMatch(stateText, new RegExp(secret, "u"));
  assert.match(stateText, /\[REDACTED\]/u);
  assert.equal(fs.statSync(payloadPath).mode & 0o777, 0o600);

  const persisted = JSON.parse(stateText);
  await runJobWorker({ root: fixture.root, jobId: started.job.jobId, instanceId: persisted.instanceId });
  assert.equal(fs.existsSync(payloadPath), false);
  const completedState = fs.readFileSync(paths.statePath, "utf8");
  assert.doesNotMatch(completedState, new RegExp(secret, "u"));
  const delta = await readJobDelta(fixture.root, started.job.jobId);
  assert.doesNotMatch(delta.output.stdout, new RegExp(secret, "u"));
  assert.match(delta.output.stdout, /\[REDACTED\]/u);
});

test("delta survives rotated segments and advances only across complete UTF-8 characters", async (t) => {
  const fixture = workspaceFixture(t);
  const started = await startJob(fixture.root, [process.execPath, "-e", "0"], {
    spawn: () => ({ pid: process.pid, unref() {} })
  });
  assert.equal(started.ok, true);
  const directory = jobPaths(fixture.root, started.job.jobId).jobDir;
  const encoded = Buffer.from("你", "utf8");
  fs.writeFileSync(path.join(directory, "stdout.000000.log"), Buffer.concat([Buffer.alloc(511, 0x61), encoded.subarray(0, 1)]), { mode: 0o600 });
  fs.writeFileSync(path.join(directory, "stdout.000001.log"), encoded.subarray(1), { mode: 0o600 });

  const first = await readJobDelta(fixture.root, started.job.jobId, null, { maxBytes: 1024 });
  assert.equal(first.output.stdout, "a".repeat(511));
  assert.doesNotMatch(first.output.stdout, /\uFFFD/u);
  assert.equal(first.bytesRead, 511);
  assert.equal(first.hasMore, true);

  fs.rmSync(path.join(directory, "stdout.000000.log"));
  const second = await readJobDelta(fixture.root, started.job.jobId, first.cursor, { maxBytes: 1024 });
  assert.equal(second.ok, true);
  assert.equal(second.truncated, true);
  assert.doesNotMatch(second.output.stdout, /\uFFFD/u);

  fs.writeFileSync(path.join(directory, "stdout.000002.log"), encoded, { mode: 0o600 });
  const complete = await readJobDelta(fixture.root, started.job.jobId, second.cursor, { maxBytes: 1024 });
  assert.equal(complete.output.stdout, "你");
  assert.doesNotMatch(complete.output.stdout, /\uFFFD/u);
  fs.appendFileSync(path.join(directory, "stdout.000002.log"), "later");
  const appended = await readJobDelta(fixture.root, started.job.jobId, complete.cursor, { maxBytes: 1024 });
  assert.equal(appended.output.stdout, "later");
});

test("log writer failures terminate and reap the child before persisting failure", async (t) => {
  const fixture = workspaceFixture(t);
  const started = await startJob(fixture.root, [process.execPath, "-e", "console.log('trigger'); setInterval(() => {}, 1000)"], {
    timeoutMs: 15_000,
    spawn: () => ({ pid: process.pid, unref() {} })
  });
  assert.equal(started.ok, true);
  await runJobWorker({
    root: fixture.root,
    jobId: started.job.jobId,
    instanceId: JSON.parse(fs.readFileSync(jobPaths(fixture.root, started.job.jobId).statePath, "utf8")).instanceId,
    killGraceMs: 50,
    logWriterFactory: () => ({
      totalBytes: 0,
      write() { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); }
    })
  });
  const status = await getJobStatus(fixture.root, started.job.jobId);
  assert.equal(status.ok, true);
  assert.equal(status.job.status, "failed");
  assert.equal(status.job.terminationReason, "log-write-failed");
  assert.equal(status.job.signal, "SIGTERM");
  assert.throws(() => process.kill(status.job.pid, 0));
});

test("source workers resolve from the active package root, never an unrelated plugin cache", async (t) => {
  const fixture = workspaceFixture(t);
  let spawnedArgs = null;
  const fakeCache = path.join(fixture.base, "stale-plugin-cache");
  const started = await startJob(fixture.root, [process.execPath, "-e", "0"], {
    env: { ...process.env, AGENTSHELL_PACKAGE_ROOT: fakeCache },
    spawn: (_executable, args) => {
      spawnedArgs = args;
      return { pid: process.pid, unref() {} };
    }
  });
  assert.equal(started.ok, true);
  const expected = fileURLToPath(new URL("../src/commands/job.js", import.meta.url));
  assert.equal(sourceJobWorkerScript(), expected);
  assert.equal(spawnedArgs[0], expected);
  assert.equal(spawnedArgs[0].startsWith(fakeCache), false);
});

test("owned process-group identity is revalidated before a delayed force signal", async (t) => {
  const fixture = workspaceFixture(t);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: fixture.root,
    detached: true,
    stdio: "ignore",
    shell: false
  });
  t.after(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  });
  const paths = jobPaths(fixture.root, "job-owned-1234");
  fs.mkdirSync(paths.jobDir, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const state = {
    protocolVersion: JOB_PROTOCOL_VERSION,
    schemaVersion: 1,
    jobId: "job-owned-1234",
    instanceId: "owned-instance",
    status: "running",
    argv: [process.execPath],
    workerPid: process.pid,
    pid: child.pid,
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    timeoutMs: 1000,
    exitCode: null,
    signal: null,
    timedOut: false,
    cancelRequested: false,
    terminationReason: null,
    log: { segmentBytes: 1024, maxSegments: 2, stdoutBytes: 0, stderrBytes: 0 }
  };
  fs.writeFileSync(paths.statePath, JSON.stringify(state), { mode: 0o600 });
  await waitForProcess(child.pid);
  assert.equal(ownedProcessGroupMatches(paths.jobDir, state.instanceId, process.pid, child.pid), true);
  fs.writeFileSync(paths.statePath, JSON.stringify({ ...state, pid: child.pid + 1 }), { mode: 0o600 });
  assert.equal(ownedProcessGroupMatches(paths.jobDir, state.instanceId, process.pid, child.pid), false);
  process.kill(-child.pid, "SIGKILL");
  await new Promise((resolve) => child.once("close", resolve));
});

function workspaceFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "as-job-"));
  const root = path.join(base, "workspace");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root };
}

function registerCleanup(t, root, jobId) {
  t.after(async () => {
    const status = await getJobStatus(root, jobId);
    if (status.ok && ["starting", "running"].includes(status.job.status)) {
      await cancelJob(root, jobId);
      await waitForStatus(root, jobId, ["completed", "failed", "cancelled", "timed_out", "lost"], 3000).catch(() => {});
    }
  });
}

async function waitForStatus(root, jobId, expected, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await getJobStatus(root, jobId);
    if (result.ok && expected.includes(result.job.status)) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const last = await getJobStatus(root, jobId);
  throw new Error(`Timed out waiting for ${expected.join(", ")}; last=${JSON.stringify(last)}`);
}

async function waitForProcess(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(pid, 0); return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Process ${pid} did not become observable`);
}
