#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSION = "agentshell.ci-release-verification.v1";
const REQUIRED_FILES = [
  "agentshell-codex-plugin.zip",
  "agentshell-codex-plugin.zip.sha256",
  "agentshell-darwin-arm64",
  "agentshell-darwin-arm64.sha256",
  "release-report.json"
];
const PATH_LEAKS = [
  { name: "macOS user path", pattern: /\/Users\/[^/\s]+\//u },
  { name: "Linux user path", pattern: /\/home\/[^/\s]+\//u },
  { name: "Windows user path", pattern: /[A-Za-z]:\\Users\\[^\\\s]+\\/u },
  { name: "GitHub workspace path", pattern: /\/__w\/[^/\s]+\//u }
];
const REQUIRED_PACKAGE_PATHS = [
  ".codex-plugin/plugin.json",
  "package.json",
  "skills/agentshell/SKILL.md",
  "install.command",
  "bin/agentshell-darwin-arm64"
];

export function verifyReleaseArtifacts(options = {}) {
  const directory = path.resolve(options.directory || "artifacts/release");
  for (const name of REQUIRED_FILES) assertFile(path.join(directory, name));

  const zip = path.join(directory, "agentshell-codex-plugin.zip");
  const standalone = path.join(directory, "agentshell-darwin-arm64");
  const reportPath = path.join(directory, "release-report.json");
  const report = readJson(reportPath);
  const zipSha256 = verifyChecksum(zip);
  const standaloneSha256 = verifyChecksum(standalone);

  assert.equal(report.ok, true, "release report must pass");
  assert.equal(report.protocolVersion, "agentshell.release-artifacts.v1");
  assert.equal(report.zip, "agentshell-codex-plugin.zip", "release report ZIP path must be artifact-relative");
  assert.equal(report.standalone?.path, "agentshell-darwin-arm64", "release report standalone path must be artifact-relative");
  assert.equal(report.lifecycle?.packageDir, "agentshell-codex-plugin", "release report package path must be artifact-relative");
  assert.equal(report.sha256, zipSha256, "ZIP hash must match release report");
  assert.equal(report.standalone?.sha256, standaloneSha256, "standalone hash must match release report");
  assert.equal(report.zipBytes, fs.statSync(zip).size, "ZIP size must match release report");
  assert.equal(report.standalone?.bytes, fs.statSync(standalone).size, "standalone size must match release report");
  assert.equal(report.sizeBudgets?.ok, true, "release size budgets must pass");
  assert.equal(report.sizeBudgets?.zip?.ok, true, "ZIP size budget must pass");
  assert.equal(report.sizeBudgets?.standalone?.ok, true, "standalone size budget must pass");
  assert.equal(report.compression?.archiveVerified, true, "archive verification must pass");
  assert.equal(report.lifecycle?.protocolVersion, "agentshell.package-lifecycle-smoke.v1");
  assert.equal(report.lifecycle?.summary?.passed, 4, "install/doctor/update/uninstall must pass");
  assert.equal(report.lifecycle?.summary?.finalState, "uninstalled", "lifecycle must leave no installation behind");

  if (options.requireToolchain) {
    const builder = report.standalone?.builder;
    assert.ok(builder, "standalone builder metadata is required");
    assert.equal(builder.bundler, "bun");
    assert.equal(builder.runtime, "node-sea");
    if (options.nodeVersion) assert.equal(builder.nodeVersion, options.nodeVersion, "unexpected standalone Node version");
    if (options.bunVersion) assert.equal(builder.bunVersion, options.bunVersion, "unexpected standalone Bun version");
  }

  const reportLeaks = findPathLeaksInFile(reportPath, directory);
  assert.deepEqual(reportLeaks, [], `release report contains build-machine paths: ${JSON.stringify(reportLeaks)}`);

  const extracted = extractReleaseZip(zip, options.runner || spawnSync);
  let pathLeaks;
  try {
    const packageDirectory = path.join(extracted.directory, "agentshell-codex-plugin");
    assertDirectory(packageDirectory);
    for (const required of REQUIRED_PACKAGE_PATHS) assertFile(path.join(packageDirectory, required));
    pathLeaks = findPathLeaks(packageDirectory);
    assert.deepEqual(pathLeaks, [], `delivery ZIP contains build-machine paths: ${JSON.stringify(pathLeaks)}`);
  } finally {
    fs.rmSync(extracted.directory, { recursive: true, force: true });
  }

  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    directory,
    checksums: { zip: zipSha256, standalone: standaloneSha256 },
    bytes: { zip: report.zipBytes, standalone: report.standalone.bytes },
    lifecycleSteps: report.lifecycle.summary.passed,
    pathLeaks: 0,
    toolchain: report.standalone.builder || null
  };
}

export function extractReleaseZip(zip, runner = spawnSync) {
  const listing = runner("unzip", ["-Z1", zip], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr || listing.stdout || "could not list release ZIP");
  const entries = String(listing.stdout || "").split(/\r?\n/u).filter(Boolean);
  assert.ok(entries.length > 0, "release ZIP must not be empty");
  for (const entry of entries) assertSafeZipEntry(entry);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-release-verify-"));
  const extracted = runner("unzip", ["-qq", zip, "-d", directory], { encoding: "utf8" });
  if (extracted.status !== 0) {
    fs.rmSync(directory, { recursive: true, force: true });
    assert.fail(extracted.stderr || extracted.stdout || "could not extract release ZIP");
  }
  return { directory, entries };
}

export function findPathLeaks(directory) {
  const findings = [];
  walk(directory, (file) => {
    const buffer = fs.readFileSync(file);
    if (buffer.length > 2_000_000 || buffer.subarray(0, 4096).includes(0)) return;
    const content = buffer.toString("utf8");
    for (const leak of PATH_LEAKS) {
      if (leak.pattern.test(content)) findings.push({ kind: leak.name, file: path.relative(directory, file) });
    }
  });
  return findings;
}

function findPathLeaksInFile(file, relativeRoot) {
  const content = fs.readFileSync(file, "utf8");
  return PATH_LEAKS
    .filter((leak) => leak.pattern.test(content))
    .map((leak) => ({ kind: leak.name, file: path.relative(relativeRoot, file) }));
}

function assertSafeZipEntry(entry) {
  assert.equal(entry.includes("\\"), false, `release ZIP contains non-portable path: ${entry}`);
  const portable = entry.replace(/\\/gu, "/");
  assert.equal(path.posix.isAbsolute(portable), false, `release ZIP contains absolute path: ${entry}`);
  assert.equal(portable.split("/").includes(".."), false, `release ZIP contains traversal path: ${entry}`);
  assert.ok(portable === "agentshell-codex-plugin/" || portable.startsWith("agentshell-codex-plugin/"),
    `release ZIP contains an unexpected top-level path: ${entry}`);
}

function verifyChecksum(file) {
  const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const checksumFile = `${file}.sha256`;
  const line = fs.readFileSync(checksumFile, "utf8").trim();
  assert.equal(line, `${actual}  ${path.basename(file)}`, `${path.basename(checksumFile)} is invalid`);
  return actual;
}

function walk(directory, visit) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target, visit);
    else if (entry.isFile()) visit(target);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertFile(file) {
  assert.equal(fs.existsSync(file) && fs.statSync(file).isFile(), true, `missing file: ${file}`);
}

function assertDirectory(directory) {
  assert.equal(fs.existsSync(directory) && fs.statSync(directory).isDirectory(), true, `missing directory: ${directory}`);
}

function parseArgs(argv) {
  const options = { directory: "artifacts/release", requireToolchain: false, nodeVersion: null, bunVersion: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dir") options.directory = requiredValue(argv, ++index, argument);
    else if (argument === "--node") options.nodeVersion = requiredValue(argv, ++index, argument);
    else if (argument === "--bun") options.bunVersion = requiredValue(argv, ++index, argument);
    else if (argument === "--require-toolchain") options.requireToolchain = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function requiredValue(argv, index, option) {
  if (!argv[index] || argv[index].startsWith("--")) throw new Error(`${option} requires a value`);
  return argv[index];
}

const mainFile = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (mainFile === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(verifyReleaseArtifacts(parseArgs(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, protocolVersion: PROTOCOL_VERSION, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}
