import fs from "node:fs";
import path from "node:path";
import { getProjectInfo, projectCommand, relatedTestCommand } from "../core/project.js";
import { parseGoTestJson } from "../core/go-test-json.js";
import { isGoAdvancedType, planGoVerification } from "../core/go-profiles.js";
import { goQualityCommand, isGoQualityType, runGoQuality } from "../core/go-quality.js";
import { fail } from "../core/output.js";
import { runShell } from "../core/run.js";
import { appendOperation, appendRunNode, newId, readActiveRun, readLog, writeLog } from "../core/store.js";
import {
  clearTestResultCache,
  createTestResultCacheContext,
  currentTestResultCacheInput,
  explainTestResultCache,
  findRelatedTestFilesCacheFromContext,
  findTestResultCacheFromContext,
  writeTestResultCacheFromContext
} from "../core/cache.js";

const MAX_LOG_TAIL_LINES = 200;
const PROTOCOL_VERSION = "agentshell.verify.v1";

export async function verify(root, type, options = {}) {
  const project = getProjectInfo(root);
  if (!project) return fail("PACKAGE_NOT_FOUND", "No supported project manifest found for verification");

  if (options.profile && (project.kind !== "go" || type !== "test")) {
    return fail("GO_PROFILE_UNSUPPORTED", "--profile is supported only by verify test in Go projects");
  }

  const goQuality = project.kind === "go" && isGoQualityType(type);
  const goPlan = planGoVerification(project, type, options);
  if (goPlan && !goPlan.ok) return fail(goPlan.code, goPlan.message, goPlan.details);
  if (isGoAdvancedType(type) && project.kind !== "go") {
    return fail("GO_WORKFLOW_UNSUPPORTED", `verify ${type} is supported only in Go projects`);
  }
  const command = goPlan?.command || (goQuality ? goQualityCommand(type) : projectCommand(project, type));
  if (!command) {
    const message = project.kind === "node"
      ? `No ${type} script found in package.json`
      : `No ${type} command found in ${project.manifest}`;
    return fail("SCRIPT_NOT_FOUND", message);
  }

  if (options.cacheAction) {
    if (!["explain", "clear"].includes(options.cacheAction)) {
      return fail("CACHE_ACTION_INVALID", "Cache action must be explain or clear");
    }
    const cacheOptions = {
      type,
      command,
      packagePath: project.path,
      project
    };
    return options.cacheAction === "explain"
      ? explainTestResultCache(project.root, cacheOptions)
      : clearTestResultCache(project.root, cacheOptions);
  }

  if (goQuality) {
    const verification = await runVerificationCommand(project.root, type, command, options, {
      cacheContext: null,
      cacheLookup: { cacheKey: `uncached:go:${type}` },
      projectKind: project.kind,
      projectModules: project.modules,
      qualityProject: project
    });
    return verification.output;
  }

  if (goPlan?.cacheable === false) {
    const verification = await runVerificationCommand(project.root, type, command, options, {
      cacheContext: null,
      cacheLookup: { cacheKey: `uncached:go:${type}` },
      projectKind: project.kind,
      projectModules: project.modules
    });
    return verification.output;
  }

  const cacheContext = createTestResultCacheContext(project.root, {
    type,
    command,
    packagePath: project.path,
    project,
    readCacheFile: !options.noCache
  });
  const cacheLookup = options.noCache
    ? disabledCacheLookup(cacheContext)
    : findTestResultCacheFromContext(cacheContext);
  if (cacheLookup.cacheHit) {
    return cachedVerify(project.root, type, command, cacheLookup, options);
  }

  const relatedPlan = options.profile ? null : relatedTestFilePlan(project.root, {
    type,
    command,
    project,
    relatedFiles: options.relatedFiles || [],
    cacheContext,
    allowCachedRelated: !options.noCache
  });
  if (relatedPlan) {
    const relatedCacheContext = createTestResultCacheContext(project.root, {
      type,
      command: relatedPlan.command,
      packagePath: project.path,
      project,
      readCacheFile: !options.noCache
    });
    const related = await runVerificationCommand(project.root, type, relatedPlan.command, options, {
      packagePath: project.path,
      cacheContext: options.noCache ? null : relatedCacheContext,
      cacheLookup: options.noCache
        ? disabledCacheLookup(relatedCacheContext)
        : findTestResultCacheFromContext(relatedCacheContext),
      verificationMode: "related-test-file",
      fullCommand: command,
      relatedTestFile: relatedPlan.file,
      relatedTestFileSource: relatedPlan.source,
      projectKind: project.kind,
      projectModules: project.modules
    });
    if (!related.output.ok) return related.output;

    const full = await runVerificationCommand(project.root, type, command, options, {
      packagePath: project.path,
      cacheContext: options.noCache ? null : cacheContext,
      cacheLookup,
      projectKind: project.kind,
      projectModules: project.modules,
      relatedTestFileVerification: compactRelatedVerification(related.output)
    });
    return full.output;
  }

  const verification = await runVerificationCommand(project.root, type, command, options, {
    packagePath: project.path,
    cacheContext: options.noCache ? null : cacheContext,
    cacheLookup,
    projectKind: project.kind,
    projectModules: project.modules
  });
  return verification.output;
}

async function runVerificationCommand(root, type, command, options, metadata) {
  const started = Date.now();
  const structuredGoTest = metadata.projectKind === "go" && type === "test";
  const executionCommand = structuredGoTest ? goTestJsonCommand(command) : command;
  const result = metadata.qualityProject
    ? await runGoQuality(metadata.qualityProject, type)
    : await runShell(executionCommand, root);
  const combined = `${result.stdout}\n${result.stderr}`;
  const goTest = structuredGoTest
    ? parseGoTestJson(combined, { root, modules: metadata.projectModules })
    : null;
  const summaryText = goTest?.outputText || combined;
  const relatedFiles = [...new Set([
    ...(result.relatedFiles || []),
    ...(goTest?.relatedFiles || []),
    ...extractRelatedFiles(summaryText, root)
  ])].slice(0, 10);
  const ok = result.exitCode === 0;
  const operationId = newId("op");
  const logRef = newId("log");
  writeLog(root, logRef, result.stdout, result.stderr);
  const requestedTail = parseTail(options.tail);
  const durationMs = Date.now() - started;

  const output = {
    ok,
    protocolVersion: PROTOCOL_VERSION,
    operationId,
    type,
    command,
    exitCode: result.exitCode,
    durationMs,
    cacheHit: false,
    cacheKey: metadata.cacheLookup.cacheKey,
    cacheCreatedAt: metadata.cacheLookup.createdAt || null,
    cacheInputDigest: metadata.cacheLookup.inputDigest || null,
    cacheInputFileCount: metadata.cacheLookup.inputFileCount || 0,
    cacheReason: metadata.cacheLookup.reason || "fresh-execution",
    cacheStored: false,
    summary: {
      mainError: ok ? null : (result.summary?.mainError || goTest?.mainError || extractMainError(summaryText)),
      failedTests: ok ? 0 : (result.summary?.failedTests ?? goTest?.failedTests ?? countFailedTests(summaryText))
    },
    relatedFiles,
    logRef,
    suggestedNextActions: relatedFiles.slice(0, 3).map((file) => ({
      command: `agentshell read ${file} --lines 1:120`,
      reason: "Inspect file referenced by verification output"
    })).concat([{
      command: `agentshell log get ${logRef} --tail 120`,
      reason: "Inspect verification output only if the summary is insufficient"
    }])
  };
  addVerificationMetadata(output, metadata);

  if (requestedTail) {
    output.logTail = tailRelevant(summaryText, requestedTail);
  }

  const cacheWrite = metadata.cacheContext
    ? writeTestResultCacheFromContext(metadata.cacheContext, {
        result,
        summary: output.summary,
        relatedFiles,
        logRef
      })
    : null;
  if (cacheWrite) {
    output.cacheKey = cacheWrite.cacheKey;
    output.cacheCreatedAt = cacheWrite.createdAt;
    output.cacheInputDigest = cacheWrite.inputDigest;
    output.cacheInputFileCount = cacheWrite.inputFileCount;
    output.cacheStored = true;
  }

  appendOperation(root, {
    id: operationId,
    type: "verify",
    ok,
    command,
    exitCode: result.exitCode,
    durationMs: output.durationMs,
    cacheHit: false,
    cacheKey: output.cacheKey,
    logRef,
    rawOutputChars: combined.length,
    rawEstimatedTokens: estimateTokens(combined.length),
    summary: output.summary,
    relatedFiles,
    verificationMode: output.verificationMode || "full",
    fullCommand: output.fullCommand || null,
    relatedTestFile: output.relatedTestFile || null
  });

  if (options.run !== false) {
    const activeRun = readActiveRun(root);
    if (activeRun) {
      appendRunNode(root, activeRun.id, {
        type: "verify",
        ok,
        operationId,
        exitCode: result.exitCode,
        durationMs: output.durationMs,
        cacheHit: false,
        cacheKey: output.cacheKey,
        summary: output.summary,
        logRef,
        rawOutputChars: combined.length,
        rawEstimatedTokens: estimateTokens(combined.length),
        verificationMode: output.verificationMode || "full",
        fullCommand: output.fullCommand || null,
        relatedTestFile: output.relatedTestFile || null
      });
      output.runId = activeRun.id;
    }
  }

  return { output, result };
}

function goTestJsonCommand(command) {
  if (!/^\s*go\s+test(?:\s|$)/.test(command) || /(?:^|\s)-json(?:\s|$)/.test(command)) return command;
  return command.replace(/^(\s*go\s+test)(?=\s|$)/, "$1 -json");
}

function relatedTestFilePlan(root, context) {
  if (context.type !== "test") return null;
  const explicitFiles = selectRelatedTestFiles(context.relatedFiles);
  const cached = explicitFiles.length > 0 || !context.allowCachedRelated
    ? { relatedTestFiles: explicitFiles, sourceLogRef: null }
    : findRelatedTestFilesCacheFromContext(context.cacheContext);
  const candidates = explicitFiles.length > 0 ? explicitFiles : cached.relatedTestFiles;
  const file = candidates.find((candidate) => fs.existsSync(path.join(root, candidate)));
  if (!file) return null;

  const command = relatedTestCommand(context.project, file);
  if (!command || command === context.command) return null;

  return {
    file,
    command,
    source: explicitFiles.length > 0 ? "options" : "cache",
    sourceLogRef: cached.sourceLogRef || null
  };
}

function disabledCacheLookup(context) {
  const input = currentTestResultCacheInput(context);
  return {
    cacheHit: false,
    cacheKey: context.identity.identityKey,
    createdAt: null,
    inputDigest: input.inputDigest,
    inputFileCount: input.fileCount,
    reason: "disabled-by-option"
  };
}

function selectRelatedTestFiles(files) {
  return [...new Set((files || []).filter(isRelatedTestFile))];
}

function isRelatedTestFile(file) {
  return /(?:^|\/)(?:test|tests)\//.test(file) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) ||
    /_test\.go$/.test(file);
}

function addVerificationMetadata(output, metadata) {
  if (metadata.verificationMode) output.verificationMode = metadata.verificationMode;
  if (metadata.fullCommand) output.fullCommand = metadata.fullCommand;
  if (metadata.relatedTestFile) output.relatedTestFile = metadata.relatedTestFile;
  if (metadata.relatedTestFileSource) output.relatedTestFileSource = metadata.relatedTestFileSource;
  if (metadata.relatedTestFileVerification) output.relatedTestFileVerification = metadata.relatedTestFileVerification;
}

function compactRelatedVerification(verification) {
  return {
    ok: verification.ok,
    operationId: verification.operationId,
    command: verification.command,
    exitCode: verification.exitCode,
    durationMs: verification.durationMs,
    summary: verification.summary,
    relatedTestFile: verification.relatedTestFile || null,
    logRef: verification.logRef
  };
}

function cachedVerify(root, type, command, cacheLookup, options) {
  const operationId = newId("op");
  const requestedTail = parseTail(options.tail);
  const entry = cacheLookup.entry;
  const log = readLog(root, entry.logRef);
  const combined = `${log.stdout || ""}\n${log.stderr || ""}`;
  const durationMs = 0;
  const ok = entry.exitCode === 0;
  const output = {
    ok,
    protocolVersion: PROTOCOL_VERSION,
    operationId,
    type,
    command,
    exitCode: entry.exitCode,
    durationMs,
    cacheHit: true,
    cacheKey: cacheLookup.cacheKey,
    cacheCreatedAt: cacheLookup.createdAt || entry.createdAt || null,
    cacheInputDigest: cacheLookup.inputDigest || entry.inputDigest || null,
    cacheInputFileCount: cacheLookup.inputFileCount || entry.files?.length || 0,
    cacheReason: cacheLookup.reason || "inputs-unchanged",
    cacheStored: false,
    cacheSourceLogRef: entry.logRef,
    summary: entry.summary,
    relatedFiles: entry.relatedFiles,
    logRef: entry.logRef,
    suggestedNextActions: entry.relatedFiles.slice(0, 3).map((file) => ({
      command: `agentshell read ${file} --lines 1:120`,
      reason: "Inspect file referenced by verification output"
    })).concat([{
      command: `agentshell log get ${entry.logRef} --tail 120`,
      reason: "Inspect verification output only if the summary is insufficient"
    }])
  };

  if (requestedTail) {
    output.logTail = tailRelevant(combined, requestedTail);
  }

  appendOperation(root, {
    id: operationId,
    type: "verify",
    ok,
    command,
    exitCode: entry.exitCode,
    durationMs,
    cacheHit: true,
    cacheKey: cacheLookup.cacheKey,
    cacheSourceLogRef: entry.logRef,
    logRef: entry.logRef,
    rawOutputChars: entry.rawOutputChars,
    rawEstimatedTokens: estimateTokens(entry.rawOutputChars),
    summary: entry.summary,
    relatedFiles: entry.relatedFiles
  });

  if (options.run !== false) {
    const activeRun = readActiveRun(root);
    if (activeRun) {
      appendRunNode(root, activeRun.id, {
        type: "verify",
        ok,
        operationId,
        exitCode: entry.exitCode,
        durationMs,
        cacheHit: true,
        cacheKey: cacheLookup.cacheKey,
        summary: entry.summary,
        logRef: entry.logRef,
        rawOutputChars: entry.rawOutputChars,
        rawEstimatedTokens: estimateTokens(entry.rawOutputChars)
      });
      output.runId = activeRun.id;
    }
  }

  return output;
}

function extractMainError(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const goError = lines.find((line) => /\.go:\d+(?::\d+)?:\s+.+/.test(line)) ||
    lines.find((line) => /^--- FAIL:\s+/.test(line)) ||
    lines.find((line) => /^panic:\s+/i.test(line));
  if (goError) return goError;

  const patterns = [
    /\bundefined:\s+/i,
    /\bcannot use\b/i,
    /AssertionError/i,
    /\bExpected\b/i,
    /\bError:/i,
    /\bfailed\b/i,
    /\bFAIL\b/
  ];
  return lines.find((line) => patterns.some((pattern) => pattern.test(line))) || lines.at(-1) || null;
}

function countFailedTests(text) {
  const goFailures = [...text.matchAll(/^\s*--- FAIL:\s+/gm)].length;
  if (goFailures > 0) return goFailures;

  const matches = [
    ...text.matchAll(/\b(\d+)\s+(?:failing|failed|failures?)\b/gi),
    ...text.matchAll(/\bnot ok\b/gi)
  ];
  if (matches[0]?.[1]) return Number(matches[0][1]);
  return matches.length || null;
}

function extractRelatedFiles(text, root) {
  const files = new Set();
  const pathPattern = /((?:file:\/\/)?(?:\.{0,2}\/)?[A-Za-z0-9._/-]+\.(?:js|jsx|ts|tsx|mjs|cjs|json|rs|py|go))(?::\d+)?/g;
  for (const match of text.matchAll(pathPattern)) {
    const file = normalizeFileRef(match[1], root);
    if (file && !file.includes("node_modules")) files.add(file);
  }
  return [...files].slice(0, 10);
}

function normalizeFileRef(value, root) {
  let file = value.replace(/^file:\/\//, "").replace(/^\.\//, "");
  if (path.isAbsolute(file)) {
    const relative = path.relative(root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    file = relative;
  }
  if (fs.existsSync(path.join(root, file))) return file;
  if (path.dirname(file) !== ".") return null;

  const matches = findFilesByBasename(root, file);
  return matches.length === 1 ? matches[0] : null;
}

function findFilesByBasename(root, basename) {
  const matches = [];
  const ignored = new Set([".git", ".agentshell", "node_modules", "vendor"]);
  const pending = [root];
  while (pending.length > 0 && matches.length < 2) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) pending.push(path.join(directory, entry.name));
      } else if (entry.isFile() && entry.name === basename) {
        matches.push(path.relative(root, path.join(directory, entry.name)).split(path.sep).join("/"));
      }
    }
  }
  return matches;
}

function tailRelevant(text, maxLines) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.slice(-maxLines).join("\n");
}

function parseTail(value) {
  if (value === undefined || value === null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return Math.min(parsed, MAX_LOG_TAIL_LINES);
}

function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}
