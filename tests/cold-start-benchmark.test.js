import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = path.resolve("scripts/cold-start-benchmark.js");

test("cold start benchmark reports external wall time and internal profile timing", () => {
  const fixture = createMockCliFixture();
  const result = spawnSync("node", [
    script,
    "--cli",
    fixture.cli,
    "--cwd",
    fixture.cwd,
    "--runs",
    "2"
  ], {
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.cold-start-benchmark.v1");
  assert.equal(output.runs, 2);
  assert.equal(output.commands.length, 4);
  assert.equal(output.summary.commandCount, 4);
  assert.equal(output.summary.totalCommandInvocations, 8);
  assert.ok(output.commands.some((command) => command.id === "plugin-validate-compact"));
  assert.ok(output.commands.some((command) => command.id === "start-compact"));

  const profiled = output.commands.find((command) => command.id === "plugin-validate-compact");
  assert.equal(profiled.summary.averageProfileTotalMs, 7);
  assert.equal(profiled.summary.averageProfileMeasuredMs, 5);
  assert.equal(profiled.summary.averageProcessOverheadMs >= 0, true);
  assert.equal(profiled.runs[0].profileTotalMs, 7);
});

test("cold start benchmark can render markdown and write reports", () => {
  const fixture = createMockCliFixture();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-cold-start-report-"));
  const jsonReport = path.join(tempDir, "nested", "cold-start.json");
  const markdownReport = path.join(tempDir, "nested", "cold-start.md");
  const result = spawnSync("node", [
    script,
    "--cli",
    fixture.cli,
    "--cwd",
    fixture.cwd,
    "--runs",
    "1",
    "--report",
    jsonReport,
    "--markdown",
    markdownReport
  ], {
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const stdoutReport = JSON.parse(result.stdout);
  const artifactReport = JSON.parse(fs.readFileSync(jsonReport, "utf8"));
  const markdown = fs.readFileSync(markdownReport, "utf8");

  assert.deepEqual(artifactReport, stdoutReport);
  assert.match(markdown, /^# AgentShell Cold-Start Benchmark/);
  assert.match(markdown, /Commands measured: 4/);
  assert.match(markdown, /Total command invocations: 4/);
  assert.match(markdown, /\| Command \| Avg wall time \| Avg profile total \| Avg process overhead \| Avg stdout chars \| Avg tokens \|/);
  assert.match(markdown, /\| plugin-validate-compact \| \d+ms \| 7ms \| \d+ms \|/);
});

test("package exposes cold start benchmark script", () => {
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(packageJson.scripts?.["benchmark:cold-start"], "node scripts/cold-start-benchmark.js");
});

function createMockCliFixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-cold-start-benchmark-"));
  const cli = path.join(cwd, "mock-cli.js");
  fs.writeFileSync(cli, [
    "const args = process.argv.slice(2);",
    "function output(value) { console.log(JSON.stringify(value)); }",
    "const profile = { totalMs: 7, measuredMs: 5, unmeasuredMs: 2, phases: [{ name: 'mock', durationMs: 5 }] };",
    "if (args[0] === '--help') output({ ok: true, commands: ['agentshell start [--compact]'] });",
    "else if (args[0] === 'manual') output({ ok: true, name: 'AgentShell', text: 'x'.repeat(20) });",
    "else if (args.join(' ') === 'plugin validate --compact --profile') output({ ok: true, protocolVersion: 'agentshell.plugin-validate.v1', profile });",
    "else if (args.join(' ') === 'start --compact --profile') output({ ok: true, protocolVersion: 'agentshell.start.v1', profile });",
    "else { console.error(`unexpected command: ${args.join(' ')}`); process.exit(2); }",
    ""
  ].join("\n"));
  return { cwd, cli };
}
