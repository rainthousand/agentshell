import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 512 * 1024;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const KILL_GRACE_MS = 250;

export function boundedProcessOptions(options = {}) {
  return {
    timeoutMs: boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS),
    maxOutputBytes: boundedInteger(
      options.maxOutputBytes,
      DEFAULT_OUTPUT_LIMIT_BYTES,
      256,
      MAX_OUTPUT_LIMIT_BYTES
    )
  };
}

export function runBoundedProcess(commandArgs, cwd, options = {}) {
  const limits = boundedProcessOptions(options);

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const env = { ...(options.env || process.env) };
    delete env.AGENTSHELL_PACKAGE_ROOT;

    let child;
    try {
      child = spawn(commandArgs[0], commandArgs.slice(1), {
        cwd,
        env,
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true
      });
    } catch (error) {
      resolve(spawnFailure(error, startedAt, limits));
      return;
    }

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let observedStdoutBytes = 0;
    let observedStderrBytes = 0;
    let capturedBytes = 0;
    let timedOut = false;
    let spawnError = null;
    let forceKillTimer = null;

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, "SIGTERM");
      forceKillTimer = setTimeout(() => terminateProcessTree(child, "SIGKILL"), KILL_GRACE_MS);
      forceKillTimer.unref?.();
    }, limits.timeoutMs);
    timeout.unref?.();

    function capture(stream, chunk) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stream === "stdout") observedStdoutBytes += value.length;
      else observedStderrBytes += value.length;

      const remaining = Math.max(0, limits.maxOutputBytes - capturedBytes);
      if (remaining === 0) return;
      const kept = value.subarray(0, remaining);
      capturedBytes += kept.length;
      if (stream === "stdout") stdout = Buffer.concat([stdout, kept]);
      else stderr = Buffer.concat([stderr, kept]);
    }

    child.stdout?.on("data", (chunk) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk) => capture("stderr", chunk));
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const errorText = spawnError?.message || "";
      if (errorText) {
        const remaining = Math.max(0, limits.maxOutputBytes - capturedBytes);
        const errorBuffer = Buffer.from(errorText);
        const kept = errorBuffer.subarray(0, remaining);
        stderr = Buffer.concat([stderr, kept]);
        capturedBytes += kept.length;
        observedStderrBytes += errorBuffer.length;
      }
      resolve({
        exitCode: spawnError ? 127 : (Number.isInteger(code) ? code : (timedOut ? 124 : 127)),
        signal: signal || null,
        durationMs: Date.now() - startedAt,
        timedOut,
        truncated: observedStdoutBytes + observedStderrBytes > capturedBytes,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        capturedBytes,
        observedBytes: observedStdoutBytes + observedStderrBytes,
        outputLimitBytes: limits.maxOutputBytes,
        spawnError: spawnError?.code || null
      });
    });
  });
}

function terminateProcessTree(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The process may have exited between the timeout and signal delivery.
  }
}

function spawnFailure(error, startedAt, limits) {
  const message = String(error?.message || "Unable to start command");
  return {
    exitCode: 127,
    signal: null,
    durationMs: Date.now() - startedAt,
    timedOut: false,
    truncated: Buffer.byteLength(message) > limits.maxOutputBytes,
    stdout: "",
    stderr: Buffer.from(message).subarray(0, limits.maxOutputBytes).toString("utf8"),
    capturedBytes: Math.min(Buffer.byteLength(message), limits.maxOutputBytes),
    observedBytes: Buffer.byteLength(message),
    outputLimitBytes: limits.maxOutputBytes,
    spawnError: error?.code || "SPAWN_ERROR"
  };
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}
