import { runGoLocator } from "../core/go-locator.js";
import { fail } from "../core/output.js";

export async function goLocate(root, mode, query, options = {}) {
  return runGoLocator(root, { ...options, mode, query }, options);
}

export async function goLocateCommand(root, args = [], options = {}) {
  const parsed = parseGoLocateArgs(args);
  if (!parsed.ok) return parsed;
  return runGoLocator(root, parsed.value, options);
}

export function parseGoLocateArgs(args = []) {
  if (!Array.isArray(args) || args.length === 0) return usageFailure("A locator mode is required");
  const mode = args[0];
  if (!new Set(["symbol", "dependency", "generated"]).has(mode)) {
    return usageFailure("Mode must be symbol, dependency, or generated");
  }

  const request = { mode, compact: true };
  let index = 1;
  if (mode !== "generated") {
    const query = args[index];
    if (typeof query !== "string" || !query || query.startsWith("-")) {
      return usageFailure(`${mode} requires one concrete query`);
    }
    request.query = query;
    index += 1;
  }

  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--compact") continue;
    if (arg === "--package" || arg === "--kind" || arg === "--timeout-ms" || arg === "--max-results") {
      const value = args[++index];
      if (typeof value !== "string" || !value || value.startsWith("--")) return usageFailure(`${arg} requires a value`);
      const key = arg.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      request[key] = arg === "--timeout-ms" || arg === "--max-results" ? strictInteger(value) : value;
      if (request[key] === null) return usageFailure(`${arg} must be an integer`);
      continue;
    }
    return usageFailure(`Unknown go locate option: ${String(arg)}`);
  }

  if (mode === "dependency" && request.package) return usageFailure("--package is only valid for symbol or generated queries");
  if (mode !== "generated" && request.kind) return usageFailure("--kind is only valid for generated queries");
  return { ok: true, value: request };
}

function strictInteger(value) {
  return /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : null;
}

function usageFailure(message) {
  return fail("INVALID_ARGUMENT", message, { shellInterpolation: false }, [{
    command: "agentshell go locate <symbol|dependency|generated> [query] [--package IMPORT] [--kind KIND] --compact",
    reason: "Use one concrete, bounded Go locator query"
  }]);
}
