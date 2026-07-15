#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const STANDALONE_BUILD_PROTOCOL_VERSION = "agentshell.standalone-build.v1";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseBuildStandaloneArgs(args) {
  const options = { dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--out") {
      const output = args[index + 1];
      if (!output || output.startsWith("--")) {
        throw new Error("--out requires a file path");
      }
      options.out = output;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export function buildStandalone(options = {}, dependencies = {}) {
  const platform = dependencies.platform || process.platform;
  const arch = dependencies.arch || process.arch;
  const packageRoot = path.resolve(dependencies.root || root);
  const run = dependencies.run || defaultRunner;
  const target = `${platform}-${arch}`;
  const output = path.resolve(packageRoot, options.out || path.join("bin", `agentshell-${target}`));
  const entitlements = path.join(packageRoot, "desktop", "macos", "AgentShellCLI.entitlements");

  if (platform !== "darwin" || arch !== "arm64") {
    throw new Error(`Unsupported standalone target: ${target}. AgentShell currently builds standalone releases for macOS arm64 only.`);
  }

  const bundleCommand = {
    command: "bun",
    args: [
      "build",
      path.join(packageRoot, "src", "cli.js"),
      "--target=node",
      "--format=cjs",
      "--outfile",
      "<temporary>/agentshell.cjs"
    ]
  };

  if (options.dryRun) {
    return {
      ok: true,
      protocolVersion: STANDALONE_BUILD_PROTOCOL_VERSION,
      status: "dry-run",
      target,
      output,
      bytes: null,
      sha256: null,
      runtimeDependency: false,
      build: bundleCommand,
      signing: { identity: "ad-hoc", status: "planned" },
      smokeChecks: plannedSmokeChecks()
    };
  }

  const bunVersion = run("bun", ["--version"], { cwd: packageRoot });
  ensureSucceeded(bunVersion, "Bun is required to build the standalone binary. Install Bun and ensure `bun` is on PATH.");

  fs.mkdirSync(path.dirname(output), { recursive: true });
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-sea-build-"));
  try {
    const bundle = path.join(buildDir, "agentshell.cjs");
    const blob = path.join(buildDir, "agentshell.blob");
    const config = path.join(buildDir, "sea-config.json");
    const bundleArgs = bundleCommand.args.map((arg) => arg === "<temporary>/agentshell.cjs" ? bundle : arg);
    ensureSucceeded(run(bundleCommand.command, bundleArgs, { cwd: packageRoot }), "Bun failed to bundle AgentShell for Node SEA.");
    assertSeaBundleCompatibility(bundle, { packageRoot });
    fs.writeFileSync(config, `${JSON.stringify({
      main: bundle,
      output: blob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false
    }, null, 2)}\n`);
    ensureSucceeded(run(process.execPath, ["--experimental-sea-config", config], { cwd: packageRoot }), "Node failed to create the SEA preparation blob.");
    fs.copyFileSync(process.execPath, output);
    fs.chmodSync(output, 0o755);
    const removeSignature = run("codesign", ["--remove-signature", output], { cwd: packageRoot });
    if (removeSignature.status !== 0 && !String(removeSignature.stderr || "").includes("code object is not signed")) {
      ensureSucceeded(removeSignature, "Could not prepare the Node executable for SEA injection.");
    }
    fs.chmodSync(output, 0o755);
    ensureSucceeded(run("npx", [
      "--yes", "postject@1.0.0-alpha.6", output, "NODE_SEA_BLOB", blob,
      "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
      "--macho-segment-name", "NODE_SEA"
    ], { cwd: packageRoot }), "postject failed to inject the Node SEA blob.");
    ensureSucceeded(run("codesign", ["--force", "--deep", "--sign", "-", "--entitlements", entitlements, output], { cwd: packageRoot }), "macOS ad-hoc signing failed for the standalone binary.");
    ensureSucceeded(run("codesign", ["--verify", "--strict", output], { cwd: packageRoot }), "macOS rejected the standalone binary signature.");
  } catch (error) {
    fs.rmSync(output, { force: true });
    throw error;
  } finally {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }

  const temporaryCwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-standalone-smoke-"));
  let smokeChecks;
  try {
    smokeChecks = runSmokeChecks(output, packageRoot, temporaryCwd, run);
  } finally {
    fs.rmSync(temporaryCwd, { recursive: true, force: true });
  }

  const artifact = fs.readFileSync(output);
  return {
    ok: true,
    protocolVersion: STANDALONE_BUILD_PROTOCOL_VERSION,
    status: "built",
    target,
    output,
    bytes: artifact.byteLength,
    sha256: crypto.createHash("sha256").update(artifact).digest("hex"),
    runtimeDependency: false,
    signing: { identity: "ad-hoc", status: "signed", verified: true },
    builder: {
      bundler: "bun",
      bunVersion: bunVersion.stdout.trim(),
      runtime: "node-sea",
      nodeVersion: process.versions.node,
      injector: "postject@1.0.0-alpha.6"
    },
    smokeChecks
  };
}

export function assertSeaBundleCompatibility(bundle, options = {}) {
  const source = fs.readFileSync(bundle, "utf8");
  if (/import\.meta(?:\.|\[)/u.test(source)) {
    throw new Error("Bundled AgentShell still contains import.meta syntax, which Node 20 SEA cannot execute as CommonJS.");
  }
  const packageRoot = options.packageRoot && path.resolve(options.packageRoot);
  if (packageRoot && source.includes(packageRoot)) {
    throw new Error("Bundled AgentShell contains the build machine package path. Runtime package discovery must remain relocatable.");
  }
}

function runSmokeChecks(binary, packageRoot, cwd, run) {
  const environment = {
    ...process.env,
    AGENTSHELL_PACKAGE_ROOT: packageRoot
  };
  const definitions = [
    { name: "version", args: ["--version"], protocolVersion: "agentshell.version.v1" },
    { name: "schema-list", args: ["schema", "list"], protocolVersion: "agentshell.schema-list.v1" },
    { name: "plugin-status", args: ["plugin", "status", "--compact"], protocolVersion: "agentshell.plugin-status.v1", allowStatus: [0, 1] }
  ];

  return definitions.map((definition) => {
    const result = run(binary, definition.args, { cwd, env: environment });
    if (!(definition.allowStatus || [0]).includes(result.status)) {
      throw new Error(`${definition.name} smoke check failed: ${diagnosticOutput(result)}`);
    }
    let payload;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      throw new Error(`${definition.name} smoke check did not return JSON: ${diagnosticOutput(result)}`);
    }
    if (payload.protocolVersion !== definition.protocolVersion) {
      throw new Error(`${definition.name} smoke check returned protocol ${payload.protocolVersion || "missing"}; expected ${definition.protocolVersion}`);
    }
    return {
      name: definition.name,
      ok: true,
      protocolVersion: payload.protocolVersion,
      exitCode: result.status
    };
  });
}

function plannedSmokeChecks() {
  return [
    { name: "version", command: ["--version"], status: "planned" },
    { name: "schema-list", command: ["schema", "list"], status: "planned" },
    { name: "plugin-status", command: ["plugin", "status", "--compact"], status: "planned", cwd: "temporary non-source directory" }
  ];
}

function defaultRunner(command, args, options) {
  return spawnSync(command, args, {
    ...options,
    encoding: "utf8"
  });
}

function ensureSucceeded(result, message) {
  if (result.error?.code === "ENOENT") throw new Error(message);
  if (result.status !== 0) throw new Error(`${message} ${diagnosticOutput(result)}`.trim());
}

function diagnosticOutput(result) {
  return (
    result.stderr ||
    result.stdout ||
    result.error?.message ||
    (result.signal ? `terminated by ${result.signal}` : `exit ${result.status}`)
  ).trim();
}

async function main() {
  try {
    const report = buildStandalone(parseBuildStandaloneArgs(process.argv.slice(2)));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      protocolVersion: STANDALONE_BUILD_PROTOCOL_VERSION,
      error: {
        code: "STANDALONE_BUILD_FAILED",
        message: error.message
      }
    }, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
