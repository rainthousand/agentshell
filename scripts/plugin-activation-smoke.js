#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const PROTOCOL_VERSION = "agentshell.plugin-activation-smoke.v1";
const MAX_ERROR_CHARS = 240;

export function runPluginActivationSmoke(options = {}) {
  const cli = path.resolve(options.cli || path.join(root, "src", "cli.js"));
  const sourceSkill = path.resolve(options.sourceSkill || path.join(root, "skills", "agentshell", "SKILL.md"));
  const installedSkill = options.installedSkill ? resolveSkillPath(options.installedSkill) : null;
  const fixture = options.fixture || createFixture();
  const ownsFixture = !options.fixture;
  const checks = [];

  try {
    checks.push(runCliFlow(cli, fixture));
    checks.push(checkSkill("source", sourceSkill));
    if (installedSkill) checks.push(checkSkill("installed", installedSkill));
  } finally {
    if (ownsFixture) fs.rmSync(fixture, { recursive: true, force: true });
  }

  const failed = checks.filter((check) => !check.ok).length;
  return {
    ok: failed === 0,
    protocolVersion: PROTOCOL_VERSION,
    compact: true,
    summary: {
      total: checks.length,
      passed: checks.length - failed,
      failed
    },
    checks
  };
}

function runCliFlow(cli, fixture) {
  const steps = [
    ["start", ["start", "--compact"]],
    ["verify", ["verify", "test", "--compact"]],
    ["trial-status", ["trial", "status"]]
  ];
  const results = [];

  for (const [name, args] of steps) {
    const result = runJson(cli, fixture, args);
    results.push({
      name,
      ok: result.ok,
      protocolVersion: result.value?.protocolVersion || null,
      estimatedTokens: result.estimatedTokens
    });
    if (!result.ok) {
      return {
        name: "bounded CLI activation flow",
        ok: false,
        steps: results,
        error: result.error
      };
    }
    if (name === "start" && result.value.compact !== true) {
      return failedFlow(results, "start did not return compact JSON");
    }
    if (name === "trial-status" && (result.value.status !== "ready" || result.value.ready !== true)) {
      return failedFlow(results, `trial status was ${result.value.status || "unknown"}, not ready`);
    }
  }

  const events = readJsonLines(path.join(fixture, ".agentshell", "events.jsonl"));
  const operations = readJsonLines(path.join(fixture, ".agentshell", "history.jsonl"));
  const eventCommands = events.map((event) => event.command);
  const hasStart = eventCommands.includes("start");
  const verifyEvent = events.find((event) => event.command === "verify" && event.ok === true);
  const verifyOperation = operations.find((operation) => operation.type === "verify" && operation.ok === true);
  if (!hasStart || !verifyEvent || !verifyOperation) {
    return failedFlow(results, "start and passing verification evidence were not both recorded");
  }

  return {
    name: "bounded CLI activation flow",
    ok: true,
    steps: results,
    evidence: {
      eventCount: events.length,
      verificationRecorded: true,
      trialReady: true
    }
  };
}

function checkSkill(label, skillPath) {
  if (!fs.existsSync(skillPath)) {
    return { name: `${label} skill activation guidance`, ok: false, error: "SKILL.md not found" };
  }
  const source = fs.readFileSync(skillPath, "utf8");
  const fallbackIndex = source.search(/fall back to (?:normal|ordinary) shell/i);
  const startIndex = source.indexOf("agentshell start --compact");
  const guidance = {
    projectRootFirst: /(?:project|checkout)(?:'s)? root|project-root-first|project root first/i.test(source),
    agentShellEarly: startIndex >= 0 && (fallbackIndex < 0 || startIndex < fallbackIndex),
    finalVerify: /final verification|verify test(?:`)? again/i.test(source),
    betaExport: /trial export --verify|trial export[^\n]{0,100}(?:beta|evidence|sharing)/i.test(source)
  };
  const missing = Object.entries(guidance).filter(([, ok]) => !ok).map(([name]) => name);
  return {
    name: `${label} skill activation guidance`,
    ok: missing.length === 0,
    guidance,
    ...(missing.length > 0 ? { error: `Missing guidance: ${missing.join(", ")}` } : {})
  };
}

function runJson(cli, cwd, args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 1024 * 1024,
    timeout: 15_000
  });
  let value = null;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return {
      ok: false,
      value: null,
      estimatedTokens: 0,
      error: compactError(`invalid JSON response (exit ${result.status ?? "unknown"})`)
    };
  }
  return {
    ok: result.status === 0 && value?.ok === true,
    value,
    estimatedTokens: Math.ceil(result.stdout.length / 4),
    error: result.status === 0 && value?.ok === true
      ? null
      : compactError(value?.error?.message || `command exited ${result.status ?? "unknown"}`)
  };
}

function createFixture() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-activation-smoke-"));
  fs.writeFileSync(path.join(fixture, "package.json"), `${JSON.stringify({
    name: "agentshell-activation-fixture",
    private: true,
    scripts: { test: "node --test fixture.test.js" }
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(fixture, "fixture.test.js"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'test("activation fixture", () => assert.equal(2 + 2, 4));',
    ""
  ].join("\n"));
  return fixture;
}

function resolveSkillPath(value) {
  const resolved = path.resolve(value);
  return resolved.endsWith("SKILL.md") ? resolved : path.join(resolved, "skills", "agentshell", "SKILL.md");
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function failedFlow(steps, error) {
  return { name: "bounded CLI activation flow", ok: false, steps, error: compactError(error) };
}

function compactError(value) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_CHARS);
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (["--cli", "--source", "--installed"].includes(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
      if (arg === "--cli") options.cli = value;
      if (arg === "--source") options.sourceSkill = value;
      if (arg === "--installed") options.installedSkill = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write("Usage: node scripts/plugin-activation-smoke.js [--cli <file>] [--source <SKILL.md>] [--installed <plugin-root-or-SKILL.md>]\n");
      return;
    }
    const report = runPluginActivationSmoke(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      protocolVersion: PROTOCOL_VERSION,
      compact: true,
      error: compactError(error.message)
    })}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
