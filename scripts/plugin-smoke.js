#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
export const PLUGIN_SMOKE_PROTOCOL_VERSION = "agentshell.plugin-smoke.v1";
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(formatHelp(args.format));
  process.exit(0);
}

const installedPath = path.resolve(args.path || defaultInstalledPath());
const smokeWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-plugin-smoke-"));
const checks = [];

check("installed path exists", () => {
  assert(fs.existsSync(installedPath), `Missing installed path: ${installedPath}`);
});

check("installed plugin manifest identity is stable", () => {
  const manifest = readJson(path.join(installedPath, ".codex-plugin", "plugin.json"));
  assert(manifest.name === "agentshell", `installed manifest name ${manifest.name} !== agentshell`);
  assert(manifest.author?.name === "Alvin", `installed manifest author.name ${manifest.author?.name} !== Alvin`);
  assert(manifest.interface?.developerName === "Alvin", `installed manifest interface.developerName ${manifest.interface?.developerName} !== Alvin`);
});

check("V1 delivery contract is complete and MCP is deferred", () => {
  const packageJson = readJson(path.join(installedPath, "package.json"));
  const delivery = packageJson.agentshellDelivery;
  assert(delivery?.protocolVersion === "agentshell.delivery.v1", "package delivery protocol is missing");
  assert(delivery.surface === "codex-local-cli", `unexpected delivery surface: ${delivery.surface}`);
  assert(delivery.mcp === "deferred", `MCP delivery state ${delivery.mcp} !== deferred`);
  assert(packageJson.bin?.["agentshell-mcp"] === undefined, "package exposes agentshell-mcp");
  assert(Array.isArray(delivery.requiredPaths) && delivery.requiredPaths.length > 0, "requiredPaths is empty");
  assert(Array.isArray(delivery.forbiddenPaths) && delivery.forbiddenPaths.length > 0, "forbiddenPaths is empty");
  for (const relativePath of delivery.requiredPaths) {
    assert(fs.existsSync(path.join(installedPath, relativePath)), `required delivery path is missing: ${relativePath}`);
  }
  for (const relativePath of delivery.forbiddenPaths) {
    assert(!fs.existsSync(path.join(installedPath, relativePath)), `forbidden delivery path is present: ${relativePath}`);
  }
});

check("release payload excludes repository and runtime state", () => {
  for (const name of [".agentshell", ".git", "artifacts", "node_modules"]) {
    assert(!fs.existsSync(path.join(installedPath, name)), `installed plugin includes ${name}`);
  }
});

check("skill bundle references are self-contained", () => {
  const skillPath = path.join(installedPath, "skills", "agentshell", "SKILL.md");
  const skill = fs.readFileSync(skillPath, "utf8");
  assert(skill.includes("agentshell start --compact"), "skill does not recommend compact start");
  assert(skill.includes("MCP is deferred"), "skill does not preserve the local-only boundary");
  for (const reference of markdownReferences(skill)) {
    const resolved = path.resolve(path.dirname(skillPath), reference);
    assert(resolved.startsWith(`${path.dirname(skillPath)}${path.sep}`), `skill reference escapes bundle: ${reference}`);
    assert(fs.existsSync(resolved), `skill reference is missing: ${reference}`);
  }
});

check("installed launcher reports the packaged version", () => {
  const packageJson = readJson(path.join(installedPath, "package.json"));
  const launcher = path.join(installedPath, "bin", "agentshell");
  assert((fs.statSync(launcher).mode & 0o111) !== 0, "bin/agentshell is not executable");
  const version = runAgentShell(["--version"]);
  assert(version.status === 0, `agentshell --version failed: ${version.output}`);
  const output = parseJson(version.output, "version output");
  assert(output.protocolVersion === "agentshell.version.v1", "version protocol is missing");
  assert(output.version === packageJson.version, `CLI version ${output.version} !== package version ${packageJson.version}`);
});

check("installed CLI exposes compact core contracts", () => {
  const manual = runAgentShell(["manual"]);
  assert(manual.status === 0, `agentshell manual failed: ${manual.output}`);
  const manualOutput = parseJson(manual.output, "manual output");
  assert(manualOutput.compact === true, "manual default is not compact");
  assert(manualOutput.firstPass?.command === "agentshell start --compact", "manual first pass is not compact start");

  const schema = runAgentShell(["schema", "get", "verify"]);
  assert(schema.status === 0, `schema get verify failed: ${schema.output}`);
  const schemaOutput = parseJson(schema.output, "verify schema output");
  assert(schemaOutput.protocolVersion === "agentshell.schema-get.v1", "schema-get protocol is missing");
  assert(schemaOutput.oneOf?.[0]?.properties?.protocolVersion?.const === "agentshell.verify.v1", "verify schema contract is missing");

  const pwd = runAgentShell(["pwd", "--compact"]);
  assert(pwd.status === 0, `agentshell pwd --compact failed: ${pwd.output}`);
  assert(parseJson(pwd.output, "pwd output").protocolVersion === "agentshell.pwd.v1", "pwd compact protocol is missing");
});

check("installed plugin bundles the native macOS dashboard", () => {
  if (process.platform !== "darwin") return;
  const executable = path.join(installedPath, "desktop", "macos", "dist", "AgentShell Dashboard.app", "Contents", "MacOS", "AgentShellDashboard");
  assert(fs.existsSync(executable), "native dashboard executable is missing");
  assert((fs.statSync(executable).mode & 0o111) !== 0, "native dashboard executable is not executable");
});

const failed = checks.filter((entry) => !entry.ok);
const report = {
  ok: failed.length === 0,
  protocolVersion: PLUGIN_SMOKE_PROTOCOL_VERSION,
  installedPath,
  summary: { checks: checks.length, passed: checks.length - failed.length, failed: failed.length },
  checks
};

console.log(args.format === "markdown" ? renderMarkdown(report) : JSON.stringify(report, null, 2));
fs.rmSync(smokeWorkspace, { recursive: true, force: true });
if (!report.ok) process.exitCode = 1;

function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true, error: null });
  } catch (error) {
    checks.push({ name, ok: false, error: error.message });
  }
}

function runAgentShell(argv) {
  const command = path.join(installedPath, "bin", "agentshell");
  const result = spawnSync(command, argv, {
    cwd: smokeWorkspace,
    encoding: "utf8",
    env: { ...process.env, AGENTSHELL_PACKAGE_ROOT: installedPath }
  });
  return {
    status: result.status,
    output: [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n").trim()
  };
}

function markdownReferences(source) {
  return [...source.matchAll(/\[[^\]]+\]\(([^)]+\.md)\)/g)]
    .map((match) => match[1])
    .filter((value) => !/^[a-z]+:/i.test(value) && !value.startsWith("/"));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} is not JSON: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  const parsed = { path: null, format: "json", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--path") {
      if (!argv[index + 1]) throw new Error("--path requires a value");
      parsed.path = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--path=")) {
      parsed.path = arg.slice("--path=".length);
    } else if (arg === "--markdown") {
      parsed.format = "markdown";
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function defaultInstalledPath() {
  const manifest = readJson(path.join(root, ".codex-plugin", "plugin.json"));
  return path.join(os.homedir(), ".codex", "plugins", "cache", "personal", manifest.name, manifest.version);
}

function formatHelp(format) {
  if (format === "markdown") return "# AgentShell Plugin Smoke\n\n`node scripts/plugin-smoke.js [--path <installedPath>] [--markdown]`";
  return JSON.stringify({
    ok: true,
    protocolVersion: PLUGIN_SMOKE_PROTOCOL_VERSION,
    usage: "node scripts/plugin-smoke.js [--path <installedPath>] [--markdown]"
  }, null, 2);
}

function renderMarkdown(value) {
  return [
    "# AgentShell Plugin Smoke",
    "",
    `Installed path: \`${value.installedPath}\``,
    `Result: **${value.ok ? "PASS" : "FAIL"}** (${value.summary.passed}/${value.summary.checks})`,
    "",
    ...value.checks.flatMap((entry) => [
      `- [${entry.ok ? "x" : " "}] ${entry.name}`,
      ...(entry.error ? [`  - ${entry.error}`] : [])
    ])
  ].join("\n");
}
