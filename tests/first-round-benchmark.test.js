import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = path.resolve("scripts/first-round-benchmark.js");

test("first-round benchmark compares split startup with compact start using a mock CLI", () => {
  const fixture = createMockCliFixture({ advertiseCompactStart: true });
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
  assert.equal(output.protocolVersion, "agentshell.first-round-benchmark.v1");
  assert.equal(output.runs, 2);
  assert.equal(output.startCapability.compact, true);
  assert.equal(output.startCapability.command, "node src/cli.js start --compact");

  assert.equal(output.flows.old.commandCount, 3);
  assert.equal(output.flows.new.commandCount, 1);
  assert.deepEqual(output.flows.old.commands, [
    "node src/cli.js doctor",
    "node src/cli.js understand --compact",
    "node src/cli.js run next"
  ]);
  assert.deepEqual(output.flows.new.commands, [
    "node src/cli.js start --compact"
  ]);

  assert.equal(output.flows.old.runs.length, 2);
  assert.equal(output.flows.new.runs.length, 2);
  assert.equal(output.flows.old.summary.commandCount, 3);
  assert.equal(output.flows.new.summary.commandCount, 1);
  assert.equal(output.flows.old.summary.stdoutChars, 141);
  assert.equal(output.flows.new.summary.stdoutChars, 41);
  assert.equal(output.flows.old.summary.estimatedTokens, Math.ceil(141 / 4));
  assert.equal(output.flows.new.summary.estimatedTokens, Math.ceil(41 / 4));
  assert.equal(output.reduction.commandCount.saved, 2);
  assert.equal(output.reduction.stdoutChars.saved, 100);
  assert.equal(output.reduction.estimatedTokens.saved, 25);
  assert.ok(output.reduction.stdoutChars.percent > 0);
});

test("first-round benchmark falls back to plain start when compact start is not advertised", () => {
  const fixture = createMockCliFixture({ advertiseCompactStart: false });
  const result = spawnSync("node", [
    script,
    "--cli",
    fixture.cli,
    "--cwd",
    fixture.cwd,
    "--runs=1",
    "--json"
  ], {
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);

  assert.equal(output.startCapability.compact, false);
  assert.equal(output.startCapability.command, "node src/cli.js start");
  assert.deepEqual(output.flows.new.commands, ["node src/cli.js start"]);
  assert.equal(output.flows.new.summary.stdoutChars, 50);
});

test("first-round benchmark can render markdown", () => {
  const fixture = createMockCliFixture({ advertiseCompactStart: true });
  const result = spawnSync("node", [
    script,
    "--cli",
    fixture.cli,
    "--cwd",
    fixture.cwd,
    "--runs",
    "1",
    "--markdown"
  ], {
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^# AgentShell First-Round Benchmark/);
  assert.match(result.stdout, /\| Flow \| Commands \| Wall time \| Stdout chars \| Estimated tokens \|/);
  assert.match(result.stdout, /\| old \| 3 \| \d+ms \| 141 \| 36 \|/);
  assert.match(result.stdout, /\| new \| 1 \| \d+ms \| 41 \| 11 \|/);
  assert.match(result.stdout, /## Reduction/);
});

test("first-round benchmark writes JSON and Markdown artifact reports", () => {
  const fixture = createMockCliFixture({ advertiseCompactStart: true });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-first-round-benchmark-report-"));
  const jsonReport = path.join(tempDir, "nested", "reports", "first-round.json");
  const markdownReport = path.join(tempDir, "nested", "reports", "first-round.md");
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
  assert.equal(stdoutReport.runs, 1);
  assert.equal(stdoutReport.startCapability.compact, true);
  assert.match(markdown, /^# AgentShell First-Round Benchmark/);
  assert.match(markdown, /\| old \| 3 \| \d+ms \| 141 \| 36 \|/);
  assert.match(markdown, /\| new \| 1 \| \d+ms \| 41 \| 11 \|/);
});

function createMockCliFixture({ advertiseCompactStart }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-first-round-benchmark-"));
  const cli = path.join(cwd, "mock-cli.js");
  fs.writeFileSync(cli, [
    "const args = process.argv.slice(2);",
    "const compact = args.includes('--compact');",
    "function write(chars) { process.stdout.write('x'.repeat(chars)); }",
    "if (args[0] === '--help') {",
    "  console.log(JSON.stringify({ ok: true, commands: [",
    advertiseCompactStart
      ? "    'agentshell start [--compact]',"
      : "    'agentshell start',",
    "    'agentshell doctor',",
    "    'agentshell understand [--compact]',",
    "    'agentshell run next'",
    "  ] }));",
    "  process.exit(0);",
    "}",
    "const key = args.join(' ');",
    "if (key === 'doctor') write(48);",
    "else if (key === 'understand --compact') write(64);",
    "else if (key === 'run next') write(29);",
    "else if (key === 'start --compact' && compact) write(41);",
    "else if (key === 'start') write(50);",
    "else { console.error(`unexpected command: ${key}`); process.exit(2); }",
    ""
  ].join("\n"));
  return { cwd, cli };
}
