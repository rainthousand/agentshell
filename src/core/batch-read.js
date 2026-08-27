import path from "node:path";

export const MAX_BATCH_TARGETS = 20;
export const MAX_TARGET_CONTENT_CHARS = 12 * 1024;
export const MAX_BATCH_CONTENT_CHARS = 48 * 1024;
export const MAX_BATCH_WORK_BYTES = 4 * 1024 * 1024;
export const MAX_TARGET_WORK_BYTES = 512 * 1024;

const MAX_TARGET_TEXT_CHARS = 4096;
const MAX_FILE_CHARS = 2048;
const MAX_QUERY_CHARS = 512;
const MAX_ERROR_MESSAGE_CHARS = 512;
const MODES = new Set(["lines", "around", "head", "tail"]);

export function parseBatchTarget(input) {
  if (typeof input === "string") return parseStringTarget(input);
  if (input && typeof input === "object" && !Array.isArray(input)) return parseObjectTarget(input);
  return invalidTarget("Target must be a string or object");
}

export function normalizeBatchTargets(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return requestFailure("INVALID_ARGUMENT", "At least one read target is required");
  }
  if (inputs.length > MAX_BATCH_TARGETS) {
    return requestFailure("INVALID_ARGUMENT", `A batch may contain at most ${MAX_BATCH_TARGETS} targets`, {
      maxTargets: MAX_BATCH_TARGETS,
      targetCount: inputs.length
    });
  }
  return { ok: true, targets: inputs.map(parseBatchTarget) };
}

export async function executeBatchReads(inputs, readTarget, options = {}) {
  if (typeof readTarget !== "function") {
    return requestFailure("INVALID_ARGUMENT", "A read target executor is required");
  }
  const normalized = normalizeBatchTargets(inputs);
  if (!normalized.ok) return normalized;

  const perTargetLimit = boundedLimit(options.maxTargetContentChars, MAX_TARGET_CONTENT_CHARS);
  const batchLimit = boundedLimit(options.maxBatchContentChars, MAX_BATCH_CONTENT_CHARS);
  const workLimit = boundedLimit(options.maxWorkBytes, MAX_BATCH_WORK_BYTES);
  let remaining = batchLimit;
  let remainingWork = workLimit;
  let actualWorkBytes = 0;
  let workBudgetBytes = 0;
  let succeeded = 0;
  let failed = 0;
  let truncatedResults = 0;
  const results = [];

  for (let index = 0; index < normalized.targets.length; index += 1) {
    const parsed = normalized.targets[index];
    if (!parsed.ok) {
      failed += 1;
      results.push({ index, ok: false, error: parsed.error });
      continue;
    }

    let result;
    try {
      const remainingTargets = normalized.targets.slice(index).filter((entry) => entry.ok).length;
      const fairWorkShare = remainingTargets > 0 ? Math.floor(remainingWork / remainingTargets) : 0;
      const allocatedWorkBytes = Math.min(MAX_TARGET_WORK_BYTES, fairWorkShare);
      remainingWork -= allocatedWorkBytes;
      workBudgetBytes += allocatedWorkBytes;
      result = await readTarget(parsed.target, {
        maxWorkBytes: allocatedWorkBytes
      });
    } catch (error) {
      result = itemFailure("UNEXPECTED_ERROR", safeMessage(error));
    }

    if (!result?.ok) {
      failed += 1;
      results.push({
        index,
        target: parsed.target,
        ok: false,
        error: sanitizeError(result?.error)
      });
      continue;
    }

    const contentLimit = Math.min(perTargetLimit, remaining);
    const clipped = clipContent(String(result.content ?? ""), contentLimit);
    const wasTruncated = Boolean(result.truncated?.value) || clipped.truncated;
    if (wasTruncated) truncatedResults += 1;
    remaining -= clipped.content.length;
    const workBytes = normalizedWorkBytes(result.workBytes);
    actualWorkBytes += workBytes;
    succeeded += 1;
    results.push({
      index,
      target: parsed.target,
      ok: true,
      file: result.file,
      hash: result.hash,
      hashScope: result.hashScope,
      hashBytes: result.hashBytes,
      hashWindow: result.hashWindow,
      range: result.range,
      lineNumbering: result.lineNumbering,
      matchedLine: result.matchedLine,
      totalLines: result.totalLines,
      content: clipped.content,
      mode: result.mode,
      byteSize: result.byteSize,
      workBytes,
      bounded: result.bounded,
      truncated: {
        value: wasTruncated,
        reason: clipped.truncated
          ? contentLimit === 0 ? "batch content limit reached" : "batch target content limit reached"
          : result.truncated?.reason ?? null
      }
    });
  }

  return {
    ok: true,
    protocolVersion: "agentshell.read-batch.v1",
    status: failed === 0 ? "complete" : succeeded === 0 ? "failed" : "partial",
    summary: {
      requested: normalized.targets.length,
      succeeded,
      failed,
      contentChars: batchLimit - remaining,
      contentLimitChars: batchLimit,
      workBytes: actualWorkBytes,
      workBudgetBytes,
      workLimitBytes: workLimit,
      truncatedResults
    },
    results
  };
}

function parseStringTarget(input) {
  if (input.length === 0 || input.length > MAX_TARGET_TEXT_CHARS) {
    return invalidTarget(`Target text must contain 1-${MAX_TARGET_TEXT_CHARS} characters`);
  }
  const selector = /^(.*)@(around|head|tail)=(.*)$/.exec(input);
  if (selector) return buildTarget(selector[1], selector[2], selector[3]);
  const range = /^(.*):(\d+):(\d+)$/.exec(input);
  if (range) return buildTarget(range[1], "lines", `${range[2]}:${range[3]}`);
  return invalidTarget("Target must look like file:A:B, file@around=query, file@head=N, or file@tail=N");
}

function parseObjectTarget(input) {
  const keys = ["lines", "around", "head", "tail"].filter((key) => input[key] !== undefined);
  if (keys.length !== 1) return invalidTarget("Target object must specify exactly one read mode");
  return buildTarget(input.file, keys[0], input[keys[0]]);
}

function buildTarget(file, mode, value) {
  const fileError = validateFile(file);
  if (fileError) return invalidTarget(fileError);
  if (!MODES.has(mode)) return invalidTarget("Unsupported read mode");
  if (mode === "lines") {
    const match = /^(\d+):(\d+)$/.exec(String(value));
    if (!match || Number(match[1]) < 1 || Number(match[1]) > Number(match[2])) {
      return invalidTarget("Line range must look like A:B with 1 <= A <= B");
    }
    return { ok: true, target: { file, mode, value: `${Number(match[1])}:${Number(match[2])}` } };
  }
  if (mode === "around") {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_QUERY_CHARS) {
      return invalidTarget(`Around query must contain 1-${MAX_QUERY_CHARS} characters`);
    }
    return { ok: true, target: { file, mode, value } };
  }
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 200) {
    return invalidTarget("Head or tail count must be an integer between 1 and 200");
  }
  return { ok: true, target: { file, mode, value: count } };
}

function validateFile(file) {
  if (typeof file !== "string" || file.length === 0 || file.length > MAX_FILE_CHARS || file.includes("\0")) {
    return `File must contain 1-${MAX_FILE_CHARS} safe characters`;
  }
  if (path.isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file) || /^\\\\/.test(file)) {
    return "Absolute file paths are not allowed";
  }
  return null;
}

function boundedLimit(value, maximum) {
  if (value === undefined) return maximum;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? Math.min(number, maximum) : maximum;
}

function normalizedWorkBytes(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function clipContent(content, limit) {
  if (content.length <= limit) return { content, truncated: false };
  if (limit <= 3) return { content: ".".repeat(limit), truncated: true };
  return { content: `${content.slice(0, limit - 3)}...`, truncated: true };
}

function safeMessage(error) {
  const message = error instanceof Error ? error.message : "Batch read failed unexpectedly";
  return String(message).slice(0, MAX_ERROR_MESSAGE_CHARS);
}

function sanitizeError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "UNEXPECTED_ERROR",
    message: String(error?.message ?? "Read target failed").slice(0, MAX_ERROR_MESSAGE_CHARS)
  };
}

function invalidTarget(message) {
  return itemFailure("INVALID_ARGUMENT", message);
}

function itemFailure(code, message) {
  return { ok: false, error: { code, message } };
}

function requestFailure(code, message, details) {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details ? { details } : {})
    }
  };
}
