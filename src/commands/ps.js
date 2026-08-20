import path from "node:path";
import { spawnSync } from "node:child_process";

import { fail } from "../core/output.js";

const PROTOCOL_VERSION = "agentshell.ps.v1";
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const PROCESS_CATEGORIES = [
  ["agent", /\b(agentshell|codex|claude|cursor)\b/i],
  ["dashboard", /\b(vite|webpack|next|nuxt|astro|parcel|storybook|dashboard)\b/i],
  ["test", /\b(jest|vitest|mocha|pytest|playwright|cypress|go test|mvn test|gradle.*test)\b/i],
  ["container", /\b(docker|containerd|podman|colima)\b/i],
  ["database", /\b(postgres|mysqld|redis-server|mongod|elasticsearch)\b/i],
  ["runtime", /\b(node|bun|deno|python(?:3)?|java|go)\b/i],
  ["build-tool", /\b(npm|pnpm|yarn|mvn|gradle|make|cargo)\b/i]
];

export async function ps(root, options = {}) {
  const compact = options.compact === undefined ? true : Boolean(options.compact);
  const limit = normalizeLimit(options.limit);
  const runCommand = options.runCommand || defaultRunCommand;
  const result = runCommand("ps", ["-axo", "pid=,ppid=,user=,state=,etime=,comm=,args="], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 4
  });

  if (result?.error?.code === "ENOENT") {
    return fail("PS_NOT_AVAILABLE", "ps is not available on PATH");
  }
  if (!result || result.status !== 0) {
    return fail("PS_FAILED", "Unable to inspect running processes", {
      command: "ps -axo pid=,ppid=,user=,state=,etime=,comm=,args=",
      stderr: String(result?.stderr || "").trim()
    });
  }

  const parsed = parsePsOutput(result.stdout);
  const matches = parsed.filter((process) => options.all || process.category !== null);
  const processes = matches.slice(0, limit);

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact,
    summary: {
      scannedProcesses: parsed.length,
      matchedProcesses: matches.length,
      returnedProcesses: processes.length,
      truncated: processes.length < matches.length,
      filter: options.all ? "all" : "development"
    },
    processes,
    suggestedNextActions: suggestedNextActions(processes, matches.length > processes.length)
  };
}

export function parsePsOutput(output) {
  const processes = [];
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const match = rawLine.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
    if (!match) continue;
    const args = match[7] || "";
    const searchable = args || match[6];
    processes.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      user: match[3],
      state: match[4],
      elapsed: match[5],
      command: displayCommand(args, match[6]),
      category: processCategory(searchable)
    });
  }
  return processes;
}

function displayCommand(args, comm) {
  const trimmed = String(args || "").trim();
  if (!trimmed) return path.basename(comm);
  const quoted = trimmed.match(/^["']([^"']+)["']/);
  const executable = quoted ? quoted[1] : trimmed.split(/\s+/, 1)[0];
  return path.basename(executable) || path.basename(comm);
}

function processCategory(value) {
  for (const [category, pattern] of PROCESS_CATEGORIES) {
    if (pattern.test(value)) return category;
  }
  return null;
}

function suggestedNextActions(processes, truncated) {
  const actions = [];
  if (processes.length > 0) {
    actions.push({
      command: `agentshell kill suggest --pid ${processes[0].pid} --compact`,
      reason: "Preview a non-destructive termination recommendation for a selected process"
    });
  }
  if (truncated) {
    actions.push({
      command: "agentshell ps --compact --limit 100",
      reason: "The matching process list was truncated"
    });
  }
  if (actions.length === 0) {
    actions.push({
      command: "agentshell port list --compact",
      reason: "No likely development processes were found; inspect listening ports next"
    });
  }
  return actions;
}

function normalizeLimit(value) {
  const parsed = Number(value || DEFAULT_LIMIT);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function defaultRunCommand(command, args, options) {
  return spawnSync(command, args, options);
}
