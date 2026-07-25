#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PROTOCOL_VERSION = "agentshell.noise-matrix-benchmark.v1";
const projectRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(projectRoot, "src", "cli.js");
const options = parseOptions(process.argv.slice(2));
const scenarios = [
  {
    id: "quiet-assertion",
    description: "Low-noise control with only the assertion failure",
    stdoutLines: 0,
    stderrLines: 0,
    payloadSize: 0
  },
  {
    id: "stdout-progress",
    description: "Repeated progress and setup lines on stdout",
    stdoutLines: 300,
    stderrLines: 0,
    payloadSize: 0
  },
  {
    id: "stderr-warnings",
    description: "Repeated warning lines on stderr",
    stdoutLines: 0,
    stderrLines: 220,
    payloadSize: 0
  },
  {
    id: "mixed-runner",
    description: "Passing-test chatter on stdout mixed with warnings on stderr",
    stdoutLines: 180,
    stderrLines: 120,
    payloadSize: 0
  },
  {
    id: "repeated-stack",
    description: "Repeated stack-like diagnostic frames before the real failure",
    stdoutLines: 20,
    stderrLines: 180,
    payloadSize: 0,
    stackLike: true
  },
  {
    id: "large-snapshot",
    description: "Large expected/actual snapshot-style payload",
    stdoutLines: 20,
    stderrLines: 0,
    payloadSize: 240
  }
];

const rows = scenarios.map((scenario) => benchmarkScenario(scenario, options.runs));
const noisyRows = rows.filter((row) => row.id !== "quiet-assertion");
const report = {
  ok: rows.every((row) => row.valid),
  protocolVersion: PROTOCOL_VERSION,
  generatedAt: new Date().toISOString(),
  methodology: {
    runsPerScenario: options.runs,
    statistic: "median",
    tokenEstimate: "ceil(outputChars / 4)",
    workloadDelayMs: 40,
    paths: {
      raw: "npm test wall time and complete stdout/stderr",
      cold: "AgentShell CLI wall time with an empty per-run cache",
      warm: "AgentShell CLI wall time immediately after cold verification"
    },
    interpretation: [
      "Token savings compare raw output with cold AgentShell JSON.",
      "Cold speed reports AgentShell orchestration overhead, not a speedup promise.",
      "Warm speed measures fingerprint-cache reuse for an unchanged failing test.",
      "Synthetic fixtures validate mechanisms; they do not predict every real project."
    ]
  },
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version
  },
  summary: summarize(rows, noisyRows),
  cases: rows
};

const json = `${JSON.stringify(report, null, 2)}\n`;
if (options.report) writeFile(options.report, json);
if (options.markdown) writeFile(options.markdown, renderMarkdown(report));
process.stdout.write(json);
process.exitCode = report.ok ? 0 : 1;

function benchmarkScenario(scenario, runs) {
  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    const fixture = createFixture(scenario, index);
    const raw = runRaw(fixture);
    const cold = runAgentShell(fixture);
    const warm = runAgentShell(fixture);
    samples.push({ raw, cold, warm });
  }

  const raw = aggregatePath(samples.map((sample) => sample.raw));
  const cold = aggregatePath(samples.map((sample) => sample.cold));
  const warm = aggregatePath(samples.map((sample) => sample.warm));
  const tokensSaved = raw.estimatedTokens - cold.estimatedTokens;
  const coldDeltaMs = raw.wallDurationMs - cold.wallDurationMs;
  const warmDeltaMs = raw.wallDurationMs - warm.wallDurationMs;

  return {
    id: scenario.id,
    description: scenario.description,
    noise: {
      stdoutLines: scenario.stdoutLines,
      stderrLines: scenario.stderrLines,
      payloadLines: scenario.payloadSize
    },
    valid: samples.every((sample) => (
      sample.raw.status === 1
      && sample.cold.status === 1
      && sample.warm.status === 1
      && sample.cold.cacheHit === false
      && sample.warm.cacheHit === true
    )),
    raw,
    agentshellCold: cold,
    agentshellWarm: warm,
    tokenSavings: {
      estimatedTokens: tokensSaved,
      percent: percent(tokensSaved, raw.estimatedTokens)
    },
    coldSpeed: {
      deltaMs: coldDeltaMs,
      percent: percent(coldDeltaMs, raw.wallDurationMs)
    },
    warmSpeed: {
      deltaMs: warmDeltaMs,
      percent: percent(warmDeltaMs, raw.wallDurationMs)
    }
  };
}

function createFixture(scenario, runIndex) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), `agentshell-noise-${scenario.id}-${runIndex}-`));
  fs.mkdirSync(path.join(fixture, "test"));
  fs.writeFileSync(path.join(fixture, "package.json"), `${JSON.stringify({
    name: `noise-${scenario.id}`,
    private: true,
    type: "module",
    scripts: {
      test: "node test/noisy.test.js"
    }
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(fixture, "test", "noisy.test.js"), fixtureSource(scenario));
  return fixture;
}

function fixtureSource(scenario) {
  const lines = [
    "import assert from 'node:assert/strict';",
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);"
  ];

  if (scenario.stdoutLines > 0) {
    lines.push(`for (let i = 1; i <= ${scenario.stdoutLines}; i += 1) console.log(\`progress \${i}: completed fixture step \${i}\`);`);
  }
  if (scenario.stderrLines > 0 && !scenario.stackLike) {
    lines.push(`for (let i = 1; i <= ${scenario.stderrLines}; i += 1) console.error(\`warning \${i}: optional dependency emitted diagnostic detail\`);`);
  }
  if (scenario.stackLike) {
    lines.push(`for (let i = 1; i <= ${scenario.stderrLines}; i += 1) console.error(\`    at helper\${i} (file:///workspace/src/helper.js:\${i}:1)\`);`);
  }
  if (scenario.payloadSize > 0) {
    lines.push("console.error('Snapshot difference:');");
    lines.push(`for (let i = 1; i <= ${scenario.payloadSize}; i += 1) console.error(\`- expected-row-\${i}: value-\${i}\\n+ actual-row-\${i}: changed-\${i}\`);`);
  }

  lines.push("assert.equal('actual', 'expected', 'Expected benchmark value to match');");
  lines.push("");
  return lines.join("\n");
}

function runRaw(cwd) {
  return run("npm", ["test"], cwd, false);
}

function runAgentShell(cwd) {
  return run("node", [cli, "verify", "test"], cwd, true);
}

function run(command, args, cwd, parseAgentShell) {
  const started = process.hrtime.bigint();
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  const wallDurationMs = Number(process.hrtime.bigint() - started) / 1e6;
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  let parsed = null;
  if (parseAgentShell) {
    try {
      parsed = JSON.parse(result.stdout);
    } catch {}
  }
  return {
    status: result.status,
    wallDurationMs,
    chars: output.length,
    estimatedTokens: estimateTokens(output.length),
    cacheHit: parsed?.cacheHit ?? null
  };
}

function aggregatePath(samples) {
  return {
    wallDurationMs: roundOne(median(samples.map((sample) => sample.wallDurationMs))),
    chars: Math.round(median(samples.map((sample) => sample.chars))),
    estimatedTokens: Math.round(median(samples.map((sample) => sample.estimatedTokens))),
    cacheHit: samples[0].cacheHit
  };
}

function summarize(rows, noisyRows) {
  const all = aggregateCases(rows);
  const noisy = aggregateCases(noisyRows);
  return {
    scenarios: rows.length,
    noisyScenarios: noisyRows.length,
    validScenarios: rows.filter((row) => row.valid).length,
    all,
    noisyOnly: noisy
  };
}

function aggregateCases(rows) {
  const rawTokens = sum(rows.map((row) => row.raw.estimatedTokens));
  const coldTokens = sum(rows.map((row) => row.agentshellCold.estimatedTokens));
  const rawMs = sum(rows.map((row) => row.raw.wallDurationMs));
  const coldMs = sum(rows.map((row) => row.agentshellCold.wallDurationMs));
  const warmMs = sum(rows.map((row) => row.agentshellWarm.wallDurationMs));
  return {
    rawEstimatedTokens: rawTokens,
    agentshellEstimatedTokens: coldTokens,
    estimatedTokensSaved: rawTokens - coldTokens,
    tokenSavingsPercent: percent(rawTokens - coldTokens, rawTokens),
    rawMedianWallMsTotal: roundOne(rawMs),
    coldMedianWallMsTotal: roundOne(coldMs),
    coldSpeedPercent: percent(rawMs - coldMs, rawMs),
    warmMedianWallMsTotal: roundOne(warmMs),
    warmSpeedPercent: percent(rawMs - warmMs, rawMs)
  };
}

function renderMarkdown(report) {
  const lines = [
    "# AgentShell Noise Matrix Benchmark",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Runs per scenario: ${report.methodology.runsPerScenario}; reported statistic: ${report.methodology.statistic}.`,
    "",
    "| Scenario | Raw tokens | AgentShell tokens | Token saved | Raw ms | Cold ms | Cold speed | Warm ms | Warm speed |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|"
  ];
  for (const row of report.cases) {
    lines.push([
      `| ${row.id}`,
      row.raw.estimatedTokens,
      row.agentshellCold.estimatedTokens,
      `${row.tokenSavings.percent}%`,
      row.raw.wallDurationMs,
      row.agentshellCold.wallDurationMs,
      `${row.coldSpeed.percent}%`,
      row.agentshellWarm.wallDurationMs,
      `${row.warmSpeed.percent}% |`
    ].join(" | "));
  }
  lines.push(
    "",
    "## Aggregate",
    "",
    `- Noisy-only token savings: ${report.summary.noisyOnly.estimatedTokensSaved} estimated tokens (${report.summary.noisyOnly.tokenSavingsPercent}%).`,
    `- All-case token savings including quiet control: ${report.summary.all.estimatedTokensSaved} estimated tokens (${report.summary.all.tokenSavingsPercent}%).`,
    `- Cold AgentShell speed vs raw: ${report.summary.all.coldSpeedPercent}% (negative means overhead).`,
    `- Warm AgentShell speed vs raw: ${report.summary.all.warmSpeedPercent}% (fingerprint cache, unchanged failure).`,
    "",
    "## Interpretation",
    "",
    ...report.methodology.interpretation.map((item) => `- ${item}`),
    ""
  );
  return lines.join("\n");
}

function parseOptions(args) {
  const parsed = { runs: 5, report: null, markdown: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--runs") parsed.runs = positiveInteger(args[++index], "--runs");
    else if (arg === "--report") parsed.report = requiredValue(args[++index], "--report");
    else if (arg === "--markdown") parsed.markdown = requiredValue(args[++index], "--markdown");
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: node scripts/noise-matrix-benchmark.js [--runs N] [--report report.json] [--markdown report.md]\n");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function requiredValue(value, flag) {
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new Error(`${flag} must be an integer from 1 to 50`);
  }
  return parsed;
}

function writeFile(file, content) {
  const output = path.resolve(file);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, content);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}

function percent(delta, baseline) {
  return baseline > 0 ? roundOne((delta / baseline) * 100) : null;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function roundOne(value) {
  return Math.round(value * 10) / 10;
}
