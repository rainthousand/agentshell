import { fail } from "../core/output.js";
import { runGoFocusedVerify } from "../core/go-focused-verify.js";

export async function verifyGo(root, options = {}) {
  return runGoFocusedVerify(root, options);
}

export async function verifyGoCommand(root, args = []) {
  const parsed = parseVerifyGoArgs(args);
  if (!parsed.ok) return parsed;
  return verifyGo(root, parsed.value);
}

export function parseVerifyGoArgs(args = []) {
  if (!Array.isArray(args)) return usageFailure("Arguments must be an array");

  const options = { packages: [], tags: [], compact: true };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--compact") continue;
    if (arg === "--mockey") {
      options.mockey = true;
      continue;
    }
    if (arg === "--packages" || arg === "--package") {
      const value = nextValue(args, ++index, arg);
      if (!value.ok) return value;
      const packages = value.value.split(",").filter(Boolean);
      if (packages.length === 0) return usageFailure(`${arg} requires at least one package`);
      options.packages.push(...packages);
      continue;
    }
    if (arg === "--tags" || arg === "--tag") {
      const value = nextValue(args, ++index, arg);
      if (!value.ok) return value;
      const tags = value.value.split(",").filter(Boolean);
      if (tags.length === 0) return usageFailure(`${arg} requires at least one build tag`);
      options.tags.push(...tags);
      continue;
    }
    if (arg === "--run" || arg === "--timeout" || arg === "--count") {
      const value = nextValue(args, ++index, arg);
      if (!value.ok) return value;
      const key = arg.slice(2);
      options[key] = key === "count" ? parseStrictInteger(value.value) : value.value;
      if (key === "count" && options[key] === null) return usageFailure("--count must be an integer");
      continue;
    }
    return usageFailure(`Unknown verify go option: ${String(arg)}`);
  }

  if (options.packages.length === 0) delete options.packages;
  if (options.tags.length === 0) delete options.tags;
  delete options.compact;
  return { ok: true, value: options };
}

function nextValue(args, index, flag) {
  const value = args[index];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
    return usageFailure(`${flag} requires a value`);
  }
  return { ok: true, value };
}

function parseStrictInteger(value) {
  return /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : null;
}

function usageFailure(message) {
  return fail(
    "INVALID_ARGUMENT",
    message,
    { shellInterpolation: false },
    [{
      command: "agentshell verify go --packages ./... [--run REGEX] [--tags TAGS] [--count N] [--timeout DURATION] [--mockey] --compact",
      reason: "Use structured Go test selectors and built-in safe presets"
    }]
  );
}
