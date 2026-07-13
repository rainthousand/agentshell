import fs from "node:fs";
import path from "node:path";
import { getPackageInfo, detectPackageManager, directTestFileCommand, scriptCommand, scriptCommandWithArgs } from "../core/package-json.js";
import { fail } from "../core/output.js";
import { runShell } from "../core/run.js";
import { appendOperation, appendRunNode, newId, readActiveRun, readLog, writeLog } from "../core/store.js";
import {
  createTestResultCacheContext,
  findRelatedTestFilesCacheFromContext,
  findTestResultCacheFromContext,
  writeTestResultCacheFromContext
} from "../core/cache.js";

const MAX_LOG_TAIL_LINES = 200;
const PROTOCOL_VERSION = "agentshell.verify.v1";

export async function verify(root, type, options = {}) {
  const packageInfo = getPackageInfo(root);
  if (!packageInfo) return fail("PACKAGE_NOT_FOUND", "No package.json found for verification");

  const packageManager = detectPackageManager(packageInfo.root);
  const script = packageInfo.scripts[type];
  if (!script) return fail("SCRIPT_NOT_FOUND", `No ${type} script found in package.json`);

  const command = scriptCommand(packageManager, type);
  const cacheContext = createTestResultCacheContext(packageInfo.root, {
    type,
    command,
    packagePath: packageInfo.path
  });
  const cacheLookup = findTestResultCacheFromContext(cacheContext);
  if (cacheLookup.cacheHit) {
    return cachedVerify(packageInfo.root, type, command, cacheLookup, options);
  }

  const relatedPlan = relatedTestFilePlan(packageInfo.root, {
    type,
    command,
    packagePath: packageInfo.path,
    packageManager,
    script,
    relatedFiles: options.relatedFiles || [],
    cacheContext
  });
  if (relatedPlan) {
    const relatedCacheContext = createTestResultCacheContext(packageInfo.root, {
      type,
      command: relatedPlan.command,
      packagePath: packageInfo.path
    });
    const related = await runVerificationCommand(packageInfo.root, type, relatedPlan.command, options, {
      packagePath: packageInfo.path,
      cacheContext: relatedCacheContext,
      cacheLookup: findTestResultCacheFromContext(relatedCacheContext),
      verificationMode: "related-test-file",
      fullCommand: command,
      relatedTestFile: relatedPlan.file,
      relatedTestFileSource: relatedPlan.source
    });
    if (!related.output.ok) return related.output;

    const full = await runVerificationCommand(packageInfo.root, type, command, options, {
      packagePath: packageInfo.path,
      cacheContext,
      cacheLookup,
      relatedTestFileVerification: compactRelatedVerification(related.output)
    });
    return full.output;
  }

  const verification = await runVerificationCommand(packageInfo.root, type, command, options, {
    packagePath: packageInfo.path,
    cacheContext,
    cacheLookup
  });
  return verification.output;
}

async function runVerificationCommand(root, type, command, options, metadata) {
  const started = Date.now();
  const result = await runShell(command, root);
  const combined = `${result.stdout}\n${result.stderr}`;
  const relatedFiles = extractRelatedFiles(combined, root);
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
    summary: {
      mainError: ok ? null : extractMainError(combined),
      failedTests: ok ? 0 : countFailedTests(combined)
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
    output.logTail = tailRelevant(combined, requestedTail);
  }

  const cacheWrite = writeTestResultCacheFromContext(metadata.cacheContext, {
    result,
    summary: output.summary,
    relatedFiles,
    logRef
  });
  if (cacheWrite) output.cacheKey = cacheWrite.cacheKey;

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

function relatedTestFilePlan(root, context) {
  if (context.type !== "test") return null;
  const explicitFiles = selectRelatedTestFiles(context.relatedFiles);
  const cached = explicitFiles.length > 0
    ? { relatedTestFiles: explicitFiles, sourceLogRef: null }
    : findRelatedTestFilesCacheFromContext(context.cacheContext);
  const candidates = explicitFiles.length > 0 ? explicitFiles : cached.relatedTestFiles;
  const file = candidates.find((candidate) => fs.existsSync(path.join(root, candidate)));
  if (!file) return null;

  const directCommand = directTestFileCommand(context.script, file);
  const command = directCommand || appendableTestCommand(context, file);
  if (!command || command === context.command) return null;

  return {
    file,
    command,
    source: explicitFiles.length > 0 ? "options" : "cache",
    sourceLogRef: cached.sourceLogRef || null
  };
}

function appendableTestCommand(context, file) {
  if (!/^\s*(?:vitest|jest|mocha)(?:\s|$)/.test(context.script)) return null;
  return scriptCommandWithArgs(context.packageManager, context.type, [file]);
}

function selectRelatedTestFiles(files) {
  return [...new Set((files || []).filter(isRelatedTestFile))];
}

function isRelatedTestFile(file) {
  return /(?:^|\/)(?:test|tests)\//.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
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
  const patterns = [
    /AssertionError/i,
    /\bExpected\b/i,
    /\bError:/i,
    /\bfailed\b/i,
    /\bFAIL\b/
  ];
  return lines.find((line) => patterns.some((pattern) => pattern.test(line))) || lines.at(-1) || null;
}

function countFailedTests(text) {
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
  if (!fs.existsSync(path.join(root, file))) return null;
  return file;
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
