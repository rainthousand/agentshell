import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { redactCommandOutput } from "./compact-command-output.js";
import { fail } from "./output.js";
import { resolvePackageRoot } from "./package-root.js";

export const JOB_PROTOCOL_VERSION = "agentshell.job.v1";
export const JOB_SCHEMA_VERSION = 1;

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const MAX_TIMEOUT_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_JOBS = 4;
const MAX_JOBS = 16;
const DEFAULT_SEGMENT_BYTES = 256 * 1024;
const MAX_SEGMENT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_SEGMENTS = 4;
const MAX_SEGMENTS = 16;
const DEFAULT_DELTA_BYTES = 64 * 1024;
const MAX_DELTA_BYTES = 512 * 1024;
const MAX_ARGV = 64;
const MAX_ARG_BYTES = 4096;
const MAX_ARGV_BYTES = 32 * 1024;
const KILL_GRACE_MS = 750;
const WORKER_SETTLE_GRACE_MS = 2_000;
const COMPLETION_RECONCILE_GRACE_MS = 1_000;
const ADMISSION_LOCK_STALE_MS = 30_000;
const ADMISSION_LOCK_WAIT_MS = 5_000;
const STREAMS = ["stdout", "stderr"];
const COMMAND_PAYLOAD_FILE = "command.json";

export function jobPaths(root, jobId = null) {
  const workspaceRoot = canonicalWorkspaceRoot(root);
  const jobsDir = path.join(workspaceRoot, ".agentshell", "jobs");
  const jobDir = jobId ? path.join(jobsDir, validateJobId(jobId)) : null;
  return {
    root: workspaceRoot,
    agentshellDir: path.dirname(jobsDir),
    jobsDir,
    jobDir,
    statePath: jobDir ? path.join(jobDir, "state.json") : null
  };
}

export async function startJob(root, argv, options = {}) {
  let releaseAdmission = null;
  let payloadPath = null;
  try {
    rejectExternalState(options);
    const paths = jobPaths(root);
    const command = validateArgv(argv);
    const limits = normalizeLimits(options);
    ensurePrivateDirectory(paths.agentshellDir);
    ensurePrivateDirectory(paths.jobsDir);
    releaseAdmission = await acquireAdmissionLock(paths.jobsDir);
    recoverJobs(paths.jobsDir);
    const active = listStates(paths.jobsDir).filter((state) => isActiveState(state));
    if (active.length >= limits.maxJobs) {
      return fail("JOB_LIMIT_REACHED", `At most ${limits.maxJobs} background jobs may run concurrently`, {
        activeJobs: active.length,
        maximumJobs: limits.maxJobs
      });
    }

    const jobId = createJobId(options.now || Date.now);
    const instanceId = crypto.randomUUID();
    const jobDir = path.join(paths.jobsDir, jobId);
    ensurePrivateDirectory(jobDir);
    payloadPath = path.join(jobDir, COMMAND_PAYLOAD_FILE);
    const now = new Date((options.now || Date.now)()).toISOString();
    const state = {
      protocolVersion: JOB_PROTOCOL_VERSION,
      schemaVersion: JOB_SCHEMA_VERSION,
      jobId,
      instanceId,
      status: "starting",
      rootFingerprint: fingerprintRoot(paths.root),
      argv: redactArgv(command),
      pid: null,
      workerPid: null,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      timeoutMs: limits.timeoutMs,
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelRequested: false,
      terminationReason: null,
      log: {
        segmentBytes: limits.segmentBytes,
        maxSegments: limits.maxSegments,
        stdoutBytes: 0,
        stderrBytes: 0
      }
    };
    writeJsonAtomic(path.join(jobDir, "state.json"), state);
    writeJsonAtomic(payloadPath, {
      protocolVersion: JOB_PROTOCOL_VERSION,
      schemaVersion: JOB_SCHEMA_VERSION,
      jobId,
      instanceId,
      argv: command
    });

    const isNode = /^node(?:\.exe)?$/iu.test(path.basename(process.execPath));
    const workerArgs = isNode
      ? [sourceJobWorkerScript(), "__worker", "--root", paths.root, "--job", jobId, "--instance", instanceId]
      : ["job", "__worker", "--root", paths.root, "--job", jobId, "--instance", instanceId];
    let worker;
    try {
      worker = (options.spawn || spawn)(process.execPath, workerArgs, {
        cwd: paths.root,
        detached: true,
        stdio: "ignore",
        shell: false,
        windowsHide: true,
        env: { ...sanitizedWorkerEnv(options.env), AGENTSHELL_JOB_WORKER: "1" }
      });
      worker.unref?.();
    } catch (error) {
      fs.rmSync(payloadPath, { force: true });
      updateState(jobDir, instanceId, (current) => ({
        ...current,
        status: "failed",
        completedAt: new Date().toISOString(),
        terminationReason: "worker-spawn-failed",
        spawnError: String(error?.code || error?.message || "SPAWN_ERROR")
      }));
      return fail("JOB_START_FAILED", "Unable to start the background job worker", { jobId });
    }

    updateState(jobDir, instanceId, (current) => ({ ...current, workerPid: worker.pid || null }));
    return {
      ok: true,
      protocolVersion: JOB_PROTOCOL_VERSION,
      schemaVersion: JOB_SCHEMA_VERSION,
      action: "start",
      job: publicState(readState(jobDir)),
      cursor: encodeCursor(emptyCursor())
    };
  } catch (error) {
    if (payloadPath) fs.rmSync(payloadPath, { force: true });
    return jobFailure(error);
  } finally {
    releaseAdmission?.();
  }
}

export async function getJobStatus(root, jobId, options = {}) {
  try {
    rejectExternalState(options);
    const paths = jobPaths(root, jobId);
    let state = readState(paths.jobDir);
    if (isActiveState(state) && !workerMatches(state) && !withinWorkerSettleGrace(state)) {
      state = reconcileMissingWorker(paths.jobDir, state, options);
    }
    return {
      ok: true,
      protocolVersion: JOB_PROTOCOL_VERSION,
      schemaVersion: JOB_SCHEMA_VERSION,
      action: "status",
      job: publicState(state)
    };
  } catch (error) {
    return jobFailure(error);
  }
}

export async function readJobDelta(root, jobId, cursor = null, options = {}) {
  try {
    rejectExternalState(options);
    const paths = jobPaths(root, jobId);
    const state = readState(paths.jobDir);
    const position = decodeCursor(cursor);
    const maxBytes = boundedInteger(options.maxBytes, DEFAULT_DELTA_BYTES, 1024, MAX_DELTA_BYTES);
    const stdout = readStreamDelta(paths.jobDir, "stdout", position.stdout, Math.floor(maxBytes / 2));
    const stderr = readStreamDelta(paths.jobDir, "stderr", position.stderr, maxBytes - Math.floor(maxBytes / 2));
    const nextCursor = { stdout: stdout.cursor, stderr: stderr.cursor };
    return {
      ok: true,
      protocolVersion: JOB_PROTOCOL_VERSION,
      schemaVersion: JOB_SCHEMA_VERSION,
      action: "delta",
      job: publicState(state),
      output: {
        stdout: redactCommandOutput(stdout.text),
        stderr: redactCommandOutput(stderr.text)
      },
      cursor: encodeCursor(nextCursor),
      bytesRead: stdout.bytesRead + stderr.bytesRead,
      truncated: stdout.truncated || stderr.truncated,
      hasMore: stdout.hasMore || stderr.hasMore
    };
  } catch (error) {
    return jobFailure(error);
  }
}

export async function cancelJob(root, jobId, options = {}) {
  try {
    rejectExternalState(options);
    const paths = jobPaths(root, jobId);
    const state = readState(paths.jobDir);
    if (!isActiveState(state)) {
      return {
        ok: true,
        protocolVersion: JOB_PROTOCOL_VERSION,
        schemaVersion: JOB_SCHEMA_VERSION,
        action: "cancel",
        cancelled: false,
        reason: "already-finished",
        job: publicState(state)
      };
    }
    if (!workerMatches(state) && state.status === "starting" && withinWorkerSettleGrace(state)) {
      updateState(paths.jobDir, state.instanceId, (current) => ({ ...current, cancelRequested: true }));
      discardCommandPayload(paths.jobDir);
      return {
        ok: true,
        protocolVersion: JOB_PROTOCOL_VERSION,
        schemaVersion: JOB_SCHEMA_VERSION,
        action: "cancel",
        cancelled: true,
        jobId,
        instanceVerified: false,
        signalSent: false,
        pendingWorkerAcknowledgement: true
      };
    }
    if (!workerMatches(state)) {
      const lost = updateState(paths.jobDir, state.instanceId, (current) => ({
        ...current,
        status: "lost",
        completedAt: new Date().toISOString(),
        terminationReason: "worker-identity-mismatch"
      }));
      return fail("JOB_IDENTITY_MISMATCH", "Refusing to signal a worker whose PID and instance cannot be verified", {
        jobId,
        status: lost.status
      });
    }
    updateState(paths.jobDir, state.instanceId, (current) => ({ ...current, cancelRequested: true }));
    if (state.status === "starting") {
      discardCommandPayload(paths.jobDir);
      return {
        ok: true,
        protocolVersion: JOB_PROTOCOL_VERSION,
        schemaVersion: JOB_SCHEMA_VERSION,
        action: "cancel",
        cancelled: true,
        jobId,
        instanceVerified: true,
        pendingWorkerAcknowledgement: true
      };
    }
    try {
      process.kill(state.workerPid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    return {
      ok: true,
      protocolVersion: JOB_PROTOCOL_VERSION,
      schemaVersion: JOB_SCHEMA_VERSION,
      action: "cancel",
      cancelled: true,
      jobId,
      instanceVerified: true
    };
  } catch (error) {
    return jobFailure(error);
  }
}

export async function runJobWorker({ root, jobId, instanceId, logWriterFactory = createLogWriter, killGraceMs = KILL_GRACE_MS }) {
  const paths = jobPaths(root, jobId);
  let state = readState(paths.jobDir);
  if (state.instanceId !== instanceId) throw codedError("JOB_IDENTITY_MISMATCH", "Worker instance does not match persisted state");
  if (state.workerPid && state.workerPid !== process.pid) throw codedError("JOB_IDENTITY_MISMATCH", "Worker PID does not match persisted state");
  if (state.cancelRequested) {
    discardCommandPayload(paths.jobDir);
    updateState(paths.jobDir, instanceId, (current) => ({
      ...current,
      workerPid: process.pid,
      status: "cancelled",
      completedAt: new Date().toISOString(),
      terminationReason: "cancelled-before-start"
    }));
    return;
  }
  state = updateState(paths.jobDir, instanceId, (current) => ({
    ...current,
    workerPid: process.pid,
    status: "running"
  }));
  let command;
  try {
    command = consumeCommandPayload(paths.jobDir, jobId, instanceId);
  } catch (error) {
    updateState(paths.jobDir, instanceId, (current) => current.cancelRequested ? ({
      ...current,
      status: "cancelled",
      completedAt: new Date().toISOString(),
      terminationReason: "cancelled-before-start"
    }) : ({
      ...current,
      status: "failed",
      exitCode: 127,
      completedAt: new Date().toISOString(),
      terminationReason: "command-payload-unavailable",
      spawnError: String(error?.code || "JOB_PAYLOAD_INVALID")
    }));
    return;
  }
  state = readState(paths.jobDir);
  if (state.cancelRequested) {
    updateState(paths.jobDir, instanceId, (current) => ({
      ...current,
      status: "cancelled",
      completedAt: new Date().toISOString(),
      terminationReason: "cancelled-before-start"
    }));
    return;
  }

  const writers = Object.fromEntries(STREAMS.map((stream) => [stream, logWriterFactory(paths.jobDir, stream, state.log)]));
  let child = null;
  let timeout = null;
  let forceKill = null;
  let terminationReason = null;
  let timedOut = false;
  let settled = false;
  let outputFailure = null;

  const terminateOwnedGroup = (reason) => {
    const current = safeReadState(paths.jobDir);
    if (!current || current.instanceId !== instanceId || current.workerPid !== process.pid) return false;
    terminationReason = reason;
    if (!child?.pid) return true;
    signalOwnedProcessGroup(child, "SIGTERM");
    forceKill = setTimeout(() => {
      if (ownedProcessGroupMatches(paths.jobDir, instanceId, process.pid, child.pid)) {
        signalOwnedProcessGroup(child, "SIGKILL");
      }
    }, boundedInteger(killGraceMs, KILL_GRACE_MS, 25, 5_000));
    forceKill.unref?.();
    return true;
  };

  const captureOutput = (stream, chunk) => {
    if (outputFailure) return;
    try {
      writers[stream].write(chunk);
    } catch (error) {
      outputFailure = error;
      terminateOwnedGroup("log-write-failed");
    }
  };

  const onTerminate = () => terminateOwnedGroup("cancelled");
  process.once("SIGTERM", onTerminate);
  process.once("SIGINT", onTerminate);

  try {
    child = spawn(command[0], command.slice(1), {
      cwd: paths.root,
      env: sanitizedCommandEnv(process.env),
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true
    });
    state = updateState(paths.jobDir, instanceId, (current) => ({ ...current, pid: child.pid || null }));
    child.stdout?.on("data", (chunk) => captureOutput("stdout", chunk));
    child.stderr?.on("data", (chunk) => captureOutput("stderr", chunk));
    timeout = setTimeout(() => {
      timedOut = true;
      terminateOwnedGroup("timeout");
    }, state.timeoutMs);
    timeout.unref?.();

    const result = await new Promise((resolve) => {
      let spawnError = null;
      child.once("error", (error) => { spawnError = error; });
      child.once("close", (code, signal) => resolve({ code, signal, spawnError }));
    });
    settled = true;
    if (timeout) clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
    const finalStatus = timedOut ? "timed_out" : terminationReason === "cancelled" ? "cancelled" : (outputFailure || result.spawnError || result.code !== 0 ? "failed" : "completed");
    updateState(paths.jobDir, instanceId, (current) => ({
      ...current,
      status: finalStatus,
      exitCode: result.spawnError ? 127 : (Number.isInteger(result.code) ? result.code : null),
      signal: result.signal || null,
      timedOut,
      completedAt: new Date().toISOString(),
      terminationReason: terminationReason || (result.spawnError ? "spawn-failed" : null),
      spawnError: outputFailure
        ? String(outputFailure.code || outputFailure.message || "LOG_WRITE_FAILED")
        : (result.spawnError ? String(result.spawnError.code || result.spawnError.message) : null),
      log: {
        ...current.log,
        stdoutBytes: writers.stdout.totalBytes,
        stderrBytes: writers.stderr.totalBytes
      }
    }));
  } catch (error) {
    if (!settled && child?.pid) terminateOwnedGroup("worker-error");
    updateState(paths.jobDir, instanceId, (current) => ({
      ...current,
      status: "failed",
      exitCode: 127,
      completedAt: new Date().toISOString(),
      terminationReason: "worker-error",
      spawnError: String(error?.code || error?.message || "WORKER_ERROR")
    }));
  } finally {
    if (timeout) clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
    process.removeListener("SIGTERM", onTerminate);
    process.removeListener("SIGINT", onTerminate);
  }
}

export function sourceJobWorkerScript() {
  return path.join(resolvePackageRoot(), "src", "commands", "job.js");
}

export function ownedProcessGroupMatches(jobDir, instanceId, workerPid, childPid) {
  const current = safeReadState(jobDir);
  if (!current || current.instanceId !== instanceId || current.workerPid !== workerPid || current.pid !== childPid) return false;
  if (!Number.isInteger(childPid) || childPid <= 1) return false;
  try { process.kill(childPid, 0); } catch { return false; }
  if (process.platform === "win32") return true;
  const inspected = spawnSync("ps", ["-p", String(childPid), "-o", "pgid="], {
    encoding: "utf8",
    timeout: 1000,
    shell: false,
    windowsHide: true
  });
  if (inspected.status !== 0) return false;
  return Number(String(inspected.stdout || "").trim()) === childPid;
}

function validateArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) throw codedError("INVALID_ARGUMENT", "Job command must be a non-empty argv array");
  if (argv.length > MAX_ARGV) throw codedError("ARGUMENT_LIMIT_EXCEEDED", `Job argv may contain at most ${MAX_ARGV} entries`);
  let total = 0;
  const normalized = argv.map((value) => {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw codedError("INVALID_ARGUMENT", "Every argv entry must be a non-empty string without NUL bytes");
    const bytes = Buffer.byteLength(value);
    if (bytes > MAX_ARG_BYTES) throw codedError("ARGUMENT_LIMIT_EXCEEDED", `Each argv entry is limited to ${MAX_ARG_BYTES} bytes`);
    total += bytes;
    return value;
  });
  if (total > MAX_ARGV_BYTES) throw codedError("ARGUMENT_LIMIT_EXCEEDED", `Combined argv is limited to ${MAX_ARGV_BYTES} bytes`);
  return normalized;
}

function canonicalWorkspaceRoot(root) {
  if (typeof root !== "string" || !root.trim()) throw codedError("INVALID_WORKSPACE_ROOT", "Workspace root is required");
  let resolved;
  try { resolved = fs.realpathSync(path.resolve(root)); } catch { throw codedError("INVALID_WORKSPACE_ROOT", "Workspace root must be an existing directory"); }
  if (!fs.statSync(resolved).isDirectory()) throw codedError("INVALID_WORKSPACE_ROOT", "Workspace root must be a directory");
  const filesystemRoot = path.parse(resolved).root;
  const home = fs.realpathSync(os.homedir());
  if (resolved === filesystemRoot || resolved === home) throw codedError("UNSAFE_WORKSPACE_ROOT", "Refusing to run jobs from the filesystem root or home directory");
  return resolved;
}

function rejectExternalState(options) {
  if (options.stateDir || options.jobsDir) throw codedError("EXTERNAL_STATE_PATH_REJECTED", "Job state is fixed to <workspace>/.agentshell/jobs");
}

function normalizeLimits(options) {
  return {
    timeoutMs: boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 10, MAX_TIMEOUT_MS),
    maxJobs: boundedInteger(options.maxJobs, DEFAULT_MAX_JOBS, 1, MAX_JOBS),
    segmentBytes: boundedInteger(options.segmentBytes, DEFAULT_SEGMENT_BYTES, 1024, MAX_SEGMENT_BYTES),
    maxSegments: boundedInteger(options.maxSegments, DEFAULT_MAX_SEGMENTS, 1, MAX_SEGMENTS)
  };
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw codedError("UNSAFE_STATE_PATH", "Job state directories must not be symlinks");
  fs.chmodSync(directory, 0o700);
}

async function acquireAdmissionLock(jobsDir) {
  const lockPath = path.join(jobsDir, ".admission.lock");
  const deadline = Date.now() + ADMISSION_LOCK_WAIT_MS;
  const lockId = crypto.randomUUID();
  while (true) {
    let descriptor = null;
    let acquired = false;
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      acquired = true;
      fs.writeFileSync(descriptor, `${JSON.stringify({ lockId, pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      fs.closeSync(descriptor);
      descriptor = null;
      return () => releaseAdmissionLock(lockPath, lockId);
    } catch (error) {
      if (descriptor != null) {
        try { fs.closeSync(descriptor); } catch {}
      }
      if (acquired) fs.rmSync(lockPath, { force: true });
      if (error?.code !== "EEXIST") throw error;
      if (admissionLockIsStale(lockPath)) {
        try { fs.rmSync(lockPath); } catch (removeError) {
          if (removeError?.code !== "ENOENT") throw removeError;
        }
        continue;
      }
      if (Date.now() >= deadline) throw codedError("JOB_ADMISSION_BUSY", "Timed out waiting for the workspace job admission lock");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function releaseAdmissionLock(lockPath, lockId) {
  try {
    const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (owner.lockId === lockId && owner.pid === process.pid) fs.rmSync(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function admissionLockIsStale(lockPath) {
  try {
    const stat = fs.lstatSync(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw codedError("UNSAFE_STATE_PATH", "Job admission lock must be a regular file");
    const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (Number.isInteger(owner.pid) && owner.pid > 1) {
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch (error) {
        if (error?.code !== "ESRCH") return false;
        return true;
      }
    }
    return Date.now() - stat.mtimeMs >= ADMISSION_LOCK_STALE_MS;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    if (error?.code) throw error;
    try { return Date.now() - fs.statSync(lockPath).mtimeMs >= ADMISSION_LOCK_STALE_MS; } catch { return false; }
  }
}

function writeJsonAtomic(target, value) {
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
}

function consumeCommandPayload(jobDir, jobId, instanceId) {
  const target = path.join(jobDir, COMMAND_PAYLOAD_FILE);
  let descriptor = null;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(target, flags);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw codedError("JOB_PAYLOAD_INVALID", "Job command payload must be a regular file");
    const payload = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    if (
      payload.protocolVersion !== JOB_PROTOCOL_VERSION
      || payload.schemaVersion !== JOB_SCHEMA_VERSION
      || payload.jobId !== jobId
      || payload.instanceId !== instanceId
    ) {
      throw codedError("JOB_PAYLOAD_INVALID", "Job command payload identity is invalid");
    }
    return validateArgv(payload.argv);
  } catch (error) {
    if (error?.code === "ENOENT") throw codedError("JOB_PAYLOAD_MISSING", "One-time job command payload is missing");
    if (error?.code) throw error;
    throw codedError("JOB_PAYLOAD_INVALID", "One-time job command payload is unreadable");
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
    fs.rmSync(target, { force: true });
  }
}

function discardCommandPayload(jobDir) {
  fs.rmSync(path.join(jobDir, COMMAND_PAYLOAD_FILE), { force: true });
}

function readState(jobDir) {
  assertPrivateJobDirectory(jobDir);
  const target = path.join(jobDir, "state.json");
  let state;
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe state file");
    state = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch { throw codedError("JOB_NOT_FOUND", "Job state does not exist or is unreadable"); }
  if (state.protocolVersion !== JOB_PROTOCOL_VERSION || state.schemaVersion !== JOB_SCHEMA_VERSION) throw codedError("JOB_STATE_INVALID", "Job state protocol is unsupported");
  validateJobId(state.jobId);
  return state;
}

function safeReadState(jobDir) {
  try { return readState(jobDir); } catch { return null; }
}

function updateState(jobDir, instanceId, updater) {
  const current = readState(jobDir);
  if (current.instanceId !== instanceId) throw codedError("JOB_IDENTITY_MISMATCH", "Persisted job instance changed");
  const next = { ...updater(current), updatedAt: new Date().toISOString() };
  writeJsonAtomic(path.join(jobDir, "state.json"), next);
  return next;
}

function listStates(jobsDir) {
  if (!fs.existsSync(jobsDir)) return [];
  return fs.readdirSync(jobsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-z0-9-]{8,80}$/u.test(entry.name))
    .map((entry) => safeReadState(path.join(jobsDir, entry.name)))
    .filter(Boolean);
}

function recoverJobs(jobsDir) {
  for (const state of listStates(jobsDir)) {
    if (!isActiveState(state) || workerMatches(state) || withinWorkerSettleGrace(state)) continue;
    try { reconcileMissingWorker(path.join(jobsDir, state.jobId), state); } catch {}
  }
}

function reconcileMissingWorker(jobDir, observed, options = {}) {
  const latest = readState(jobDir);
  const markerPath = path.join(jobDir, "reconcile.json");
  if (!isActiveState(latest) || workerMatches(latest)) {
    fs.rmSync(markerPath, { force: true });
    return latest;
  }
  const now = options.now ? options.now() : Date.now();
  const graceMs = boundedInteger(
    options.completionGraceMs,
    COMPLETION_RECONCILE_GRACE_MS,
    50,
    5_000
  );
  const marker = readReconciliationMarker(markerPath, latest.instanceId);
  if (!marker) {
    writeJsonAtomic(markerPath, {
      protocolVersion: JOB_PROTOCOL_VERSION,
      jobId: latest.jobId,
      instanceId: latest.instanceId,
      workerMissingSince: new Date(now).toISOString()
    });
    return readState(jobDir);
  }
  const missingSince = Date.parse(marker.workerMissingSince);
  if (now - missingSince < graceMs) return latest;
  const reconciled = updateState(jobDir, observed.instanceId, (current) => {
    if (!isActiveState(current)) return current;
    return {
      ...current,
      status: "lost",
      completedAt: current.completedAt || new Date(now).toISOString(),
      terminationReason: "worker-unavailable"
    };
  });
  discardCommandPayload(jobDir);
  fs.rmSync(markerPath, { force: true });
  return reconciled;
}

function readReconciliationMarker(markerPath, instanceId) {
  try {
    const stat = fs.lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (marker.protocolVersion !== JOB_PROTOCOL_VERSION || marker.instanceId !== instanceId) return null;
    if (!Number.isFinite(Date.parse(marker.workerMissingSince || ""))) return null;
    return marker;
  } catch {
    return null;
  }
}

function workerMatches(state) {
  if (!Number.isInteger(state?.workerPid) || state.workerPid <= 1 || typeof state.instanceId !== "string") return false;
  try { process.kill(state.workerPid, 0); } catch { return false; }
  if (process.platform === "win32") return false;
  const inspected = spawnSync("ps", ["-p", String(state.workerPid), "-o", "command="], {
    encoding: "utf8",
    timeout: 1000,
    shell: false,
    windowsHide: true
  });
  if (inspected.status !== 0) return false;
  const command = inspected.stdout || "";
  return command.includes("--job") && command.includes(state.jobId) && command.includes("--instance") && command.includes(state.instanceId);
}

function createLogWriter(jobDir, stream, limits) {
  let segment = newestSegment(jobDir, stream) ?? 0;
  let segmentBytes = existingSegmentBytes(jobDir, stream, segment);
  let totalBytes = 0;
  return {
    get totalBytes() { return totalBytes; },
    write(value) {
      let buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
      totalBytes += buffer.length;
      while (buffer.length > 0) {
        if (segmentBytes >= limits.segmentBytes) {
          segment += 1;
          segmentBytes = 0;
          pruneSegments(jobDir, stream, segment, limits.maxSegments);
        }
        const kept = buffer.subarray(0, limits.segmentBytes - segmentBytes);
        const target = logPath(jobDir, stream, segment);
        fs.appendFileSync(target, kept, { mode: 0o600 });
        fs.chmodSync(target, 0o600);
        segmentBytes += kept.length;
        buffer = buffer.subarray(kept.length);
      }
    }
  };
}

function readStreamDelta(jobDir, stream, cursor, maxBytes) {
  let segments = listSegments(jobDir, stream);
  if (segments.length === 0) return { text: "", bytesRead: 0, cursor, truncated: false, hasMore: false };
  let segment = cursor.segment;
  let offset = cursor.offset;
  let truncated = false;
  if (segment < segments[0]) {
    segment = segments[0];
    offset = 0;
    truncated = true;
  }
  const pieces = [];
  let collectedBytes = 0;
  let current = { segment, offset };
  for (const number of segments) {
    if (number < segment || collectedBytes >= maxBytes) continue;
    const target = logPath(jobDir, stream, number);
    let buffer;
    try {
      buffer = fs.readFileSync(target);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      truncated = true;
      current = { segment: number + 1, offset: 0 };
      continue;
    }
    const start = number === segment ? Math.min(offset, buffer.length) : 0;
    const remaining = maxBytes - collectedBytes;
    const kept = buffer.subarray(start, start + remaining);
    pieces.push({ segment: number, start, end: start + kept.length, segmentBytes: buffer.length, buffer: kept });
    collectedBytes += kept.length;
  }
  const collected = Buffer.concat(pieces.map((piece) => piece.buffer));
  const leadingContinuationBytes = countLeadingUtf8ContinuationBytes(collected);
  const decodedBytes = completeUtf8PrefixLength(collected.subarray(leadingContinuationBytes));
  const bytesRead = leadingContinuationBytes + decodedBytes;
  if (leadingContinuationBytes > 0) truncated = true;
  let remainingAdvance = bytesRead;
  for (const piece of pieces) {
    if (remainingAdvance <= 0) break;
    const advance = Math.min(remainingAdvance, piece.buffer.length);
    current = { segment: piece.segment, offset: piece.start + advance };
    remainingAdvance -= advance;
    if (advance === piece.buffer.length && piece.end === piece.segmentBytes && segments.some((number) => number > piece.segment)) {
      current = { segment: piece.segment + 1, offset: 0 };
    }
  }
  segments = listSegments(jobDir, stream);
  const hasMore = streamHasMore(jobDir, stream, segments, current);
  return {
    text: collected.subarray(leadingContinuationBytes, leadingContinuationBytes + decodedBytes).toString("utf8"),
    bytesRead,
    cursor: current,
    truncated,
    hasMore
  };
}

function countLeadingUtf8ContinuationBytes(buffer) {
  let count = 0;
  while (count < buffer.length && (buffer[count] & 0xc0) === 0x80) count += 1;
  return count;
}

function completeUtf8PrefixLength(buffer) {
  if (buffer.length === 0) return 0;
  let lead = buffer.length - 1;
  while (lead >= 0 && (buffer[lead] & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return 0;
  const byte = buffer[lead];
  const expected = byte < 0x80 ? 1 : byte >= 0xc2 && byte <= 0xdf ? 2 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 1;
  return buffer.length - lead < expected ? lead : buffer.length;
}

function streamHasMore(jobDir, stream, segments, cursor) {
  for (const segment of segments) {
    if (segment < cursor.segment) continue;
    try {
      const size = fs.statSync(logPath(jobDir, stream, segment)).size;
      if (segment > cursor.segment || size > cursor.offset) return true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return false;
}

function listSegments(jobDir, stream) {
  if (!fs.existsSync(jobDir)) return [];
  const pattern = new RegExp(`^${stream}\\.(\\d{6})\\.log$`, "u");
  return fs.readdirSync(jobDir).map((name) => pattern.exec(name)).filter(Boolean).map((match) => Number(match[1])).sort((a, b) => a - b);
}

function newestSegment(jobDir, stream) {
  return listSegments(jobDir, stream).at(-1);
}

function existingSegmentBytes(jobDir, stream, segment) {
  const target = logPath(jobDir, stream, segment);
  return fs.existsSync(target) ? fs.statSync(target).size : 0;
}

function pruneSegments(jobDir, stream, newest, maxSegments) {
  const minimum = newest - maxSegments + 1;
  for (const segment of listSegments(jobDir, stream)) {
    if (segment < minimum) fs.rmSync(logPath(jobDir, stream, segment), { force: true });
  }
}

function logPath(jobDir, stream, segment) {
  return path.join(jobDir, `${stream}.${String(segment).padStart(6, "0")}.log`);
}

function emptyCursor() {
  return { stdout: { segment: 0, offset: 0 }, stderr: { segment: 0, offset: 0 } };
}

function encodeCursor(cursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value) {
  if (value == null || value === "") return emptyCursor();
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    for (const stream of STREAMS) {
      if (!Number.isInteger(parsed?.[stream]?.segment) || parsed[stream].segment < 0 || !Number.isInteger(parsed[stream].offset) || parsed[stream].offset < 0) throw new Error("bad cursor");
    }
    return parsed;
  } catch {
    throw codedError("INVALID_CURSOR", "Job delta cursor is malformed");
  }
}

function publicState(state) {
  return {
    jobId: state.jobId,
    status: state.status,
    argv: redactArgv(state.argv),
    pid: state.pid,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    completedAt: state.completedAt,
    timeoutMs: state.timeoutMs,
    exitCode: state.exitCode,
    signal: state.signal,
    timedOut: state.timedOut,
    cancelRequested: state.cancelRequested,
    terminationReason: state.terminationReason,
    log: state.log
  };
}

function assertPrivateJobDirectory(jobDir) {
  let stat;
  try { stat = fs.lstatSync(jobDir); } catch { throw codedError("JOB_NOT_FOUND", "Job directory does not exist"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(jobDir) !== path.resolve(jobDir)) {
    throw codedError("UNSAFE_STATE_PATH", "Job directory must be a real workspace-local directory");
  }
}

function redactArgv(argv) {
  const sensitiveFlag = /^(?:--?(?:api[-_]?key|access[-_]?token|auth[-_]?token|password|passwd|secret))$/iu;
  return argv.map((value, index) => sensitiveFlag.test(argv[index - 1] || "") ? "[REDACTED]" : redactCommandOutput(value));
}

function fingerprintRoot(root) {
  return `sha256:${crypto.createHash("sha256").update(root).digest("hex")}`;
}

function validateJobId(jobId) {
  if (typeof jobId !== "string" || !/^[a-z0-9-]{8,80}$/u.test(jobId)) throw codedError("INVALID_JOB_ID", "Job ID is malformed");
  return jobId;
}

function createJobId(now) {
  return `job-${Number(now()).toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
}

function sanitizedWorkerEnv(env = process.env) {
  return sanitizedCommandEnv(env);
}

function sanitizedCommandEnv(env) {
  const copy = { ...env };
  delete copy.AGENTSHELL_PACKAGE_ROOT;
  delete copy.AGENTSHELL_JOB_WORKER;
  delete copy.NODE_OPTIONS;
  return copy;
}

function signalOwnedProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {}
}

function isActiveState(state) {
  return ["starting", "running"].includes(state?.status);
}

function withinWorkerSettleGrace(state) {
  const updated = Date.parse(state?.updatedAt || "");
  return Number.isFinite(updated) && Date.now() - updated < WORKER_SETTLE_GRACE_MS;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function jobFailure(error) {
  return fail(error?.code || "JOB_OPERATION_FAILED", error?.message || "Job operation failed", {
    shellInterpolation: false,
    stateLocation: "<workspace>/.agentshell/jobs"
  });
}
