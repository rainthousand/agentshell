#!/usr/bin/env node
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_COMPACT_BUDGET,
  findCompactBudgetViolations,
  measureCompactOutput,
  normalizeCompactBudget
} from "../src/core/compact-budget.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const PROTOCOL_VERSION = "agentshell.compact-contract-audit.v1";

export const REPRESENTATIVE_COMPACT_COMMANDS = Object.freeze([
  Object.freeze({ name: "manual", args: ["manual"] }),
  Object.freeze({ name: "start", args: ["start", "--compact"] }),
  Object.freeze({ name: "understand", args: ["understand", "--compact"] }),
  Object.freeze({ name: "tree", args: ["tree", "--compact"] }),
  Object.freeze({ name: "git-status", args: ["git", "status", "--compact"] }),
  Object.freeze({ name: "metrics", args: ["metrics", "--compact", "--limit", "5"] })
]);

export function auditCompactValue(name, value, options = {}) {
  const limits = normalizeCompactBudget(options.budget || options);
  const measurement = options.serializedOutput
    ? measureCompactOutput(options.serializedOutput)
    : measureCompactOutput(value);
  const oversizedPaths = findCompactBudgetViolations(value, limits)
    .filter((entry) => entry.path !== "$.protocolVersion");
  const contractIssues = compactContractIssues(value);

  upsertRootViolation(oversizedPaths, "chars", measurement.chars, limits.maxChars);
  upsertRootViolation(oversizedPaths, "estimatedTokens", measurement.estimatedTokens, limits.maxEstimatedTokens);

  return {
    name,
    ok: oversizedPaths.length === 0 && contractIssues.length === 0,
    chars: measurement.chars,
    estimatedTokens: measurement.estimatedTokens,
    oversizedPaths,
    contractIssues
  };
}

function upsertRootViolation(paths, kind, actual, limit) {
  const index = paths.findIndex((entry) => entry.path === "$" && entry.kind === kind);
  if (actual <= limit) {
    if (index >= 0) paths.splice(index, 1);
    return;
  }
  const violation = { path: "$", kind, actual, limit };
  if (index >= 0) paths[index] = violation;
  else paths.push(violation);
}

export function auditCompactFixtures(fixtures, options = {}) {
  return fixtures.map((fixture, index) => {
    const name = fixture?.name || `fixture-${index + 1}`;
    const value = Object.hasOwn(fixture || {}, "value") ? fixture.value : fixture;
    return auditCompactValue(name, value, {
      budget: options.budget,
      serializedOutput: fixture?.serializedOutput
    });
  });
}

export function runCompactContractAudit(options = {}) {
  const limits = normalizeCompactBudget(options.budget || DEFAULT_COMPACT_BUDGET);
  const checks = [];
  if (options.fixtures) checks.push(...auditCompactFixtures(options.fixtures, { budget: limits }));

  const shouldRunCommands = options.commands !== undefined || !options.fixtures;
  if (shouldRunCommands) {
    const commands = options.commands || REPRESENTATIVE_COMPACT_COMMANDS;
    const cli = path.resolve(options.cli || path.join(ROOT, "src", "cli.js"));
    const cwd = path.resolve(options.cwd || ROOT);
    for (const command of commands) checks.push(auditCommand(command, { cli, cwd, limits, timeoutMs: options.timeoutMs }));
  }

  const failed = checks.filter((check) => !check.ok);
  const oversizedPaths = failed.flatMap((check) => check.oversizedPaths.map((entry) => ({ command: check.name, ...entry })));
  const contractIssueCount = checks.reduce((total, check) => total + check.contractIssues.length, 0);
  return {
    ok: failed.length === 0,
    protocolVersion: PROTOCOL_VERSION,
    compact: true,
    summary: {
      checked: checks.length,
      passed: checks.length - failed.length,
      failed: failed.length,
      oversizedPathCount: oversizedPaths.length,
      contractIssueCount
    },
    limits,
    checks,
    oversizedPaths
  };
}

function auditCommand(command, options) {
  const descriptor = normalizeCommand(command);
  const result = spawnSync(process.execPath, [options.cli, ...descriptor.args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 2 * 1024 * 1024,
    timeout: options.timeoutMs || 30_000
  });
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return {
      name: descriptor.name,
      ok: false,
      chars: result.stdout.length,
      estimatedTokens: measureCompactOutput(result.stdout).estimatedTokens,
      oversizedPaths: [],
      contractIssues: [`invalid JSON output (exit ${result.status ?? "unknown"})`]
    };
  }
  const audit = auditCompactValue(descriptor.name, value, {
    budget: options.limits,
    serializedOutput: result.stdout
  });
  if (result.error) audit.contractIssues.push(`execution failed: ${result.error.message}`);
  if (result.signal) audit.contractIssues.push(`execution terminated by ${result.signal}`);
  if (result.status !== 0 && value?.ok !== false) audit.contractIssues.push(`unexpected exit status ${result.status}`);
  audit.ok = audit.oversizedPaths.length === 0 && audit.contractIssues.length === 0;
  return audit;
}

function compactContractIssues(value) {
  const issues = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["response must be an object"];
  if (typeof value.ok !== "boolean") issues.push("$.ok must be boolean");
  if (typeof value.protocolVersion !== "string") issues.push("$.protocolVersion must be string");
  if (value.compact !== true) issues.push("$.compact must be true");
  if (!Object.hasOwn(value, "summary")) issues.push("$.summary is required");
  return issues;
}

function normalizeCommand(command) {
  if (Array.isArray(command)) return { name: command.join(" "), args: command.map(String) };
  if (!command || !Array.isArray(command.args)) throw new TypeError("Each command requires an args array");
  return { name: command.name || command.args.join(" "), args: command.args.map(String) };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--cli", "--cwd"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
      options[arg === "--cli" ? "cli" : "cwd"] = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") return { help: true };
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write("Usage: node scripts/compact-contract-audit.js [--cli <file>] [--cwd <project>]\n");
      return;
    }
    const report = runCompactContractAudit(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      protocolVersion: PROTOCOL_VERSION,
      compact: true,
      summary: { checked: 0, passed: 0, failed: 1, oversizedPathCount: 0, contractIssueCount: 1 },
      error: error.message
    })}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
