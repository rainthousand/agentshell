# AgentShell Benchmark

This benchmark compares raw test output with compact AgentShell verification output.

## Current Demo

Run from `examples/noisy-test-demo`:

```bash
npm test
node ../../src/cli.js verify test
node ../../src/cli.js verify test --tail 40
node ../../src/cli.js benchmark test
```

Expected result:

- Raw `npm test` emits hundreds of noise lines.
- Compact `agentshell verify test` returns summary, `relatedFiles`, `logRef`, and next actions.
- Compact `agentshell diagnose test --compact` keeps diagnosis refs lean too: read entries carry file, hash, range, matched line, and line count instead of inline content, and verbose symbol lists are omitted.
- `agentshell verify test --tail N` or `agentshell log get <logRef> --tail N` fetches logs only when needed.
- Repeated identical failures can return `cacheHit: true` with the same `cacheKey` when `package.json`, the test command, lockfile, related files, and one-hop local imports are unchanged.
- When a previous failure or active diagnosis identifies a single related test file and the test script supports file selection, AgentShell first runs a smaller related-test-file command. If that smaller command fails, verification returns that focused failure immediately; if it passes, AgentShell still runs the full test command for compatibility and final confidence.

## Measurement

Use character count as a rough token proxy:

```bash
node scripts/benchmark-demo.js
```

Approximate tokens are estimated as `ceil(chars / 4)`.

## Cache Benchmark

Measure the speed and output-size impact of repeated `agentshell verify test` calls:

```bash
npm run benchmark:cache
```

The cache benchmark is offline and dependency-free. It creates a temporary failing package, runs
`agentshell verify test` twice, and prints JSON with:

- `firstRun` and `secondRun` `cacheHit`, `durationMs`, `chars`, and `estimatedTokens`.
- `durationDelta` and `speedupPercent` from the cached second run.
- `charsDelta` and `estimatedTokenDelta` for the JSON output difference.
- `testExecutions`, which should remain `1` when the second run is served from cache.

AgentShell also records recent command-output cost:

```bash
agentshell metrics --compact
```

## Cold-Start Benchmark

Measure full CLI wall time, including Node.js startup, module loading, command
execution, JSON serialization, and stdout capture:

```bash
npm run benchmark:cold-start
npm run benchmark:cold-start -- --runs 5 --report artifacts/cold-start.json --markdown artifacts/cold-start.md
```

The report uses `agentshell.cold-start-benchmark.v1` and compares `--help`,
`manual`, `plugin validate --compact --profile`, and `start --compact --profile`.
For profiled commands, compare external `wallTimeMs` with internal
`profile.totalMs` to separate process startup/round-trip overhead from
AgentShell work inside the already-started Node.js process.

For the current interpretation model, see [performance-analysis.md](performance-analysis.md).

## Latest Result

Measured on `examples/noisy-test-demo`:

| Mode | Chars | Estimated Tokens |
|---|---:|---:|
| Raw `npm test` | 14,851 | 3,713 |
| `agentshell verify test` | 703 | 176 |
| `agentshell verify test --tail 40` | 2,566 | 642 |
| `agentshell log get <logRef> --tail 40` | 4,541 | 1,136 |

Compact verify reduced default test-output context by about **95%** versus raw `npm test` on this noisy demo.

`agentshell metrics --compact` reports the cost of the recent AgentShell session. If the session includes extra
log fetches such as `verify --tail` or `log get`, the session-level savings will be lower than the
compact-only benchmark because those commands intentionally request more context.
