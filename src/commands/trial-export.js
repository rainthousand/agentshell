import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { pluginStatus } from "./plugin-status.js";
import { readActiveRun, readEvents, readOperations, readRuns } from "../core/store.js";
import { summarizeRun } from "./run-status.js";
import { fail } from "../core/output.js";

const PROTOCOL_VERSION = "agentshell.trial-export.v1";
const SAFE_ARGUMENTS = new Set([
  "benchmark", "change", "clear", "diagnose", "doctor", "entry", "fast", "fix",
  "latest", "manual", "metrics", "next", "plugin", "read", "run", "safe", "schema",
  "start", "status", "suggest", "test", "understand", "validate", "verify"
]);
const VALUE_FLAGS = new Set([
  "--around", "--cache-root", "--home", "--limit", "--lines", "--marketplace",
  "--out", "--policy", "--rating", "--tail", "--topic"
]);

export async function exportTrial(root, options = {}) {
  const exportedAt = new Date();
  const run = latestRun(root, exportedAt);
  const events = selectTrialEvents(readEvents(root), run);
  const runSummary = run ? summarizeRun(run) : null;
  const operations = selectTrialOperations(readOperations(root), run);
  const packageRoot = path.resolve(import.meta.dirname, "..", "..");
  const installed = pluginStatus(packageRoot, { compact: true });
  const outputFile = path.resolve(options.out || defaultOutputFile(exportedAt));
  const trialId = trialIdFor(exportedAt, options.id);
  const commandEvents = events.map(toShareableEvent);
  const finalVerification = finalVerificationFor(runSummary);
  const measurement = measurementFor(commandEvents, operations);

  if (commandEvents.length === 0 || finalVerification?.ok !== true) {
    return fail(
      "TRIAL_NOT_READY",
      "No recent verified AgentShell run is ready to export.",
      {
        eventCount: commandEvents.length,
        runStatus: runSummary?.status || "missing",
        maximumRunAgeHours: 6
      },
      [
        {
          command: "agentshell fix test --fast --compact",
          reason: "Complete a task through the measured AgentShell flow"
        },
        {
          command: "agentshell trial export --rating 1-5",
          reason: "Export immediately after final verification passes"
        }
      ]
    );
  }

  const bundle = {
    id: trialId,
    host: "codex",
    fixture: safeLabel(options.fixture, "external-project"),
    source: "agentshell-local-export",
    events: commandEvents,
    finalVerification,
    notes: "Automatically exported from local AgentShell telemetry. Coverage is limited to AgentShell commands; Codex model tokens and non-AgentShell shell commands are not observed.",
    evidenceMetadata: {
      protocolVersion: PROTOCOL_VERSION,
      exportedAt: exportedAt.toISOString(),
      captureScope: {
        agentShellCommands: true,
        agentShellOutputTokenEstimate: true,
        rawVerificationOutputEstimate: measurement.rawVerifyEstimatedTokens > 0,
        codexModelTokens: false,
        nonAgentShellCommands: false
      },
      plugin: {
        name: installed.plugin?.name || "agentshell",
        version: installed.plugin?.version || packageVersion(packageRoot),
        status: installed.status || "unknown"
      },
      runtime: {
        platform: process.platform,
        arch: process.arch,
        nodeMajor: Number(process.versions.node.split(".")[0])
      },
      measurement,
      userFeedback: {
        rating: normalizeRating(options.rating)
      },
      privacy: {
        redacted: true,
        omitted: ["stdout", "stderr", "absolutePaths", "userName", "hostName", "environmentVariables", "fileContents"],
        reviewBeforeSharing: true
      }
    }
  };

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    file: outputFile,
    summary: {
      trialId,
      eventCount: commandEvents.length,
      finalVerificationOk: finalVerification?.ok === true,
      evidenceReady: true,
      estimatedAgentShellTokens: measurement.agentShellEstimatedTokens,
      observedDurationMs: measurement.observedDurationMs,
      tokenSavingsPercentVsRawVerify: measurement.tokenSavingsPercentVsRawVerify
    },
    privacy: bundle.evidenceMetadata.privacy,
    nextAction: "Review the JSON file, then send it to the AgentShell evaluator."
  };
}

function latestRun(root, now) {
  const run = readActiveRun(root) || readRuns(root).at(-1) || null;
  if (!run || !validDate(run.updatedAt || run.startedAt)) return null;
  const ageMs = now.getTime() - Date.parse(run.updatedAt || run.startedAt);
  return ageMs >= 0 && ageMs <= 6 * 60 * 60 * 1000 ? run : null;
}

function selectTrialEvents(allEvents, run) {
  const events = allEvents
    .filter((event) => event && typeof event === "object" && event.command !== "trial" && validDate(event.createdAt))
    .slice(-500);
  if (events.length === 0) return [];

  if (!run || !validDate(run.startedAt)) return [];

  const startedAt = Date.parse(run.startedAt);
  const firstRunEvent = events.findIndex((event) => Date.parse(event.createdAt) >= startedAt);
  const beforeRun = firstRunEvent >= 0 ? firstRunEvent : events.length;
  const onboarding = findLastIndex(events.slice(0, beforeRun), (event) => {
    const ageMs = startedAt - Date.parse(event.createdAt);
    return ageMs >= 0 && ageMs <= 30 * 60 * 1000 && ["start", "entry"].includes(event.command);
  });
  const startIndex = onboarding >= 0 ? onboarding : Math.max(0, firstRunEvent);
  const finishedAt = validDate(run.updatedAt) ? Date.parse(run.updatedAt) + 5 * 60 * 1000 : Number.POSITIVE_INFINITY;
  return events.slice(startIndex).filter((event) => Date.parse(event.createdAt) <= finishedAt).slice(0, 50);
}

function selectTrialOperations(operations, run) {
  if (!run || !validDate(run.startedAt)) return [];
  const start = Date.parse(run.startedAt) - 5 * 60 * 1000;
  const end = validDate(run.updatedAt) ? Date.parse(run.updatedAt) + 5 * 60 * 1000 : Number.POSITIVE_INFINITY;
  return operations.filter((operation) => operation?.type === "verify"
    && validDate(operation.createdAt)
    && Date.parse(operation.createdAt) >= start
    && Date.parse(operation.createdAt) <= end);
}

function toShareableEvent(event) {
  const durationMs = nonNegativeInteger(event.durationMs);
  const finishedAt = validDate(event.createdAt) ? new Date(event.createdAt) : new Date();
  const startedAt = new Date(Math.max(0, finishedAt.getTime() - durationMs));
  return {
    type: "command",
    command: canonicalCommand(event),
    outputTokens: nonNegativeInteger(event.estimatedTokens || Math.ceil((event.outputChars || 0) / 4)),
    durationMs,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString()
  };
}

function canonicalCommand(event) {
  const command = typeof event.command === "string" ? event.command : "unknown";
  const args = Array.isArray(event.args) ? [...event.args] : [];
  if (args[0] === command) args.shift();
  const normalized = [];
  let redactNext = false;
  for (const rawArg of args) {
    const arg = String(rawArg);
    if (redactNext) {
      normalized.push("<redacted>");
      redactNext = false;
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      normalized.push(arg);
      redactNext = true;
      continue;
    }
    if (arg.startsWith("--")) {
      normalized.push(arg.includes("=") ? `${arg.split("=", 1)[0]}=<redacted>` : arg);
      continue;
    }
    normalized.push(SAFE_ARGUMENTS.has(arg) ? arg : "<redacted>");
  }
  return ["agentshell", command, ...normalized].join(" ");
}

function finalVerificationFor(summary) {
  if (!summary || summary.status !== "passed") return null;
  return {
    ok: true,
    command: summary.latestVerify ? "agentshell verify test" : "agentshell fix test --fast --compact",
    summary: "AgentShell recorded a passing final verification."
  };
}

function measurementFor(events, operations) {
  const agentShellEstimatedTokens = events.reduce((total, event) => total + event.outputTokens, 0);
  const rawVerifyEstimatedTokens = operations.reduce((total, operation) => {
    const tokens = Number.isFinite(operation.rawEstimatedTokens)
      ? operation.rawEstimatedTokens
      : Math.ceil((operation.rawOutputChars || 0) / 4);
    return total + nonNegativeInteger(tokens);
  }, 0);
  const estimatedTokensSavedVsRawVerify = rawVerifyEstimatedTokens > 0
    ? Math.max(0, rawVerifyEstimatedTokens - agentShellEstimatedTokens)
    : null;
  const commandDurationMs = events.reduce((total, event) => total + event.durationMs, 0);
  const first = events[0]?.startedAt ? Date.parse(events[0].startedAt) : null;
  const last = events.at(-1)?.finishedAt ? Date.parse(events.at(-1).finishedAt) : null;
  return {
    agentShellEstimatedTokens,
    rawVerifyEstimatedTokens,
    estimatedTokensSavedVsRawVerify,
    tokenSavingsPercentVsRawVerify: estimatedTokensSavedVsRawVerify === null
      ? null
      : Math.round((estimatedTokensSavedVsRawVerify / rawVerifyEstimatedTokens) * 100),
    commandDurationMs,
    observedDurationMs: Number.isFinite(first) && Number.isFinite(last) && last >= first ? last - first : commandDurationMs,
    commandCount: events.length
  };
}

function defaultOutputFile(now) {
  const desktop = path.join(os.homedir(), "Desktop");
  const parent = fs.existsSync(desktop) ? desktop : process.cwd();
  return path.join(parent, `agentshell-trial-${timestamp(now)}.json`);
}

function timestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function trialIdFor(date, value) {
  const label = safeLabel(value, `codex-trial-${timestamp(date).toLowerCase()}`);
  return label.slice(0, 80);
}

function safeLabel(value, fallback) {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function normalizeRating(value) {
  if (value === undefined || value === null) return null;
  const rating = Number(value);
  return Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null;
}

function packageVersion(packageRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

function nonNegativeInteger(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function findLastIndex(values, predicate) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index], index)) return index;
  }
  return -1;
}
