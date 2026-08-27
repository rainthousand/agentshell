const PROTOCOL_KEYS = new Set(["ok", "protocolVersion", "compact", "summary", "compactBudget"]);
const MIN_CHAR_BUDGET = 768;
const MIN_TOKEN_BUDGET = Math.ceil(MIN_CHAR_BUDGET / 4);
const MAX_REPORTED_PATHS = 20;

export const DEFAULT_COMPACT_BUDGET = Object.freeze({
  maxChars: 12_000,
  maxEstimatedTokens: 3_000,
  maxArrayItems: 40,
  maxStringChars: 2_000
});

export const COMPACT_OUTPUT_BUDGET = DEFAULT_COMPACT_BUDGET;

export function estimateCompactTokens(value) {
  const chars = typeof value === "number" ? value : String(value ?? "").length;
  return Math.ceil(Math.max(0, chars) / 4);
}

export function normalizeCompactBudget(options = {}) {
  const limits = {
    maxChars: positiveInteger(options.maxChars, DEFAULT_COMPACT_BUDGET.maxChars, "maxChars"),
    maxEstimatedTokens: positiveInteger(
      options.maxEstimatedTokens,
      DEFAULT_COMPACT_BUDGET.maxEstimatedTokens,
      "maxEstimatedTokens"
    ),
    maxArrayItems: positiveInteger(options.maxArrayItems, DEFAULT_COMPACT_BUDGET.maxArrayItems, "maxArrayItems"),
    maxStringChars: positiveInteger(options.maxStringChars, DEFAULT_COMPACT_BUDGET.maxStringChars, "maxStringChars")
  };
  if (limits.maxChars < MIN_CHAR_BUDGET) throw new RangeError(`maxChars must be at least ${MIN_CHAR_BUDGET}`);
  if (limits.maxEstimatedTokens < MIN_TOKEN_BUDGET) {
    throw new RangeError(`maxEstimatedTokens must be at least ${MIN_TOKEN_BUDGET}`);
  }
  return Object.freeze(limits);
}

export function measureCompactOutput(value, options = {}) {
  const serialized = typeof value === "string"
    ? value
    : JSON.stringify(value, null, options.pretty === false ? 0 : 2);
  const chars = serialized?.length || 0;
  return { chars, estimatedTokens: estimateCompactTokens(chars) };
}

export function findCompactBudgetViolations(value, options = {}) {
  const limits = normalizeCompactBudget(options);
  const paths = [];
  const seen = new WeakSet();

  visit(value, "$", seen, (entry, path) => {
    if (typeof entry === "string" && entry.length > limits.maxStringChars) {
      paths.push({ path, kind: "string", actual: entry.length, limit: limits.maxStringChars });
    } else if (Array.isArray(entry) && entry.length > limits.maxArrayItems) {
      paths.push({ path, kind: "array", actual: entry.length, limit: limits.maxArrayItems });
    }
  });

  const measured = measureCompactOutput(value);
  if (measured.chars > limits.maxChars) {
    paths.push({ path: "$", kind: "chars", actual: measured.chars, limit: limits.maxChars });
  }
  if (measured.estimatedTokens > limits.maxEstimatedTokens) {
    paths.push({
      path: "$",
      kind: "estimatedTokens",
      actual: measured.estimatedTokens,
      limit: limits.maxEstimatedTokens
    });
  }
  return paths;
}

export function applyCompactBudget(value, options = {}) {
  const limits = normalizeCompactBudget(options);
  const original = measureCompactOutput(value);
  const state = {
    arrays: 0,
    items: 0,
    strings: 0,
    chars: 0,
    fields: 0,
    paths: [],
    seen: new WeakSet()
  };
  const output = boundValue(value, "$", limits, state);
  const response = isPlainObject(output) ? output : { ok: true, summary: output };
  if (!Object.hasOwn(response, "summary")) {
    response.summary = { status: response.ok === false ? "error" : "ok" };
  }
  response.compactBudget = metadata(limits, original, measureCompactOutput(response), state);

  removeOversizedTopLevelFields(response, limits, state);
  tightenSummaryIfNeeded(response, limits, state);
  response.compactBudget = metadata(limits, original, measureCompactOutput(response), state);

  // Metadata changes the final size, so leave a small deterministic safety margin.
  removeOversizedTopLevelFields(response, limits, state);
  tightenSummaryIfNeeded(response, limits, state);
  response.compactBudget = metadata(limits, original, measureCompactOutput(response), state);

  let final = settleOutputMeasurement(response);
  if (!withinBudget(final, limits)) {
    const minimal = minimalResponse(response, limits, original, state);
    settleOutputMeasurement(minimal);
    return minimal;
  }

  response.compactBudget.truncated = wasTruncated(state);
  final = settleOutputMeasurement(response);
  if (!withinBudget(final, limits)) {
    const minimal = minimalResponse(response, limits, original, state);
    settleOutputMeasurement(minimal);
    return minimal;
  }
  return response;
}

export const enforceCompactBudget = applyCompactBudget;

function boundValue(value, path, limits, state) {
  if (typeof value === "string") {
    if (value.length <= limits.maxStringChars) return value;
    const suffix = "...";
    state.strings += 1;
    state.chars += value.length - limits.maxStringChars;
    recordPath(state, path);
    return `${value.slice(0, Math.max(0, limits.maxStringChars - suffix.length))}${suffix}`;
  }
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (state.seen.has(value)) {
    state.strings += 1;
    recordPath(state, path);
    return "[Circular]";
  }
  state.seen.add(value);

  if (Array.isArray(value)) {
    const visible = value.slice(0, limits.maxArrayItems);
    if (visible.length < value.length) {
      state.arrays += 1;
      state.items += value.length - visible.length;
      recordPath(state, path);
    }
    return visible.map((item, index) => boundValue(item, `${path}[${index}]`, limits, state));
  }

  const result = {};
  for (const key of orderedKeys(value, path === "$")) {
    if (typeof value[key] === "undefined" || typeof value[key] === "function" || typeof value[key] === "symbol") continue;
    result[key] = path === "$" && ["ok", "protocolVersion", "compact"].includes(key)
      ? value[key]
      : boundValue(value[key], childPath(path, key), limits, state);
  }
  return result;
}

function removeOversizedTopLevelFields(response, limits, state) {
  while (!withinBudget(measureCompactOutput(response), limits)) {
    const removable = Object.keys(response)
      .filter((key) => !PROTOCOL_KEYS.has(key))
      .map((key) => ({ key, chars: JSON.stringify(response[key])?.length || 0 }))
      .sort((left, right) => right.chars - left.chars || left.key.localeCompare(right.key));
    if (removable.length === 0) return;
    const [{ key }] = removable;
    delete response[key];
    state.fields += 1;
    recordPath(state, childPath("$", key));
    response.compactBudget = metadata(limits, response.compactBudget?.original || measureCompactOutput(response), measureCompactOutput(response), state);
  }
}

function tightenSummaryIfNeeded(response, limits, state) {
  if (withinBudget(measureCompactOutput(response), limits)) return;
  const summary = response.summary;
  if (isPlainObject(summary)) {
    for (const key of Object.keys(summary).sort()) {
      if (withinBudget(measureCompactOutput(response), limits)) break;
      const value = summary[key];
      if (typeof value === "string" && value.length > 64) {
        const omitted = value.length - 64;
        summary[key] = `${value.slice(0, 61)}...`;
        state.strings += 1;
        state.chars += omitted;
        recordPath(state, childPath("$.summary", key));
      } else if (Array.isArray(value) && value.length > 1) {
        state.arrays += 1;
        state.items += value.length - 1;
        summary[key] = value.slice(0, 1);
        recordPath(state, childPath("$.summary", key));
      } else if (isPlainObject(value)) {
        summary[key] = "[summary omitted]";
        state.fields += 1;
        recordPath(state, childPath("$.summary", key));
      }
      response.compactBudget = metadata(limits, response.compactBudget?.original || measureCompactOutput(response), measureCompactOutput(response), state);
    }
  }
  if (!withinBudget(measureCompactOutput(response), limits)) {
    response.summary = typeof summary === "string"
      ? `${summary.slice(0, 61)}...`
      : { status: summary?.status || (response.ok === false ? "error" : "truncated") };
    state.fields += 1;
    recordPath(state, "$.summary");
  }
}

function minimalResponse(response, limits, original, state) {
  const minimal = {};
  for (const key of ["ok", "protocolVersion", "compact"]) {
    if (Object.hasOwn(response, key)) minimal[key] = response[key];
  }
  minimal.summary = compactSummary(response.summary);
  state.fields += 1;
  recordPath(state, "$[optional-fields]");
  minimal.compactBudget = metadata(limits, original, { chars: 0, estimatedTokens: 0 }, state);
  return minimal;
}

function compactSummary(summary) {
  if (typeof summary === "string") return summary.length <= 64 ? summary : `${summary.slice(0, 61)}...`;
  if (!isPlainObject(summary)) return { status: "truncated" };
  const result = {};
  for (const key of ["status", "passed", "failed", "total", "message"]) {
    if (!Object.hasOwn(summary, key)) continue;
    const value = summary[key];
    result[key] = typeof value === "string" && value.length > 64 ? `${value.slice(0, 61)}...` : value;
  }
  return Object.keys(result).length > 0 ? result : { status: "truncated" };
}

function metadata(limits, original, output, state) {
  return {
    version: 1,
    limits,
    original,
    output,
    truncated: wasTruncated(state),
    omitted: {
      arrays: state.arrays,
      items: state.items,
      strings: state.strings,
      chars: state.chars,
      fields: state.fields
    },
    oversizedPaths: state.paths.slice(0, Math.min(MAX_REPORTED_PATHS, limits.maxArrayItems)),
    oversizedPathCount: state.paths.length
  };
}

function settleOutputMeasurement(response) {
  let previous = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = measureCompactOutput(response);
    response.compactBudget.output = current;
    if (previous && sameMeasurement(previous, current)) return current;
    previous = current;
  }
  return measureCompactOutput(response);
}

function orderedKeys(value, topLevel) {
  const keys = Object.keys(value);
  if (!topLevel) return keys.sort();
  const priority = ["ok", "protocolVersion", "compact", "summary"];
  return [
    ...priority.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !priority.includes(key) && key !== "compactBudget").sort()
  ];
}

function visit(value, path, seen, callback) {
  callback(value, path);
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visit(entry, `${path}[${index}]`, seen, callback));
    return;
  }
  for (const key of Object.keys(value).sort()) visit(value[key], childPath(path, key), seen, callback);
}

function childPath(parent, key) {
  return /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function recordPath(state, path) {
  if (!state.paths.includes(path)) state.paths.push(path);
}

function withinBudget(measured, limits) {
  return measured.chars <= limits.maxChars && measured.estimatedTokens <= limits.maxEstimatedTokens;
}

function sameMeasurement(left, right) {
  return left.chars === right.chars && left.estimatedTokens === right.estimatedTokens;
}

function wasTruncated(state) {
  return state.arrays + state.strings + state.fields > 0;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
