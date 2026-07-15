#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const MIB = 1024 * 1024;

export const RELEASE_SIZE_BUDGETS = Object.freeze({
  standaloneBytes: 100 * MIB,
  zipBytes: 40 * MIB
});

export function buildReleaseArtifacts(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || root);
  const outDir = path.resolve(options.outDir || path.join(projectRoot, "artifacts", "release"));
  const skipNativeBuild = options.skipNativeBuild ?? process.env.AGENTSHELL_SKIP_NATIVE_RELEASE_BUILD === "1";
  const runner = options.runner || spawnSync;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  if (platform === "darwin" && !skipNativeBuild) run(runner, projectRoot, "npm", ["run", "dashboard:build-app"]);
  let standaloneBuildReport = null;
  if (platform === "darwin" && arch === "arm64" && !skipNativeBuild) {
    standaloneBuildReport = parseRequiredReport(
      run(runner, projectRoot, "npm", ["run", "build:standalone"]).stdout,
      "Standalone build"
    );
  }
  const packageReport = parseRequiredReport(
    run(runner, projectRoot, "node", ["scripts/share-package.js", "--out-dir", outDir, "--name", "agentshell-codex-plugin", "--zip"]).stdout,
    "Share package"
  );
  const deliveryDir = path.join(outDir, "agentshell-codex-plugin");
  const lifecycle = runLifecycleGate(deliveryDir, { projectRoot, runner });
  const zip = path.join(outDir, "agentshell-codex-plugin.zip");
  const checksum = writeChecksum(zip);
  const standaloneSource = path.join(projectRoot, "bin", "agentshell-darwin-arm64");
  const standalone = path.join(outDir, path.basename(standaloneSource));
  fs.copyFileSync(standaloneSource, standalone);
  fs.chmodSync(standalone, 0o755);
  const standaloneChecksum = writeChecksum(standalone);
  const zipBytes = fs.statSync(zip).size;
  const standaloneBytes = fs.statSync(standalone).size;
  const packageBytes = directoryBytes(deliveryDir);
  const compressionRatio = packageBytes === 0 ? null : zipBytes / packageBytes;
  const zipToStandaloneRatio = standaloneBytes === 0 ? null : zipBytes / standaloneBytes;
  const sizeBudgets = evaluateReleaseSizeBudgets({ standaloneBytes, zipBytes }, options.sizeBudgets);
  const report = {
    ok: sizeBudgets.ok,
    protocolVersion: "agentshell.release-artifacts.v1",
    platform,
    arch,
    zip,
    bytes: zipBytes,
    zipBytes,
    packageBytes,
    sha256: checksum,
    compressionRatio,
    zipToStandaloneRatio,
    compression: {
      level: packageReport.zip?.compressionLevel ?? null,
      ratio: compressionRatio,
      archiveVerified: packageReport.zip?.verification?.ok === true
    },
    sizeBudgets,
    lifecycle,
    standalone: {
      path: standalone,
      bytes: standaloneBytes,
      sha256: standaloneChecksum,
      rebuilt: platform === "darwin" && arch === "arm64" && !skipNativeBuild,
      buildReport: standaloneBuildReport,
      builder: standaloneBuildReport?.builder ?? null
    }
  };
  fs.writeFileSync(path.join(outDir, "release-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  assertReleaseSizeBudgets(sizeBudgets);
  return report;
}

export function evaluateReleaseSizeBudgets(sizes, budgets = RELEASE_SIZE_BUDGETS) {
  const standaloneLimit = budgets?.standaloneBytes ?? RELEASE_SIZE_BUDGETS.standaloneBytes;
  const zipLimit = budgets?.zipBytes ?? RELEASE_SIZE_BUDGETS.zipBytes;
  const standalone = sizeBudgetResult(sizes.standaloneBytes, standaloneLimit);
  const zip = sizeBudgetResult(sizes.zipBytes, zipLimit);
  return { ok: standalone.ok && zip.ok, standalone, zip };
}

export function assertReleaseSizeBudgets(sizeBudgets) {
  if (sizeBudgets.ok) return sizeBudgets;
  const failures = Object.entries(sizeBudgets)
    .filter(([, value]) => value && typeof value === "object" && value.ok === false)
    .map(([name, value]) => `${name} is ${value.actualBytes} bytes (limit ${value.limitBytes})`);
  throw new Error(`Release artifact size budget exceeded: ${failures.join("; ")}`);
}

export function runLifecycleGate(deliveryDir, options = {}) {
  const projectRoot = path.resolve(options.projectRoot || root);
  const runner = options.runner || spawnSync;
  const result = runner("npm", ["run", "package:lifecycle:smoke", "--", "--package-dir", deliveryDir], {
    cwd: projectRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Packaged install lifecycle smoke failed");
  }
  const output = parseJsonOutput(result.stdout);
  if (output?.ok !== true) throw new Error(output?.error?.message || "Packaged install lifecycle smoke failed");
  return {
    protocolVersion: output.protocolVersion,
    packageVersion: output.packageVersion,
    packageDir: output.packageDir,
    summary: output.summary
  };
}

function run(runner, cwd, command, args) {
  const result = runner(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed`);
  return result;
}

function writeChecksum(file) {
  const checksum = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  fs.writeFileSync(`${file}.sha256`, `${checksum}  ${path.basename(file)}\n`);
  return checksum;
}

function parseJsonOutput(value) {
  const text = String(value || "").trim();
  const starts = [...text.matchAll(/(?:^|\n)(?=\{)/gu)].map((match) => match.index + (match[0] === "\n" ? 1 : 0));
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(text.slice(starts[index])); } catch {}
  }
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  return null;
}

function parseRequiredReport(stdout, label) {
  const report = parseJsonOutput(stdout);
  if (report?.ok !== true) throw new Error(report?.error?.message || `${label} did not return a successful JSON report`);
  return report;
}

function sizeBudgetResult(actualBytes, limitBytes) {
  return {
    actualBytes,
    limitBytes,
    ok: Number.isSafeInteger(actualBytes) && actualBytes >= 0 && actualBytes <= limitBytes
  };
}

function directoryBytes(directory) {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directoryBytes(target);
    else if (entry.isFile()) total += fs.statSync(target).size;
  }
  return total;
}

const mainFile = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (mainFile === fileURLToPath(import.meta.url)) {
  const report = buildReleaseArtifacts();
  console.log(JSON.stringify(report, null, 2));
}
