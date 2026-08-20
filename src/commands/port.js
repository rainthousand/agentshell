import { spawnSync } from "node:child_process";

import { fail } from "../core/output.js";

const PROTOCOL_VERSION = "agentshell.port-list.v1";
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;

export async function portList(root, options = {}) {
  const compact = options.compact === undefined ? true : Boolean(options.compact);
  const port = normalizePort(options.port);
  if (options.port !== undefined && port === null) {
    return fail("INVALID_PORT", "Port must be an integer between 1 and 65535", { port: options.port });
  }

  const platform = options.platform || process.platform;
  const runCommand = options.runCommand || defaultRunCommand;
  const inspected = platform === "darwin"
    ? inspectWithLsof(root, runCommand)
    : inspectWithSs(root, runCommand);
  if (!inspected.ok) return inspected.error;

  const filtered = port === null
    ? inspected.entries
    : inspected.entries.filter((entry) => entry.port === port);
  const unique = deduplicate(filtered).sort((left, right) => left.port - right.port || left.pid - right.pid);
  const limit = normalizeLimit(options.limit);
  const ports = unique.slice(0, limit);

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact,
    platform,
    summary: {
      filterPort: port,
      matchedSockets: unique.length,
      returnedSockets: ports.length,
      processCount: new Set(unique.map((entry) => entry.pid)).size,
      truncated: ports.length < unique.length
    },
    ports,
    suggestedNextActions: suggestedNextActions(port, ports, ports.length < unique.length)
  };
}

export function parseLsofOutput(output) {
  const entries = [];
  let processInfo = { pid: null, command: null };
  let socket = null;

  const flush = () => {
    if (socket?.address && processInfo.pid !== null) {
      const endpoint = parseEndpoint(socket.address);
      if (endpoint.port !== null) {
        const state = socket.state || (socket.protocol === "udp" ? "UNCONN" : "UNKNOWN");
        entries.push({
          pid: processInfo.pid,
          command: processInfo.command || "unknown",
          protocol: socket.protocol || "unknown",
          address: endpoint.address,
          port: endpoint.port,
          state,
          listen: state === "LISTEN" || socket.protocol === "udp"
        });
      }
    }
    socket = null;
  };

  for (const line of String(output || "").split(/\r?\n/)) {
    if (!line) continue;
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      flush();
      processInfo = { pid: Number(value), command: null };
    } else if (field === "c") {
      processInfo.command = value;
    } else if (field === "f" || field === "P") {
      flush();
      if (field === "P") socket = { protocol: value.toLowerCase(), address: null, state: null };
    } else if (field === "n") {
      if (!socket) socket = { protocol: "unknown", address: null, state: null };
      if (socket.address) flush();
      if (!socket) socket = { protocol: "unknown", address: null, state: null };
      socket.address = value;
    } else if (field === "T" && value.startsWith("ST=")) {
      if (socket) socket.state = value.slice(3).toUpperCase();
    }
  }
  flush();
  return entries.filter((entry) => entry.listen);
}

export function parseSsOutput(output) {
  const entries = [];
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 5) continue;
    const protocol = fields[0].toLowerCase();
    const state = fields[1].toUpperCase();
    const endpoint = parseEndpoint(fields[4]);
    if (endpoint.port === null) continue;
    const processMatch = line.match(/users:\(\(\"([^\"]+)\"[^)]*pid=(\d+)/);
    const alternateMatch = line.match(/pid=(\d+)[^)]*\(\"([^\"]+)\"/);
    const pid = processMatch ? Number(processMatch[2]) : alternateMatch ? Number(alternateMatch[1]) : 0;
    const command = processMatch ? processMatch[1] : alternateMatch ? alternateMatch[2] : "unknown";
    entries.push({
      pid,
      command,
      protocol,
      address: endpoint.address,
      port: endpoint.port,
      state,
      listen: state === "LISTEN" || state === "UNCONN"
    });
  }
  return entries.filter((entry) => entry.listen);
}

function inspectWithLsof(root, runCommand) {
  const result = runCommand("lsof", ["-nP", "-i", "-FpcPnT"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 4
  });
  if (result?.error?.code === "ENOENT") {
    return { ok: false, error: fail("PORT_TOOL_NOT_AVAILABLE", "lsof is required to inspect ports on macOS") };
  }
  if (!result || (![0, 1].includes(result.status))) {
    return { ok: false, error: fail("PORT_INSPECTION_FAILED", "Unable to inspect listening ports with lsof", {
      command: "lsof -nP -i -FpcPnT",
      stderr: String(result?.stderr || "").trim()
    }) };
  }
  return { ok: true, entries: parseLsofOutput(result.stdout) };
}

function inspectWithSs(root, runCommand) {
  const result = runCommand("ss", ["-H", "-lntup"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 4
  });
  if (result?.error?.code === "ENOENT") {
    return { ok: false, error: fail("PORT_TOOL_NOT_AVAILABLE", "ss is required to inspect ports on Linux", {
      platform: "linux"
    }) };
  }
  if (!result || result.status !== 0) {
    return { ok: false, error: fail("PORT_INSPECTION_FAILED", "Unable to inspect listening ports with ss", {
      command: "ss -H -lntup",
      stderr: String(result?.stderr || "").trim()
    }) };
  }
  return { ok: true, entries: parseSsOutput(result.stdout) };
}

function parseEndpoint(value) {
  const match = String(value || "").match(/^(.*):(\d+)$/);
  if (!match) return { address: String(value || ""), port: null };
  return { address: match[1] || "*", port: Number(match[2]) };
}

function deduplicate(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.pid}:${entry.protocol}:${entry.address}:${entry.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function suggestedNextActions(filterPort, ports, truncated) {
  const actions = [];
  if (filterPort !== null && ports.length > 0) {
    actions.push({
      command: `agentshell kill suggest --port ${filterPort} --compact`,
      reason: "Preview termination commands for the processes using this port"
    });
  } else if (filterPort === null && ports.length > 0) {
    actions.push({
      command: `agentshell port list --port ${ports[0].port} --compact`,
      reason: "Inspect one listening port before considering process termination"
    });
  }
  if (truncated) {
    actions.push({
      command: "agentshell port list --compact --limit 200",
      reason: "The listening socket list was truncated"
    });
  }
  return actions;
}

function normalizePort(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : null;
}

function normalizeLimit(value) {
  const parsed = Number(value || DEFAULT_LIMIT);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function defaultRunCommand(command, args, options) {
  return spawnSync(command, args, options);
}
