import fs from "node:fs";
import path from "node:path";

import { boundedProcessOptions, runBoundedProcess } from "./bounded-process.js";
import {
  clipUtf8Bytes,
  compactOutputPreview,
  redactCommandOutput
} from "./compact-command-output.js";
import { parseGoTestJson } from "./go-test-json.js";
import { fail } from "./output.js";
import { newId, writeLog } from "./store.js";

const PROTOCOL_VERSION = "agentshell.verify-go.v1";
const DEFAULT_PACKAGES = ["./..."];
const DEFAULT_PROCESS_TIMEOUT_MS = 2 * 60_000;
const MAX_GO_TIMEOUT_MS = 4 * 60_000;
const PROCESS_TIMEOUT_GRACE_MS = 5_000;
const MAX_PACKAGES = 64;
const MAX_PACKAGE_LENGTH = 512;
const MAX_PATTERN_LENGTH = 256;
const MAX_TAGS = 32;
const MAX_TAG_LENGTH = 64;
const MAX_COUNT = 1_000;
const MAX_FAILED_TESTS = 8;

export function planGoFocusedVerify(options = {}, context = {}) {
  if (!isPlainObject(options)) {
    return fail("GO_VERIFY_OPTIONS_INVALID", "Go verification options must be an object");
  }

  const packages = normalizePackages(options.packages, discoverLocalModulePaths(context.root));
  if (!packages.ok) return packages;
  const run = normalizePattern(options.run);
  if (!run.ok) return run;
  const tags = normalizeTags(options.tags);
  if (!tags.ok) return tags;
  const count = normalizeCount(options.count);
  if (!count.ok) return count;
  const timeout = normalizeTimeout(options.timeout);
  if (!timeout.ok) return timeout;
  const mockey = normalizeBoolean(options.mockey, "mockey");
  if (!mockey.ok) return mockey;

  const argv = ["go", "test", "-json"];
  if (run.value !== null) argv.push(`-run=${run.value}`);
  if (tags.value.length > 0) argv.push(`-tags=${tags.value.join(",")}`);
  if (count.value !== null) argv.push(`-count=${count.value}`);
  if (timeout.value !== null) argv.push(`-timeout=${timeout.value.literal}`);
  if (mockey.value) argv.push("-gcflags=all=-N -l");
  argv.push(...packages.value);

  return {
    ok: true,
    value: {
      argv,
      packages: packages.value,
      run: run.value,
      tags: tags.value,
      count: count.value,
      timeout: timeout.value?.literal || null,
      processTimeoutMs: timeout.value
        ? timeout.value.milliseconds + PROCESS_TIMEOUT_GRACE_MS
        : DEFAULT_PROCESS_TIMEOUT_MS,
      preset: mockey.value ? "mockey" : null
    }
  };
}

export async function runGoFocusedVerify(root, options = {}) {
  const projectRoot = path.resolve(root || process.cwd());
  if (!hasGoManifest(projectRoot)) {
    return fail(
      "GO_PROJECT_NOT_FOUND",
      "Focused Go verification requires go.mod or go.work in the project root",
      { root: projectRoot }
    );
  }

  const plan = planGoFocusedVerify(options, { root: projectRoot });
  if (!plan.ok) return plan;

  const limits = boundedProcessOptions({
    timeoutMs: Math.min(plan.value.processTimeoutMs, 5 * 60_000),
    maxOutputBytes: options.maxOutputBytes
  });
  const execution = await runBoundedProcess(plan.value.argv, projectRoot, {
    ...limits,
    env: options.env
  });
  const safeOutput = sanitizeCapturedOutput(execution);
  const combined = [safeOutput.stdout, safeOutput.stderr].filter(Boolean).join("\n");
  const parsed = parseGoTestJson(combined, { root: projectRoot });
  const failureText = parsed?.outputText || combined;
  const timedOut = execution.timedOut || goTestTimedOut(failureText);
  const ok = execution.exitCode === 0 && !timedOut;
  const logRef = newId("log");
  writeLog(projectRoot, logRef, safeOutput.stdout, safeOutput.stderr);

  return {
    ok,
    protocolVersion: PROTOCOL_VERSION,
    compact: true,
    command: {
      executable: plan.value.argv[0],
      args: plan.value.argv.slice(1),
      shellInterpolation: false
    },
    selection: {
      packages: plan.value.packages,
      run: plan.value.run,
      tags: plan.value.tags,
      count: plan.value.count,
      timeout: plan.value.timeout,
      preset: plan.value.preset
    },
    exitCode: execution.exitCode,
    signal: execution.signal,
    durationMs: execution.durationMs,
    timedOut,
    truncated: execution.truncated,
    logRef,
    summary: {
      status: timedOut ? "timeout" : (ok ? "passed" : "failed"),
      mainError: ok ? null : compactMainError(parsed?.mainError || fallbackMainError(failureText)),
      failedTests: ok ? 0 : (parsed?.failedTests || countFailedTests(failureText)),
      failedTestNames: ok ? [] : (parsed?.failedTestNames || extractFailedTestNames(failureText)).slice(0, MAX_FAILED_TESTS),
      relatedFiles: (parsed?.relatedFiles || []).slice(0, MAX_FAILED_TESTS),
      preview: ok ? null : compactOutputPreview("", failureText, { preferStderr: true }),
      capturedBytes: execution.capturedBytes,
      observedBytes: execution.observedBytes,
      outputLimitBytes: execution.outputLimitBytes
    },
    suggestedNextActions: suggestedNextActions({ ...execution, timedOut }, parsed, logRef)
  };
}

function normalizePackages(value, modulePaths = []) {
  if (value === undefined) return { ok: true, value: [...DEFAULT_PACKAGES] };
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PACKAGES) {
    return fail(
      "GO_VERIFY_PACKAGES_INVALID",
      `packages must be a non-empty array with at most ${MAX_PACKAGES} entries`
    );
  }
  const packages = [];
  for (const candidate of value) {
    if (
      typeof candidate !== "string" ||
      candidate.length === 0 ||
      candidate.length > MAX_PACKAGE_LENGTH ||
      candidate.startsWith("-") ||
      /[\0\r\n\t \\]/.test(candidate) ||
      !isLocalPackagePattern(candidate, modulePaths)
    ) {
      return fail(
        "GO_VERIFY_PACKAGE_INVALID",
        "Each package must be a local ./ pattern or an import path in the current Go module/workspace",
        { package: candidate }
      );
    }
    packages.push(candidate);
  }
  return { ok: true, value: [...new Set(packages)] };
}

function isLocalPackagePattern(candidate, modulePaths) {
  if (
    candidate.includes("://") ||
    candidate.startsWith("file:") ||
    path.isAbsolute(candidate) ||
    path.win32.isAbsolute(candidate)
  ) {
    return false;
  }

  if (candidate === ".") return true;
  if (candidate.startsWith("./")) {
    const segments = candidate.slice(2).split("/");
    return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  }

  if (candidate.split("/").some((segment) => segment === ".." || segment === "." || segment.length === 0)) {
    return false;
  }
  return modulePaths.some((modulePath) => candidate === modulePath || candidate.startsWith(`${modulePath}/`));
}

function discoverLocalModulePaths(root) {
  if (!root) return [];
  const projectRoot = safeRealpath(root);
  if (!projectRoot) return [];

  const modulePaths = new Set();
  addModulePath(path.join(projectRoot, "go.mod"), modulePaths);

  const goWorkPath = path.join(projectRoot, "go.work");
  if (fs.existsSync(goWorkPath)) {
    for (const member of parseGoWorkUses(safeReadFile(goWorkPath))) {
      const memberRoot = safeRealpath(path.resolve(projectRoot, member));
      if (memberRoot && isWithinRoot(projectRoot, memberRoot)) {
        addModulePath(path.join(memberRoot, "go.mod"), modulePaths);
      }
    }
  }
  return [...modulePaths];
}

function addModulePath(goModPath, modulePaths) {
  const match = safeReadFile(goModPath).match(/^\s*module\s+([^\s]+)\s*$/m);
  if (match && isSafeModulePath(match[1])) modulePaths.add(match[1]);
}

function parseGoWorkUses(content) {
  const uses = [];
  let inUseBlock = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    if (line === "use (") {
      inUseBlock = true;
      continue;
    }
    if (inUseBlock && line === ")") {
      inUseBlock = false;
      continue;
    }
    const value = inUseBlock ? line : line.match(/^use\s+(.+)$/)?.[1];
    if (value && !/[\s"'`]/.test(value)) uses.push(value);
  }
  return uses;
}

function isSafeModulePath(value) {
  return !value.startsWith("-") &&
    !value.includes("://") &&
    !/[\0\r\n\t \\]/.test(value) &&
    !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function safeReadFile(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function safeRealpath(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function isWithinRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normalizePattern(value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATTERN_LENGTH || /[\0\r\n]/.test(value)) {
    return fail(
      "GO_VERIFY_RUN_INVALID",
      `run must be a non-empty single-line regex no longer than ${MAX_PATTERN_LENGTH} characters`
    );
  }
  return { ok: true, value };
}

function normalizeTags(value) {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.length > MAX_TAGS) {
    return fail("GO_VERIFY_TAGS_INVALID", `tags must be an array with at most ${MAX_TAGS} entries`);
  }
  const tags = [];
  for (const tag of value) {
    if (typeof tag !== "string" || tag.length === 0 || tag.length > MAX_TAG_LENGTH || !/^[A-Za-z0-9_.]+$/.test(tag)) {
      return fail(
        "GO_VERIFY_TAG_INVALID",
        "Each build tag must contain only letters, digits, underscore, or dot",
        { tag }
      );
    }
    tags.push(tag);
  }
  return { ok: true, value: [...new Set(tags)] };
}

function normalizeCount(value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!Number.isInteger(value) || value < 0 || value > MAX_COUNT) {
    return fail("GO_VERIFY_COUNT_INVALID", `count must be an integer between 0 and ${MAX_COUNT}`);
  }
  return { ok: true, value };
}

function normalizeTimeout(value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return fail("GO_VERIFY_TIMEOUT_INVALID", "timeout must be a Go duration such as 30s or 2m");
  }
  const milliseconds = parseGoDurationMs(value);
  if (milliseconds === null || milliseconds > MAX_GO_TIMEOUT_MS) {
    return fail(
      "GO_VERIFY_TIMEOUT_INVALID",
      "timeout must be a positive Go duration no longer than 4m",
      { timeout: value, maximum: "4m" }
    );
  }
  return { ok: true, value: { literal: value, milliseconds } };
}

function normalizeBoolean(value, name) {
  if (value === undefined) return { ok: true, value: false };
  if (typeof value !== "boolean") return fail("GO_VERIFY_PRESET_INVALID", `${name} must be a boolean`);
  return { ok: true, value };
}

function parseGoDurationMs(value) {
  if (typeof value !== "string" || !/^(?:[1-9]\d*(?:ns|us|µs|ms|s|m|h))+$/.test(value)) return null;
  const multipliers = {
    ns: 1 / 1_000_000,
    us: 1 / 1_000,
    "µs": 1 / 1_000,
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000
  };
  let milliseconds = 0;
  for (const match of value.matchAll(/([1-9]\d*)(ns|us|µs|ms|s|m|h)/g)) {
    milliseconds += Number(match[1]) * multipliers[match[2]];
  }
  return Number.isFinite(milliseconds) && milliseconds > 0 ? Math.max(1, Math.ceil(milliseconds)) : null;
}

function sanitizeCapturedOutput(execution) {
  const stdoutBytes = Buffer.byteLength(execution.stdout, "utf8");
  const stdout = clipUtf8Bytes(redactCommandOutput(execution.stdout), stdoutBytes);
  const stderr = clipUtf8Bytes(
    redactCommandOutput(execution.stderr),
    Math.max(0, execution.outputLimitBytes - Buffer.byteLength(stdout, "utf8"))
  );
  return { stdout, stderr };
}

function fallbackMainError(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /(?:\.go:\d+|panic:|fatal error:|--- FAIL:|^FAIL\b)/i.test(line)) || lines.at(-1) || null;
}

function compactMainError(value) {
  const text = redactCommandOutput(value || "").trim();
  return text.length <= 240 ? (text || null) : `${text.slice(0, 239).trimEnd()}…`;
}

function countFailedTests(text) {
  return extractFailedTestNames(text).length;
}

function extractFailedTestNames(text) {
  return [...new Set([...String(text || "").matchAll(/^--- FAIL:\s+(\S+)/gm)].map((match) => match[1]))];
}

function goTestTimedOut(text) {
  return /panic:\s+test timed out after\b/i.test(String(text || ""));
}

function suggestedNextActions(execution, parsed, logRef) {
  const actions = [];
  const file = parsed?.relatedFiles?.[0];
  if (file) {
    actions.push({
      command: `agentshell read ${file} --lines 1:160`,
      reason: "Inspect the first source file referenced by the failed Go test"
    });
  }
  if (execution.timedOut) {
    actions.push({
      command: "agentshell verify go --packages <package> --run <regex> --compact",
      reason: "The verification timed out; narrow the package or test regex before retrying"
    });
  }
  actions.push({
    command: `agentshell log get ${logRef} --tail 120`,
    reason: "Fetch a bounded local log tail only when the compact failure summary is insufficient"
  });
  return actions.slice(0, 3);
}

function hasGoManifest(root) {
  return fs.existsSync(path.join(root, "go.mod")) || fs.existsSync(path.join(root, "go.work"));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
