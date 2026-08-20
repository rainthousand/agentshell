import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { fail } from "../core/output.js";

const PROTOCOL_VERSION = "agentshell.which.v1";
const DEFAULT_TIMEOUT_MS = 1500;
const MAX_TIMEOUT_MS = 5000;
const MAX_VERSION_OUTPUT = 240;

const VERSION_ARGUMENTS = new Map([
  ["bun", ["--version"]],
  ["docker", ["--version"]],
  ["git", ["--version"]],
  ["go", ["version"]],
  ["gradle", ["--version"]],
  ["java", ["-version"]],
  ["javac", ["-version"]],
  ["mvn", ["--version"]],
  ["node", ["--version"]],
  ["npm", ["--version"]],
  ["npx", ["--version"]],
  ["pnpm", ["--version"]],
  ["python", ["--version"]],
  ["python3", ["--version"]],
  ["rg", ["--version"]],
  ["yarn", ["--version"]]
]);

export async function whichCommand(root, command, options = {}) {
  const name = String(command || "").trim();
  if (!name) {
    return fail("INVALID_ARGUMENT", "Executable name is required", {}, [{
      command: "agentshell which node --compact",
      reason: "Pass a command name to resolve"
    }]);
  }
  if (name.includes("\0")) {
    return fail("INVALID_ARGUMENT", "Executable name contains an invalid null byte", { command: name });
  }

  const env = options.env || process.env;
  const executablePath = resolveExecutable(root, name, options.pathEnv ?? env.PATH);
  if (!executablePath) {
    return fail("COMMAND_NOT_FOUND", "Executable was not found on PATH", { command: name }, [{
      command: shellInstallHint(name),
      reason: "Install the command or add its executable directory to PATH"
    }]);
  }

  const realPath = safeRealPath(executablePath);
  const commonName = path.basename(name);
  const versionArgs = VERSION_ARGUMENTS.get(commonName);
  const version = versionArgs
    ? inspectVersion(executablePath, versionArgs, root, env, options.versionTimeoutMs)
    : {
        attempted: false,
        command: null,
        value: null,
        status: "unsupported",
        timedOut: false
      };

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    compact: options.compact === undefined ? true : Boolean(options.compact),
    executable: {
      name,
      path: executablePath,
      realPath,
      symlink: realPath !== executablePath
    },
    version,
    summary: {
      found: true,
      versionAvailable: Boolean(version.value),
      versionStatus: version.status
    },
    suggestedNextActions: suggestedNextActions(name, executablePath, version)
  };
}

export const whichExecutable = whichCommand;

function resolveExecutable(root, name, pathEnv) {
  if (name.includes("/") || name.includes(path.sep)) {
    const candidate = path.isAbsolute(name) ? name : path.resolve(root, name);
    return isExecutableFile(candidate) ? candidate : null;
  }

  const directories = String(pathEnv || "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const directory of directories) {
    const candidate = path.join(directory, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function isExecutableFile(candidate) {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function safeRealPath(executablePath) {
  try {
    return fs.realpathSync(executablePath);
  } catch {
    return executablePath;
  }
}

function inspectVersion(executablePath, args, root, env, requestedTimeout) {
  const timeout = boundedTimeout(requestedTimeout);
  const result = spawnSync(executablePath, args, {
    cwd: root,
    encoding: "utf8",
    env,
    shell: false,
    timeout,
    maxBuffer: 64 * 1024
  });
  const timedOut = result.error?.code === "ETIMEDOUT";
  const rawOutput = [result.stdout, result.stderr]
    .map((value) => String(value || "").trim())
    .find(Boolean) || "";
  const value = rawOutput ? compactVersion(rawOutput) : null;

  return {
    attempted: true,
    command: `${path.basename(executablePath)} ${args.join(" ")}`,
    value,
    status: timedOut ? "timeout" : result.status === 0 ? "ok" : "error",
    timedOut
  };
}

function compactVersion(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" | ")
    .slice(0, MAX_VERSION_OUTPUT);
}

function suggestedNextActions(name, executablePath, version) {
  if (version.status === "timeout") {
    return [{
      command: `${shellQuote(executablePath)} --version`,
      reason: "Version probing timed out; retry manually only if the version is required"
    }];
  }
  if (version.status === "error") {
    return [{
      command: `agentshell file info ${shellQuote(executablePath)} --compact`,
      reason: "The executable resolved but its version command failed"
    }];
  }
  if (!version.attempted) {
    return [{
      command: `${shellQuote(executablePath)} --help`,
      reason: `Inspect ${name} usage; automatic version probing is not enabled for this tool`
    }];
  }
  return [{
    command: `agentshell test command --compact`,
    reason: `${name} is available; select the project's likely verification command`
  }];
}

function boundedTimeout(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(number, MAX_TIMEOUT_MS);
}

function shellInstallHint(name) {
  return `command -v ${shellQuote(name)}`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
