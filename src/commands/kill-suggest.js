import { fail } from "../core/output.js";
import { portList } from "./port.js";

const PROTOCOL_VERSION = "agentshell.kill-suggest.v1";
const CRITICAL_PROCESS = /^(launchd|systemd|kernel_task|windowserver|loginwindow|sshd|init)$/i;

export async function killSuggest(root, options = {}) {
  const compact = options.compact === undefined ? true : Boolean(options.compact);
  const pid = normalizePid(options.pid);
  const port = normalizePort(options.port);

  if ((options.pid === undefined) === (options.port === undefined)) {
    return fail("INVALID_TARGET", "Provide exactly one of --pid or --port", {
      pid: options.pid ?? null,
      port: options.port ?? null
    });
  }
  if (options.pid !== undefined && pid === null) {
    return fail("INVALID_PID", "PID must be a positive integer", { pid: options.pid });
  }
  if (options.port !== undefined && port === null) {
    return fail("INVALID_PORT", "Port must be an integer between 1 and 65535", { port: options.port });
  }

  let processes;
  if (pid !== null) {
    processes = [{ pid, command: null, protocol: null, port: null }];
  } else {
    const inspection = await portList(root, {
      compact: true,
      port,
      platform: options.platform,
      runCommand: options.runCommand,
      limit: 200
    });
    if (!inspection.ok) return inspection;
    processes = uniqueProcesses(inspection.ports);
  }

  const suggestions = processes.map((processInfo) => buildSuggestion(processInfo, pid !== null ? "pid" : "port"));
  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact,
    target: pid !== null ? { type: "pid", value: pid } : { type: "port", value: port },
    summary: {
      matchedProcesses: processes.length,
      suggestionCount: suggestions.length,
      highestRisk: highestRisk(suggestions),
      executed: false
    },
    processes,
    suggestions,
    suggestedNextActions: nextActions(pid, port, suggestions)
  };
}

function buildSuggestion(processInfo, source) {
  const risk = riskFor(processInfo, source);
  return {
    pid: processInfo.pid,
    command: `kill -TERM ${processInfo.pid}`,
    signal: "SIGTERM",
    risk: risk.level,
    reason: risk.reason
  };
}

function riskFor(processInfo, source) {
  if (processInfo.pid === 1) {
    return { level: "critical", reason: "PID 1 is the operating system service manager and must not be terminated" };
  }
  if (processInfo.pid === process.pid) {
    return { level: "high", reason: "This PID belongs to the active AgentShell process" };
  }
  if (CRITICAL_PROCESS.test(processInfo.command || "")) {
    return { level: "critical", reason: `${processInfo.command} is a critical system process` };
  }
  if (source === "pid" || !processInfo.command) {
    return { level: "medium", reason: "The process identity was not verified; inspect it before running this command" };
  }
  return { level: "low", reason: `SIGTERM allows ${processInfo.command} to shut down gracefully` };
}

function uniqueProcesses(ports) {
  const byPid = new Map();
  for (const entry of ports) {
    if (!Number.isInteger(entry.pid) || entry.pid < 1 || byPid.has(entry.pid)) continue;
    byPid.set(entry.pid, {
      pid: entry.pid,
      command: entry.command,
      protocol: entry.protocol,
      port: entry.port
    });
  }
  return [...byPid.values()];
}

function highestRisk(suggestions) {
  const order = ["none", "low", "medium", "high", "critical"];
  return suggestions.reduce((highest, suggestion) => (
    order.indexOf(suggestion.risk) > order.indexOf(highest) ? suggestion.risk : highest
  ), "none");
}

function nextActions(pid, port, suggestions) {
  if (suggestions.length === 0 && port !== null) {
    return [{
      command: `agentshell port list --port ${port} --compact`,
      reason: "No process was found for this port; verify that it is still in use"
    }];
  }
  return [{
    command: pid !== null
      ? `agentshell ps --compact`
      : `agentshell port list --port ${port} --compact`,
    reason: "Re-inspect process or port state before manually running a suggested command"
  }];
}

function normalizePid(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 2147483647 ? parsed : null;
}

function normalizePort(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : null;
}
