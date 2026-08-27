import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function run(...args) {
  return spawnSync("node", ["src/cli.js", ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

test("help exposes the complete verify command surface", () => {
  const result = run("--help");

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.ok(output.commands.includes("agentshell verify test [--profile fast|race|coverage] [--compact] [--tail N] [--no-cache]"));
  assert.ok(output.commands.includes("agentshell verify cache <explain|clear> [--compact]"));
  assert.ok(output.commands.includes("agentshell verify <build|lint|format|modules|generate> [--compact] [--tail N]"));
  assert.ok(output.commands.includes("agentshell verify benchmark [--bench REGEX] [--compact] [--tail N]"));
  assert.ok(output.commands.includes("agentshell verify fuzz --fuzz TARGET [--duration DURATION] --package PACKAGE [--compact] [--tail N]"));
  assert.ok(output.commands.includes("agentshell diagnose test [--compact] [--profile]"));
  assert.ok(output.commands.includes("agentshell fix test [--fast|--safe|--dry-run] [--compact] [--profile]"));
});

test("verify accepts the core validation types and rejects unknown types", () => {
  for (const type of ["test", "build", "lint", "format", "modules"]) {
    if (type === "test") continue;
    const result = run("verify", type);
    const output = JSON.parse(result.stdout);
    assert.notEqual(output.error?.code, "INVALID_ARGUMENT", `verify ${type} should reach the verifier`);
  }

  const invalid = run("verify", "deploy");
  assert.equal(invalid.status, 2);
  const output = JSON.parse(invalid.stdout);
  assert.equal(output.error.code, "INVALID_ARGUMENT");
  assert.match(output.error.message, /agentshell verify test/);
});

test("manual documents all validation commands and read-only checks", () => {
  const compact = run("manual");
  const full = run("manual", "--full");

  assert.equal(compact.status, 0, compact.stderr);
  assert.equal(full.status, 0, full.stderr);

  const compactOutput = JSON.parse(compact.stdout);
  const compactVerify = compactOutput.primaryCommands.find((entry) =>
    entry.command === "agentshell verify <test|build|lint|format|modules|benchmark|fuzz|generate>"
  );
  assert.ok(compactVerify);
  assert.match(compactVerify.note, /read-only checks/);

  const fullOutput = JSON.parse(full.stdout);
  for (const type of ["test", "build", "lint", "format", "modules"]) {
    assert.ok(fullOutput.commandMap.some((entry) => entry.command === `agentshell verify ${type} [--tail N]`));
  }
  assert.ok(fullOutput.commandMap.some((entry) => entry.command.startsWith("agentshell verify test --profile")));
  assert.ok(fullOutput.commandMap.some((entry) => entry.command.startsWith("agentshell verify benchmark")));
  assert.ok(fullOutput.commandMap.some((entry) => entry.command.startsWith("agentshell verify fuzz")));
  assert.ok(fullOutput.commandMap.some((entry) => entry.command.startsWith("agentshell verify generate")));
  assert.ok(fullOutput.rules.some((rule) => /format.*modules.*generate.*read-only checks/.test(rule)));
  assert.ok(fullOutput.rules.some((rule) => /Diagnose and fix remain test-only/.test(rule)));
});
