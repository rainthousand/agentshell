import path from "node:path";
import { spawn } from "node:child_process";

import { fail } from "../core/output.js";
import {
  getRuntimeProjectMetadata,
  requestRuntime,
  runtimeStatus,
  startRuntimeDaemon,
  stopRuntimeDaemon
} from "../core/runtime-daemon.js";

export async function runtimeCommand(root, action, options = {}) {
  switch (action) {
    case "start": {
      if (options.foreground) {
        const session = await startRuntimeDaemon(options);
        return options.returnSession ? session : session.report;
      }
      return startRuntimeBackground(options);
    }
    case "status":
      return runtimeStatus(options);
    case "stop":
      return stopRuntimeDaemon(options);
    case "request":
      return getRuntimeProjectMetadata(root, options);
    case "invalidate":
      return requestRuntime({ action: "cache.invalidate", root }, options);
    case "raw-request":
      return requestRuntime(options.request, options);
    default:
      return fail("INVALID_RUNTIME_ACTION", "Runtime action must be start, status, stop, or request", {
        action: action || null
      }, [{
        command: "agentshell runtime status --compact",
        reason: "Inspect the local read-only runtime before starting it"
      }]);
  }
}

export async function startRuntimeBackground(options = {}) {
  const current = await runtimeStatus(options);
  if (current.running) return { ...current, reused: true };
  const isNode = /^node(?:\.exe)?$/iu.test(path.basename(process.execPath));
  const args = isNode
    ? [process.argv[1], "runtime", "serve"]
    : ["runtime", "serve"];
  const child = (options.spawn || spawn)(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ...(options.runtimeDir ? { AGENTSHELL_RUNTIME_DIR: options.runtimeDir } : {})
    }
  });
  child.unref?.();
  const attempts = positiveInteger(options.startupAttempts, 30);
  const pollMs = positiveInteger(options.startupPollMs, 25);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const status = await runtimeStatus(options);
    if (status.running) return { ...status, started: true, reused: false };
  }
  const termination = await terminateBackgroundChild(child, options);
  return fail("RUNTIME_START_TIMEOUT", "Runtime process did not become ready within the startup window", {
    startupWindowMs: attempts * pollMs,
    termination
  });
}

async function terminateBackgroundChild(child, options = {}) {
  const pid = Number.isInteger(child?.pid) && child.pid > 0 ? child.pid : null;
  if (pid === null) {
    return { attempted: false, pid: null, processGroup: null, signal: null, escalated: false, exited: false };
  }

  const graceMs = positiveInteger(options.terminationGraceMs, 250);
  const sendSignal = (signal) => signalProcessGroup(child, signal, options.kill || process.kill);
  const termSent = sendSignal("SIGTERM");
  let exited = await waitForChildExit(child, graceMs);
  let killSent = false;
  if (!exited) {
    killSent = sendSignal("SIGKILL");
    exited = await waitForChildExit(child, graceMs);
  }
  return {
    attempted: true,
    pid,
    processGroup: -pid,
    signal: killSent ? "SIGKILL" : termSent ? "SIGTERM" : null,
    escalated: killSent,
    exited,
    exitCode: Number.isInteger(child.exitCode) ? child.exitCode : null,
    exitSignal: child.signalCode || null
  };
}

function signalProcessGroup(child, signal, kill) {
  try {
    kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    try { return child.kill?.(signal) !== false; } catch { return false; }
  }
}

function waitForChildExit(child, timeoutMs) {
  if ((child.exitCode !== null && child.exitCode !== undefined) || child.signalCode) return Promise.resolve(true);
  if (typeof child.once !== "function") return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off?.("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export const startRuntime = (options = {}) => startRuntimeDaemon(options);
export const statusRuntime = (options = {}) => runtimeStatus(options);
export const stopRuntime = (options = {}) => stopRuntimeDaemon(options);
export const runtimeRequest = (root, options = {}) => getRuntimeProjectMetadata(root, options);
