import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runShell } from "./run.js";

const GO_FORMAT_BATCH_SIZE = 100;
const IGNORED_DIRECTORIES = new Set([
  ".agentshell",
  ".git",
  "node_modules",
  "vendor"
]);

export function isGoQualityType(type) {
  return type === "format" || type === "modules";
}

export function goQualityCommand(type) {
  if (type === "format") return "gofmt -d <go files>";
  if (type === "modules") return "go mod verify && go mod tidy -modfile=<temporary>";
  return null;
}

export async function runGoQuality(project, type, options = {}) {
  const execute = options.runShell || runShell;
  if (type === "format") return checkGoFormat(project, execute);
  if (type === "modules") return checkGoModules(project, execute);
  throw new Error(`Unsupported Go quality verification: ${type}`);
}

async function checkGoFormat(project, execute) {
  const files = collectGoFiles(project);
  const stdout = [];
  const stderr = [];
  const relatedFiles = new Set();
  let durationMs = 0;
  let executionFailed = false;

  for (let index = 0; index < files.length; index += GO_FORMAT_BATCH_SIZE) {
    const batch = files.slice(index, index + GO_FORMAT_BATCH_SIZE);
    const command = `gofmt -d ${batch.map((file) => shellQuote(file.absolute)).join(" ")}`;
    const result = await execute(command, project.root);
    durationMs += result.durationMs || 0;
    if (result.stdout) stdout.push(result.stdout);
    if (result.stderr) stderr.push(result.stderr);
    if (result.exitCode !== 0) executionFailed = true;
    if (result.stdout.trim()) {
      for (const file of batch) {
        if (formatDiffReferences(result.stdout, file.absolute)) relatedFiles.add(file.relative);
      }
    }
  }

  const hasDiff = relatedFiles.size > 0;
  const ok = !executionFailed && !hasDiff;
  if (hasDiff) {
    stderr.push(`Go formatting differs in ${relatedFiles.size} file(s): ${[...relatedFiles].join(", ")}\n`);
  }

  return {
    exitCode: ok ? 0 : 1,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    durationMs,
    relatedFiles: [...relatedFiles],
    summary: {
      mainError: ok
        ? null
        : (hasDiff ? `gofmt differences found in ${relatedFiles.size} file(s)` : "gofmt check failed"),
      failedTests: ok ? 0 : Math.max(1, relatedFiles.size)
    }
  };
}

async function checkGoModules(project, execute) {
  const modules = validModules(project);
  const stdout = [];
  const stderr = [];
  const relatedFiles = new Set();
  let durationMs = 0;
  let failedChecks = 0;

  for (const moduleRoot of modules) {
    const label = relativeLabel(project.root, moduleRoot);
    const verifyResult = await execute("go mod verify", moduleRoot);
    durationMs += verifyResult.durationMs || 0;
    appendCommandOutput(stdout, stderr, label, "go mod verify", verifyResult);
    if (verifyResult.exitCode !== 0) {
      failedChecks += 1;
      relatedFiles.add(relativeFile(project.root, path.join(moduleRoot, "go.mod")));
      const goSum = path.join(moduleRoot, "go.sum");
      if (fs.existsSync(goSum)) relatedFiles.add(relativeFile(project.root, goSum));
      continue;
    }

    const tidy = await checkModuleTidy(project.root, moduleRoot, execute);
    durationMs += tidy.durationMs;
    appendCommandOutput(stdout, stderr, label, "go mod tidy", tidy);
    for (const file of tidy.relatedFiles) relatedFiles.add(file);
    if (tidy.exitCode !== 0) failedChecks += 1;
  }

  const ok = failedChecks === 0;
  return {
    exitCode: ok ? 0 : 1,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    durationMs,
    relatedFiles: [...relatedFiles],
    summary: {
      mainError: ok
        ? null
        : `Go module verification failed in ${failedChecks} module check(s)`,
      failedTests: ok ? 0 : failedChecks
    }
  };
}

async function checkModuleTidy(projectRoot, moduleRoot, execute) {
  const goMod = path.join(moduleRoot, "go.mod");
  const goSum = path.join(moduleRoot, "go.sum");
  const originalMod = fs.readFileSync(goMod);
  const originalSum = fs.existsSync(goSum) ? fs.readFileSync(goSum) : null;
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-go-tidy-"));
  const temporaryMod = path.join(temporaryDirectory, "check.mod");
  const temporarySum = temporaryMod.replace(/\.mod$/, ".sum");
  const relatedFiles = [];

  fs.writeFileSync(temporaryMod, originalMod);
  if (originalSum) fs.writeFileSync(temporarySum, originalSum);

  try {
    const command = `GOWORK=off go mod tidy -modfile=${shellQuote(temporaryMod)}`;
    const result = await execute(command, moduleRoot);
    if (result.exitCode !== 0) {
      const failedFiles = [relativeFile(projectRoot, goMod)];
      if (originalSum) failedFiles.push(relativeFile(projectRoot, goSum));
      return {
        ...result,
        relatedFiles: failedFiles
      };
    }

    const tidyMod = fs.readFileSync(temporaryMod);
    const tidySum = fs.existsSync(temporarySum) ? fs.readFileSync(temporarySum) : null;
    if (!tidyMod.equals(originalMod)) relatedFiles.push(relativeFile(projectRoot, goMod));
    if (!sameOptionalBuffer(tidySum, originalSum)) relatedFiles.push(relativeFile(projectRoot, goSum));

    if (relatedFiles.length === 0) return { ...result, relatedFiles };
    return {
      ...result,
      exitCode: 1,
      stderr: `${result.stderr || ""}go mod tidy would change: ${relatedFiles.join(", ")}\n`,
      relatedFiles
    };
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function collectGoFiles(project) {
  const files = [];
  const seen = new Set();
  for (const moduleRoot of validModules(project)) {
    walkGoFiles(moduleRoot, moduleRoot, project.root, files, seen);
  }
  return files.sort((left, right) => left.relative.localeCompare(right.relative));
}

function walkGoFiles(directory, moduleRoot, projectRoot, files, seen) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      if (absolute !== moduleRoot && fs.existsSync(path.join(absolute, "go.mod"))) continue;
      walkGoFiles(absolute, moduleRoot, projectRoot, files, seen);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".go")) continue;
    const identity = fs.realpathSync(absolute);
    if (seen.has(identity)) continue;
    seen.add(identity);
    files.push({
      absolute,
      relative: relativeFile(projectRoot, absolute)
    });
  }
}

function validModules(project) {
  if (project.manifest === "go.work") {
    return (project.modules || []).filter((module) => module.valid).map((module) => module.root);
  }
  return [project.root];
}

function appendCommandOutput(stdout, stderr, label, command, result) {
  const prefix = label === "." ? "" : `[${label}] `;
  if (result.stdout) stdout.push(`${prefix}${command}\n${result.stdout}`);
  if (result.stderr) stderr.push(`${prefix}${command}\n${result.stderr}`);
}

function formatDiffReferences(diff, absoluteFile) {
  return diff.includes(absoluteFile) || diff.includes(path.basename(absoluteFile));
}

function sameOptionalBuffer(left, right) {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

function relativeLabel(root, target) {
  return relativeFile(root, target) || ".";
}

function relativeFile(root, target) {
  const relative = path.relative(root, target).split(path.sep).join("/");
  return relative || ".";
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
