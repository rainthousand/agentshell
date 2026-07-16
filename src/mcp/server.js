import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_TIMEOUT_MS = 30_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const checkoutRoot = path.resolve(here, "..", "..");
const cliPath = path.join(checkoutRoot, "src", "cli.js");

export const toolDefinitions = [
  {
    name: "agentshell_manual",
    description: "Return current AgentShell usage and supported commands.",
    inputSchema: objectSchema({})
  },
  {
    name: "agentshell_understand",
    description: "Summarize the current workspace in compact JSON.",
    inputSchema: objectSchema({})
  },
  {
    name: "agentshell_find",
    description: "Search project context without dumping raw grep output.",
    inputSchema: objectSchema({
      query: { type: "string" }
    }, ["query"])
  },
  {
    name: "agentshell_read",
    description: "Read bounded file context and return hashes for safe edits.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        file: { type: "string" },
        lines: { type: "string" },
        around: { type: "string" }
      },
      required: ["file"],
      oneOf: [
        { required: ["lines"] },
        { required: ["around"] }
      ]
    }
  },
  {
    name: "agentshell_verify_test",
    description: "Run the project test command and return compact verification JSON.",
    inputSchema: objectSchema({
      tail: { type: "number" }
    })
  },
  {
    name: "agentshell_diagnose_test",
    description: "Diagnose a failing test run without inline raw logs.",
    inputSchema: objectSchema({})
  },
  {
    name: "agentshell_fix_test",
    description: "Run the conservative repair loop using existing fix policies.",
    inputSchema: objectSchema({
      policy: { type: "string", enum: ["fast", "safe"] },
      dryRun: { type: "boolean" }
    })
  },
  {
    name: "agentshell_run_next",
    description: "Return the shortest next action for the latest task run.",
    inputSchema: objectSchema({})
  },
  {
    name: "agentshell_run_status",
    description: "Return compact task-run state.",
    inputSchema: objectSchema({
      compact: { type: "boolean" }
    })
  },
  {
    name: "agentshell_log_get",
    description: "Fetch bounded log tails referenced by prior responses.",
    inputSchema: objectSchema({
      logRef: { type: "string" },
      tail: { type: "number" }
    }, ["logRef", "tail"])
  },
  {
    name: "agentshell_schema_get",
    description: "Return the JSON Schema for a CLI protocol.",
    inputSchema: objectSchema({
      name: { type: "string" }
    }, ["name"])
  },
  {
    name: "agentshell_metrics",
    description: "Return compact usage and run metrics.",
    inputSchema: objectSchema({
      limit: { type: "number" }
    })
  }
];

export async function startStdioServer({
  input = process.stdin,
  output = process.stdout,
  cwd = process.env.AGENTSHELL_WORKSPACE || process.cwd()
} = {}) {
  const rl = createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const response = await handleJsonLine(trimmed, { cwd });
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}

export async function handleJsonLine(line, options = {}) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    return jsonRpcError(null, -32700, "Parse error", { message: error.message });
  }
  return handleRequest(message, options);
}

export async function handleRequest(message, options = {}) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return jsonRpcError(message?.id ?? null, -32600, "Invalid Request");
  }

  if (!Object.hasOwn(message, "id")) return null;

  try {
    if (message.method === "initialize") {
      return jsonRpcResult(message.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "agentshell-mcp",
          version: "1.0.0"
        }
      });
    }

    if (message.method === "tools/list") {
      return jsonRpcResult(message.id, {
        tools: toolDefinitions
      });
    }

    if (message.method === "tools/call") {
      const result = await callTool(message.params || {}, options);
      return jsonRpcResult(message.id, result);
    }

    return jsonRpcError(message.id, -32601, `Method not found: ${message.method}`);
  } catch (error) {
    return jsonRpcError(message.id, -32603, error.message);
  }
}

export async function callTool(params, {
  cwd = process.env.AGENTSHELL_WORKSPACE || process.cwd(),
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const name = params.name;
  const input = params.arguments || {};
  const args = cliArgsForTool(name, input);
  const payload = await runAgentShell(args, { cwd, timeoutMs });
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ],
    structuredContent: payload,
    isError: payload.ok === false
  };
}

export function cliArgsForTool(name, input = {}) {
  if (name === "agentshell_manual") return ["manual"];
  if (name === "agentshell_understand") return ["understand"];
  if (name === "agentshell_find") return ["find", requireString(input.query, "query")];
  if (name === "agentshell_read") {
    const file = requireString(input.file, "file");
    const hasLines = typeof input.lines === "string" && input.lines.length > 0;
    const hasAround = typeof input.around === "string" && input.around.length > 0;
    if (hasLines === hasAround) {
      throw new Error("agentshell_read requires exactly one of `lines` or `around`.");
    }
    return hasLines
      ? ["read", file, "--lines", input.lines]
      : ["read", file, "--around", input.around];
  }
  if (name === "agentshell_verify_test") {
    return withOptionalTail(["verify", "test"], input.tail);
  }
  if (name === "agentshell_diagnose_test") return ["diagnose", "test", "--compact"];
  if (name === "agentshell_fix_test") {
    if (input.dryRun && input.policy) {
      throw new Error("agentshell_fix_test cannot combine `dryRun` with `policy`.");
    }
    const args = ["fix", "test"];
    if (input.dryRun) args.push("--dry-run");
    if (input.policy) args.push(`--${requireEnum(input.policy, "policy", ["fast", "safe"])}`);
    args.push("--compact");
    return args;
  }
  if (name === "agentshell_run_next") return ["run", "next"];
  if (name === "agentshell_run_status") {
    return input.compact === false ? ["run", "status"] : ["run", "status", "--compact"];
  }
  if (name === "agentshell_log_get") {
    return withOptionalTail(["log", "get", requireString(input.logRef, "logRef")], input.tail);
  }
  if (name === "agentshell_schema_get") return ["schema", "get", requireString(input.name, "name")];
  if (name === "agentshell_metrics") {
    const args = ["metrics", "--compact"];
    if (input.limit !== undefined) args.push("--limit", String(input.limit));
    return args;
  }
  throw new Error(`Unknown AgentShell MCP tool: ${name}`);
}

async function runAgentShell(args, { cwd, timeoutMs }) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);

  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exit = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);

  if (timedOut) {
    return transportFailure("MCP_CLI_TIMEOUT", "AgentShell CLI command timed out.", { args, timeoutMs });
  }

  const parsed = parseCliJson(stdout);
  if (parsed.ok) return parsed.value;

  return transportFailure("MCP_CLI_TRANSPORT_ERROR", "AgentShell CLI command did not return JSON.", {
    args,
    exit,
    stdout: stdout.slice(0, 2000),
    stderr: stderr.slice(0, 2000)
  });
}

function parseCliJson(stdout) {
  try {
    return { ok: true, value: JSON.parse(stdout) };
  } catch (error) {
    return { ok: false, error };
  }
}

function transportFailure(code, message, details = {}) {
  return {
    ok: false,
    error: {
      code,
      message,
      details,
      suggestedNextActions: [
        "Run the equivalent agentshell CLI command directly to inspect the failure."
      ]
    }
  };
}

function jsonRpcResult(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

function jsonRpcError(id, code, message, data = undefined) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data })
    }
  };
}

function objectSchema(properties, required = []) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required
  };
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required string argument: ${name}`);
  }
  return value;
}

function requireEnum(value, name, values) {
  if (!values.includes(value)) {
    throw new Error(`${name} must be one of: ${values.join(", ")}`);
  }
  return value;
}

function withOptionalTail(args, tail) {
  if (tail !== undefined) args.push("--tail", String(tail));
  return args;
}
