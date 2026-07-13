import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { pluginStatus } from "./plugin-status.js";
import { getPackageInfo } from "../core/package-json.js";
import { appendEvent, readActiveRun, readEvents, readOperations, readRuns } from "../core/store.js";
import { summarizeRun } from "./run-status.js";
import { verify } from "./verify.js";
import { fail } from "../core/output.js";
import { resolvePackageRoot } from "../core/package-root.js";

const PROTOCOL_VERSION = "agentshell.trial-export.v1";
const STATUS_PROTOCOL_VERSION = "agentshell.trial-status.v1";
const MAXIMUM_RUN_AGE_HOURS = 6;
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
  let exportedAt = options.now ? new Date(options.now) : new Date();
  const initialStatus = trialStatus(root, { now: exportedAt, home: options.home });
  if (!initialStatus.project.root || initialStatus.status === "no-test-script") {
    return notReadyFailure(initialStatus);
  }

  const evidenceRoot = initialStatus.project.root;
  if (options.verify === true) {
    const verification = await runExportVerification(evidenceRoot, options);
    if (!verification.ok) {
      const status = trialStatus(evidenceRoot, { now: new Date() });
      return fail(
        "TRIAL_VERIFICATION_FAILED",
        "The project verification failed, so no trial evidence was exported.",
        {
          diagnosis: status.status,
          projectRoot: status.project.root,
          verification: {
            ok: false,
            exitCode: verification.exitCode ?? null,
            summary: verification.summary || null,
            logRef: verification.logRef || null
          }
        },
        status.suggestedNextActions
      );
    }
    if (!options.now) exportedAt = new Date();
  }

  const run = latestRun(evidenceRoot, exportedAt);
  const runSummary = run ? summarizeRun(run) : null;
  const allOperations = readOperations(evidenceRoot);
  const standaloneVerification = runSummary?.status === "passed"
    ? null
    : latestSuccessfulVerification(allOperations, exportedAt);
  const events = selectTrialEvents(readEvents(evidenceRoot), run, standaloneVerification);
  const operations = selectTrialOperations(allOperations, run, standaloneVerification);
  const packageRoot = resolvePackageRoot({
    packageRoot: options.packageRoot,
    root: options.packageRoot,
    homeDir: options.home,
    env: options.env,
    executablePath: options.executablePath,
    sourceRoot: options.sourceRoot,
    installedCandidates: options.installedCandidates
  });
  const installed = pluginStatus(packageRoot, { compact: true, packageRoot });
  const outputFile = path.resolve(options.out || defaultOutputFile(exportedAt));
  const trialId = trialIdFor(exportedAt, options.id);
  const commandEvents = events.map(toShareableEvent);
  const finalVerification = finalVerificationFor(runSummary, standaloneVerification);
  const measurement = measurementFor(commandEvents, operations);

  if (commandEvents.length === 0 || finalVerification?.ok !== true) {
    return notReadyFailure(trialStatus(evidenceRoot, { now: exportedAt }));
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

export function trialStatus(root, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const discovery = discoverTrialProject(root, options);
  if (!discovery.projectRoot) {
    return statusResult("wrong-directory", {
      cwd: path.resolve(root),
      projectRoot: null,
      suggestedProjectRoot: discovery.suggestedProjectRoot,
      packageName: null,
      eventCount: 0,
      runStatus: "missing",
      latestVerification: null,
      maximumRunAgeHours: MAXIMUM_RUN_AGE_HOURS
    });
  }

  const packageInfo = getPackageInfo(discovery.projectRoot);
  const details = evidenceDetails(discovery.projectRoot, now);
  const base = {
    cwd: path.resolve(root),
    projectRoot: discovery.projectRoot,
    suggestedProjectRoot: null,
    packageName: packageInfo?.name || path.basename(discovery.projectRoot),
    ...details,
    maximumRunAgeHours: MAXIMUM_RUN_AGE_HOURS
  };

  if (!packageInfo?.scripts?.test) return statusResult("no-test-script", base);
  if ((details.latestVerification?.ok === false && details.latestVerification.recent)
    || (details.runStatus === "failing" && details.hasRecentEvidence)) {
    return statusResult("failed-verification", base);
  }
  if (details.hasEvidence && !details.hasRecentEvidence) return statusResult("stale-evidence", base);
  if (details.eventCount === 0) return statusResult("no-agentshell-events", base);
  if (!details.ready) return statusResult("verification-missing", base);
  return statusResult("ready", base);
}

export function discoverTrialProject(root, options = {}) {
  const cwd = path.resolve(root);
  const home = path.resolve(options.home || os.homedir());
  const packageInfo = getPackageInfo(cwd);
  if (packageInfo && (cwd !== home || packageInfo.scripts?.test)) {
    return { projectRoot: packageInfo.root, suggestedProjectRoot: null };
  }

  let candidates = [];
  try {
    candidates = fs.readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
      .slice(0, 100)
      .map((entry) => path.join(cwd, entry.name))
      .filter((candidate) => {
        const candidateInfo = getPackageInfo(candidate);
        return fs.existsSync(path.join(candidate, "package.json"))
          && candidateInfo?.root === candidate
          && Boolean(candidateInfo.scripts?.test);
      });
  } catch {
    candidates = [];
  }
  return {
    projectRoot: null,
    suggestedProjectRoot: candidates.length === 1 ? candidates[0] : null
  };
}

async function runExportVerification(root, options) {
  const verifyFn = typeof options.verifyFn === "function" ? options.verifyFn : verify;
  const result = await verifyFn(root, "test", { ...(options.verifyOptions || {}), run: true });
  const serialized = JSON.stringify(result || {});
  appendEvent(root, {
    command: "verify",
    args: ["verify", "test", "--compact"],
    ok: result?.ok === true,
    operationIds: result?.operationId ? [result.operationId] : [],
    outputChars: serialized.length,
    estimatedTokens: Math.ceil(serialized.length / 4),
    durationMs: nonNegativeInteger(result?.durationMs)
  });
  return result || { ok: false };
}

function evidenceDetails(root, now) {
  const events = readEvents(root)
    .filter((event) => event && typeof event === "object" && event.command !== "trial" && validDate(event.createdAt));
  const operations = readOperations(root)
    .filter((operation) => operation?.type === "verify"
      && operation.verificationMode !== "related-test-file"
      && validDate(operation.createdAt));
  const runs = [readActiveRun(root), ...readRuns(root)].filter(Boolean);
  const latestRunValue = runs.sort((left, right) => evidenceTime(right) - evidenceTime(left))[0] || null;
  const latestVerification = operations.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] || null;
  const cutoff = now.getTime() - MAXIMUM_RUN_AGE_HOURS * 60 * 60 * 1000;
  const verificationTime = latestVerification ? Date.parse(latestVerification.createdAt) : null;
  const runTime = latestRunValue ? evidenceTime(latestRunValue) : null;
  const latestEvidenceAt = Math.max(verificationTime || 0, runTime || 0);
  const recentRun = latestRunValue && runTime >= cutoff && runTime <= now.getTime() ? latestRunValue : null;
  const recentRunSummary = recentRun ? summarizeRun(recentRun) : null;
  const recentVerification = latestVerification && verificationTime >= cutoff && verificationTime <= now.getTime()
    ? latestVerification
    : null;
  const standaloneVerification = recentRunSummary?.status === "passed"
    ? null
    : (recentVerification?.ok === true ? recentVerification : null);
  const selectedEvents = selectTrialEvents(events, recentRun, standaloneVerification);
  const ready = selectedEvents.length > 0
    && (recentRunSummary?.status === "passed" || standaloneVerification?.ok === true);

  return {
    eventCount: events.length,
    selectedEventCount: selectedEvents.length,
    runStatus: recentRunSummary?.status || (latestRunValue ? summarizeRun(latestRunValue).status : "missing"),
    latestVerification: latestVerification ? {
      ok: latestVerification.ok === true,
      createdAt: latestVerification.createdAt,
      recent: recentVerification === latestVerification
    } : null,
    hasEvidence: events.length > 0 || Boolean(latestRunValue) || Boolean(latestVerification),
    hasRecentEvidence: latestEvidenceAt >= cutoff && latestEvidenceAt <= now.getTime(),
    ready
  };
}

function evidenceTime(run) {
  const value = run?.updatedAt || run?.startedAt;
  return validDate(value) ? Date.parse(value) : 0;
}

function statusResult(status, details) {
  const messages = {
    "wrong-directory": "No Node.js project was found from the current directory.",
    "no-test-script": "The project has no npm-style test script.",
    "no-agentshell-events": "No AgentShell command events were recorded for this project.",
    "stale-evidence": "AgentShell evidence exists, but it is older than the export window.",
    "failed-verification": "The most recent AgentShell verification failed.",
    "verification-missing": "AgentShell activity exists, but no recent passing final verification was found.",
    ready: "Recent verified AgentShell evidence is ready to export."
  };
  return {
    ok: true,
    protocolVersion: STATUS_PROTOCOL_VERSION,
    status,
    ready: status === "ready",
    message: messages[status],
    project: {
      cwd: details.cwd,
      root: details.projectRoot,
      suggestedRoot: details.suggestedProjectRoot,
      packageName: details.packageName
    },
    evidence: {
      eventCount: details.eventCount,
      selectedEventCount: details.selectedEventCount || 0,
      runStatus: details.runStatus,
      latestVerification: details.latestVerification,
      maximumRunAgeHours: details.maximumRunAgeHours
    },
    suggestedNextActions: statusActions(status, details)
  };
}

function statusActions(status, details) {
  if (status === "wrong-directory") {
    return details.suggestedProjectRoot ? [{
      command: `cd ${JSON.stringify(details.suggestedProjectRoot)}`,
      reason: "A single likely project was found directly below the current directory"
    }] : [{ command: "cd <project-directory>", reason: "Run AgentShell from the project you tested" }];
  }
  if (status === "no-test-script") {
    return [{ command: "agentshell trial status --project <project-directory>", reason: "Choose a project with a real test script; AgentShell will not modify package.json automatically" }];
  }
  if (status === "failed-verification") {
    return [{ command: "agentshell fix test --fast --compact", reason: "Repair the failing tests before exporting evidence" }];
  }
  if (status === "ready") {
    return [{ command: "agentshell trial export --rating 1-5", reason: "Export the ready redacted evidence bundle" }];
  }
  return [{ command: "agentshell trial export --verify --rating 1-5", reason: "Run final verification and export in one measured flow" }];
}

function notReadyFailure(status) {
  return fail(
    "TRIAL_NOT_READY",
    status.message,
    {
      diagnosis: status.status,
      projectRoot: status.project.root,
      suggestedProjectRoot: status.project.suggestedRoot,
      eventCount: status.evidence.eventCount,
      runStatus: status.evidence.runStatus,
      latestVerification: status.evidence.latestVerification,
      maximumRunAgeHours: status.evidence.maximumRunAgeHours
    },
    status.suggestedNextActions
  );
}

function latestRun(root, now) {
  const run = readActiveRun(root) || readRuns(root).at(-1) || null;
  if (!run || !validDate(run.updatedAt || run.startedAt)) return null;
  const ageMs = now.getTime() - Date.parse(run.updatedAt || run.startedAt);
  return ageMs >= 0 && ageMs <= MAXIMUM_RUN_AGE_HOURS * 60 * 60 * 1000 ? run : null;
}

function selectTrialEvents(allEvents, run, standaloneVerification = null) {
  const events = allEvents
    .filter((event) => event && typeof event === "object" && event.command !== "trial" && validDate(event.createdAt))
    .slice(-500);
  if (events.length === 0) return [];

  if (!run || !validDate(run.startedAt)) {
    return selectStandaloneVerificationEvents(events, standaloneVerification);
  }

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

function selectTrialOperations(operations, run, standaloneVerification = null) {
  if (!run || !validDate(run.startedAt)) return standaloneVerification ? [standaloneVerification] : [];
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

function finalVerificationFor(summary, standaloneVerification = null) {
  if ((!summary || summary.status !== "passed") && !standaloneVerification) return null;
  return {
    ok: true,
    command: standaloneVerification || summary.latestVerify
      ? "agentshell verify test"
      : "agentshell fix test --fast --compact",
    summary: "AgentShell recorded a passing final verification."
  };
}

function latestSuccessfulVerification(operations, now) {
  const cutoff = now.getTime() - MAXIMUM_RUN_AGE_HOURS * 60 * 60 * 1000;
  return [...operations].reverse().find((operation) => operation?.type === "verify"
    && operation.ok === true
    && operation.verificationMode !== "related-test-file"
    && validDate(operation.createdAt)
    && Date.parse(operation.createdAt) >= cutoff
    && Date.parse(operation.createdAt) <= now.getTime()) || null;
}

function selectStandaloneVerificationEvents(events, verification) {
  if (!verification || !validDate(verification.createdAt)) return [];
  const verificationAt = Date.parse(verification.createdAt);
  let verifyIndex = events.findIndex((event) => Array.isArray(event.operationIds)
    && event.operationIds.includes(verification.id));
  if (verifyIndex < 0) {
    verifyIndex = events.findIndex((event) => event.command === "verify"
      && Date.parse(event.createdAt) >= verificationAt
      && Date.parse(event.createdAt) <= verificationAt + 5 * 60 * 1000);
  }
  if (verifyIndex < 0) return [];

  const onboarding = findLastIndex(events.slice(0, verifyIndex), (event) => {
    const ageMs = Date.parse(events[verifyIndex].createdAt) - Date.parse(event.createdAt);
    return ageMs >= 0 && ageMs <= 30 * 60 * 1000 && ["start", "entry"].includes(event.command);
  });
  const startIndex = onboarding >= 0 ? onboarding : verifyIndex;
  return events.slice(startIndex, verifyIndex + 1).slice(-50);
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
