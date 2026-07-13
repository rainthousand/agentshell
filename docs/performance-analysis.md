# AgentShell Performance Analysis

AgentShell should optimize from measurements, not language folklore. The current
working hypothesis is that JavaScript is not the primary speed bottleneck for
most AgentShell CLI flows. The larger costs are usually process startup,
subprocess execution, filesystem IO, command round trips, and JSON output size.

## Measurement Tools

Use command-local profiling when you need to understand where an already-started
CLI process spends time:

```bash
agentshell start --compact --profile
agentshell plugin validate --compact --profile
agentshell diagnose test --compact --profile
```

The optional `profile` object reports:

- `totalMs`: elapsed time inside the already-started Node.js process.
- `measuredMs`: sum of named measured phases.
- `unmeasuredMs`: time not captured by named phases.
- `subprocessMs`: available when a command measures a child test process.
- `phases`: named phase timings such as `doctor`, `plugin-status`, or `verify-test`.

Use cold-start benchmarking when you need to measure the full command wall time,
including Node.js startup and module loading:

```bash
npm run benchmark:cold-start
npm run benchmark:cold-start -- --runs 5 --report artifacts/cold-start.json --markdown artifacts/cold-start.md
```

The cold-start report uses `agentshell.cold-start-benchmark.v1` and is exposed
through:

```bash
agentshell schema get cold-start-benchmark
```

Use cache benchmarking when you need to show repeated-command savings from the
verification cache:

```bash
npm run benchmark:cache
```

The cache report records two `agentshell verify test` commands against the same
fixture. The first run should execute the test command and miss the cache; the
second run should reuse the cached result. Read `summary.commands`,
`summary.totalEstimatedTokens`, `summary.speedupPercent`,
`summary.wallSpeedupPercent`, and `testExecutions` together: they show command
count, token footprint, AgentShell-reported speedup, outer wall-clock speedup,
and whether the underlying test command actually ran once.

## How To Interpret Results

Compare external `wallTimeMs` with internal `profile.totalMs`.

- Use `summary.commandCount` and `summary.totalCommandInvocations` to keep
  command round trips explicit. In cold-start reports, `commandCount` is the
  number of distinct CLI shapes and `totalCommandInvocations` is
  `commandCount * runs`.
- Use `summary.totalAverageEstimatedTokens` as the average token footprint for
  one full cold-start pass across all measured commands.
- If `wallTimeMs` is much larger than `profile.totalMs`, the likely bottleneck is
  process startup, module loading, stdout capture, or shell round trips.
- If `profile.subprocessMs` dominates `profile.totalMs`, the likely bottleneck is
  the underlying test or tool command, not AgentShell JavaScript.
- If named JS/IO phases dominate `profile.totalMs`, optimize that command first:
  cache data, reduce scans, narrow file reads, or replace the hot path later.
- If stdout chars and estimated tokens dominate the cost model, prefer compact
  responses, refs, log tails, and schema-driven consumers.

## Current Product Guidance

Keep the main implementation in JavaScript while the measured hot paths are
mostly orchestration, subprocess management, small JSON transforms, and local
file reads. JavaScript keeps iteration fast and keeps the Codex plugin/NPM path
simple.

Consider a Rust, Go, native addon, or daemon backend only after profile evidence
shows one of these conditions:

- repeated cold-start overhead is a material part of user-visible latency;
- a specific JS/IO phase dominates command runtime on real repositories;
- repository indexing, AST parsing, or file watching becomes a high-frequency
  workload;
- multiple agents need a shared long-lived cache or concurrent state service.

Until then, the highest-leverage optimizations remain:

- combine multi-step agent workflows into one command;
- reduce output size and token cost;
- cache repeated verification and workspace metadata;
- run independent checks concurrently where safe;
- measure cold start before committing to a daemon.

## Current Local Baseline

On the current local checkout, a three-run cold-start sample was written to:

- `artifacts/cold-start.performance-batch.json`
- `artifacts/cold-start.performance-batch.md`

Observed averages from that sample:

| Command | Avg wall time | Avg profile total | Avg process overhead | Avg tokens |
| --- | ---: | ---: | ---: | ---: |
| `node src/cli.js --help` | 55ms | n/a | n/a | 340 |
| `node src/cli.js manual` | 40ms | n/a | n/a | 2,198 |
| `node src/cli.js plugin validate --compact --profile` | 40ms | 2ms | 38ms | 402 |
| `node src/cli.js start --compact --profile` | 105ms | 55ms | 50ms | 356 |

That sample covered 4 distinct command shapes and 12 total command invocations
across 3 runs. The average token footprint for one full cold-start pass was
3,296 estimated tokens.

A failing-test diagnosis sample on `examples/failing-test-demo` reported:

| Phase | Duration |
| --- | ---: |
| Total in-process diagnosis | 314ms |
| Test subprocess inside verification | 278ms |
| Symbol search | 22ms |
| Fix-plan construction | 2ms |

This baseline supports the current hypothesis: for these paths, JavaScript
computation is not the obvious bottleneck. The heavier costs are process
startup, test subprocess time, and command/output shape.

After the compact diagnose speed pass, deterministic TypeScript and import-path
failures skip the generic focused-read and symbol-search phases when a clear
target can be derived from verification output. Cached local profile samples on
the checked-in fixtures measured about 16-18ms total in-process diagnosis time,
with phases limited to `verify-test`, `deterministic-fix-plan`,
`change-template`, and `run-state`.

The one-run checked-in fixture eval with eighteen runnable fixtures kept 17/17
fix success. Estimated one-run fix-first repair output was 4,459 tokens versus
22,112 tokens for the full raw/split/fix matrix. The repeated fix-first run
passed 51/51 repair runs with an average of 262.3 estimated output tokens and
369.8 ms per repair run.
