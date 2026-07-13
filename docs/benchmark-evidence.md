# Benchmark Evidence

Snapshot date: 2026-07-07.

This page is the public-readable index for AgentShell benchmark evidence. It
keeps the raw data in `artifacts/` and the runnable logic in `scripts/`, while
summarizing the current results for three questions:

- How much terminal context does AgentShell save versus raw shell output?
- Do the local repair benchmarks still pass with rollback guidance?
- What do the current real-project eval artifacts show?

Token counts are estimates using `ceil(chars / 4)`. Durations are local wall
clock measurements and should be treated as comparative evidence for the same
machine/run shape, not a portable performance guarantee.

When a report includes a `summary` block, read command count, estimated tokens,
and speed together. Command count explains agent round trips, estimated tokens
explains context cost, and wall time or duration explains local latency. The
performance reports intentionally keep those three dimensions adjacent so a
faster path does not hide extra commands or token-heavy output.

## Raw Shell vs AgentShell

The noisy-output demo compares direct test output with compact AgentShell
verification on `examples/noisy-test-demo`.

Reproduce:

```sh
npm run benchmark
```

Current result from `npm run benchmark`:

| Mode | Chars | Estimated tokens |
| --- | ---: | ---: |
| Raw `npm test` | 14,851 | 3,713 |
| `agentshell verify test` | 848 | 212 |
| `agentshell verify test --tail 40` | 2,711 | 678 |
| `agentshell log get <logRef> --tail 40` | 4,583 | 1,146 |

Default compact verification reduces the context from 3,713 estimated tokens to
212 estimated tokens, a 94% reduction. The tail commands intentionally spend
more tokens only when the agent asks for more log detail.

## Cache Benchmark

The cache benchmark demonstrates repeated verification behavior on one noisy
failing fixture. It runs `agentshell verify test` twice: once to populate the
cache and once to prove the second command can reuse the cached result without
rerunning the underlying test process.

Reproduce:

```sh
npm run benchmark:cache
```

Current report fields to cite:

| Field | Meaning |
| --- | --- |
| `commandCount` / `summary.commands` | Two AgentShell verify commands were measured. |
| `testExecutions` | The underlying fixture test should execute once when the cache works. |
| `summary.totalEstimatedTokens` | Token footprint for both verify responses combined. |
| `speedupPercent` | AgentShell-reported verify duration improvement from run 1 to run 2. |
| `wallSpeedupPercent` | Outer process wall-clock improvement from run 1 to run 2. |

## Local Repair Benchmark Suite

The suite runs every case in `examples/benchmark-cases` in isolated temporary
workspaces and compares:

- `raw`: direct `npm test`; expected to fail because each fixture contains a
  known bug.
- `split`: `agentshell diagnose test --compact`, then
  `agentshell change suggest --apply --compact`, then `agentshell verify test`.
- `fix`: one-command `agentshell fix test --compact`.

Reproduce:

```sh
npm run benchmark:suite -- --ci
```

Current aggregate result from `npm run benchmark:suite -- --ci`:

| Path | Cases passing path expectation | Commands | Chars | Estimated tokens | Duration ms | Rollback available |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `raw` | 9/9 expected failures | 9 | 6,369 | 1,597 | 1,061 | 0/9 |
| `split` | 9/9 repairs passed | 27 | 31,196 | 7,803 | 3,282 | 9/9 |
| `fix` | 9/9 repairs passed | 9 | 9,057 | 2,268 | 2,555 | 9/9 |

The CI threshold result was `ok: true` with `maxFixTokens: 260`. Every case met
these gates: raw failure reproduced, split repair passed, fix repair passed,
rollback guidance was available for split and fix, fix used one command, and
fix stayed under the historical v0.24 token ceiling.

The current 275-token ceiling additionally carries verification operation IDs
for exact savings attribution.

For the detailed schema and per-case fields, see `docs/benchmark-suite.md`.

## Codex E2E Plugin Flow

The Codex e2e script copies `examples/noisy-test-demo` into temporary
workspaces and runs the legacy, split diagnose, and one-command fix AgentShell
flows. The report now includes `agentshell doctor` as the first command in each
flow so setup health-check cost is visible in `commands` and `totals`.

Reproduce:

```sh
npm run codex:e2e
```

Current one-command fix-path result from `npm run codex:e2e`:

| Measurement | Commands | Chars | Estimated tokens | Duration ms |
| --- | ---: | ---: | ---: | ---: |
| Full measured fix path, including `doctor`, `manual`, status, and metrics | 6 | 13,476 | 3,369 | 742 |
| `agentshell doctor` setup | 1 | 2,318 | 580 | 98 |
| Core fix flow, excluding setup and observation commands | 2 | 1,621 | 406 | 492 |
| Single raw failure output | 1 | 14,868 | 3,717 | n/a |

The full path reports setup and measurement costs, while the core fix-flow
comparison keeps `doctor`, `manual`, `run status`, and `metrics` out of the
recurring repair-loop denominator.

## Cold-Start Benchmark

The cold-start benchmark makes CLI startup and command-shape cost explicit. Its
JSON summary now includes `commandCount`, `totalCommandInvocations`,
`fastestAverageWallTimeMs`, `slowestAverageWallTimeMs`, and
`totalAverageEstimatedTokens`; the markdown report prints the command and
invocation counts above the per-command table.

Reproduce:

```sh
npm run benchmark:cold-start -- --runs 5 --report artifacts/cold-start.json --markdown artifacts/cold-start.md
```

Use this report when deciding whether a daemon, native rewrite, or command
combination would reduce real latency. If `wallTimeMs` is high while
`profile.totalMs` is low, optimize process startup, module loading, or round
trips before rewriting JavaScript hot paths.

## Current Real-Project Eval Data

The real-project runner copies each project into isolated temporary directories,
applies manifest mutations only inside those copies, runs local commands, and
records token and duration metrics. It does not download repositories or install
new dependencies by itself.

The current real-project evidence is summarized in
[real-project-evidence.md](real-project-evidence.md). The checked-in repair
fixture suite now has eighteen runnable fixtures: one healthy baseline plus
seventeen supported repair fixtures. The latest full matrix passed 18/18
runnable fixtures, with raw succeeding only on the healthy baseline, split
repairing 17/17, and fix repairing 17/17. Repeating fix-first three times
passed 51/51 repair runs with 262 estimated output tokens per repair run on
average. On a one-run average basis, fix-first reduced checked-in fixture output
from 22,112 estimated tokens for full raw/split/fix evaluation to 4,459
estimated tokens.

The latest compact diagnose speed pass keeps the current 17/17 checked-in repair
success rate. Local cached profile samples for deterministic TypeScript and
import-path diagnoses showed AgentShell-side diagnose work completing in about
16-18ms with no generic `symbol-search` phase. Treat this as evidence that the
hot path is now mostly subprocess and test-suite cost, not JavaScript diagnosis
work.

The separate healthy real-project snapshot evidence remains useful for
pass-through smoke coverage: three local real-project snapshots passed in both
full and fix-first modes, and repeated fix-first passed 9/9 runs with 194
estimated output tokens per run on average.

Reproduce the default checked-in fixture eval:

```sh
npm run eval:real-projects
```

Reproduce a prepared real-project artifact shape with explicit manifests:

```sh
node scripts/real-project-eval.js \
  --manifest artifacts/real-projects.local.fast.draft.json \
  --report artifacts/real-project-eval.local-fast-concurrency2.json \
  --artifacts-dir artifacts/real-project-eval.local-fast-concurrency2 \
  --concurrency 2

node scripts/real-project-eval.js \
  --manifest artifacts/real-projects.injected-chalk-targeted.fast.json \
  --report artifacts/real-project-eval.injected-chalk-targeted.fast.json \
  --artifacts-dir artifacts/real-project-eval.injected-chalk-targeted.fast
```

Reproduce the current full-vs-fix-first comparison:

```sh
node scripts/real-project-eval.js \
  --manifest artifacts/real-projects.local.fast.draft.json \
  --report artifacts/real-project-eval.local-fast-full-c2.json \
  --mode full \
  --concurrency 2

node scripts/real-project-eval.js \
  --manifest artifacts/real-projects.local.fast.draft.json \
  --report artifacts/real-project-eval.local-fast-fix-first-c2.json \
  --mode fix-first \
  --concurrency 2
```

The checked-in source artifacts currently contain these externally sourced local
project snapshots under `artifacts/external-repos/`:

- `sindresorhus-is` from `sindresorhus/is`
- `chalk-chalk` from `chalk/chalk`

### Historical Healthy Real-Project Smoke

Source artifact:
`artifacts/real-project-eval.local-fast-concurrency2.json`

Manifest:
`artifacts/real-projects.local.fast.draft.json`

This run keeps both projects healthy and verifies that the raw command,
diagnose/change/verify flow, and one-command fix flow all preserve passing test
state.

| Arm | Success | Tokens | Duration ms | Runs |
| --- | ---: | ---: | ---: | ---: |
| `raw` | 2/2 | 4,458 | 17,751 | 2 |
| `split` | 2/2 | 2,511 | 28,493 | 2 |
| `fix` | 2/2 | 396 | 14,495 | 2 |

Per project:

| Project | Raw tokens / ms | Split tokens / ms | Fix tokens / ms |
| --- | ---: | ---: | ---: |
| `@sindresorhus/is` | 3,329 / 10,455 | 1,030 / 15,344 | 198 / 8,102 |
| `chalk` | 1,129 / 7,296 | 1,481 / 13,149 | 198 / 6,393 |

### Historical Full vs Fix-First Real-Project Eval

Source artifacts:

- `artifacts/real-project-eval.local-fast-full-c2.json`
- `artifacts/real-project-eval.local-fast-fix-first-c2.json`

Both runs use the same prepared manifest and `--concurrency 2`. Full mode runs
raw, split, and fix arms for each project. Fix-first mode runs the cheapest
one-command `fix` arm first and skips raw/split when fix succeeds.

| Mode | Project pass count | Arms run | Tokens | Wall time ms | Arm duration ms |
| --- | ---: | --- | ---: | ---: | ---: |
| `full` | 2/2 | raw, split, fix | 7,369 | 40,266 | 72,078 |
| `fix-first` | 2/2 | fix | 396 | 9,411 | 16,505 |

On this local run, fix-first reduced estimated eval tokens by 94.6% and wall
time by 76.6% while preserving the same passing project count. This is not a
replacement for exhaustive strategy comparison; it is the fast path for
measuring whether the supported one-command repair loop can solve a project
before spending context on raw/split evidence.

### Targeted Injected Failure

Source artifact:
`artifacts/real-project-eval.injected-chalk-targeted.fast.json`

Manifest:
`artifacts/real-projects.injected-chalk-targeted.fast.json`

This run mutates only the isolated copy of `chalk` by narrowing the test command
to one AVA test and changing `strings.join(' ')` to `strings.join('')`. Raw shell
therefore records the expected failure, while both AgentShell repair arms return
the copied project to a passing state.

| Arm | Success | Tokens | Duration ms | Runs |
| --- | ---: | ---: | ---: | ---: |
| `raw` | 0/1 expected failure | 216 | 731 | 1 |
| `split` | 1/1 repair passed | 1,127 | 1,163 | 1 |
| `fix` | 1/1 repair passed | 304 | 1,011 | 1 |

Per project:

| Project | Raw tokens / ms | Split tokens / ms | Fix tokens / ms |
| --- | ---: | ---: | ---: |
| `chalk-join-literal-targeted-fast` | 216 / 731 | 1,127 / 1,163 | 304 / 1,011 |

### Raw Prepared Baseline

Source artifact:
`artifacts/real-project-eval.raw-local.prepared.json`

Manifest:
`artifacts/real-projects.raw-local.prepared.json`

This raw-only baseline copies prepared `node_modules` for both local external
repos and confirms the unmutated project snapshots pass without AgentShell
repair.

| Arm | Success | Tokens | Duration ms | Runs |
| --- | ---: | ---: | ---: | ---: |
| `raw` | 2/2 | 4,418 | 27,681 | 2 |

Per project:

| Project | Raw tokens / ms |
| --- | ---: |
| `@sindresorhus/is` | 3,308 / 15,693 |
| `chalk` | 1,110 / 11,988 |

## Evidence Files

- `docs/benchmark.md`: noisy-output demo and cache benchmark notes.
- `docs/benchmark-suite.md`: benchmark-suite contract, cases, fields, and CI
  thresholds.
- `docs/real-project-eval.md`: real-project runner behavior and manifest
  format.
- `scripts/benchmark-demo.js`: raw shell versus compact verify measurement.
- `scripts/benchmark-suite.js`: local repair benchmark suite.
- `scripts/real-project-eval.js`: real-project eval runner.
- `artifacts/real-project-eval.local-fast-concurrency2.json`: current healthy
  real-project smoke summary used above.
- `artifacts/real-project-eval.local-fast-full-c2.json` and
  `artifacts/real-project-eval.local-fast-fix-first-c2.json`: current
  full-vs-fix-first comparison used above.
- `artifacts/real-project-eval.injected-chalk-targeted.fast.json`: current
  targeted injected failure repair summary used above.
- `artifacts/real-project-eval.raw-local.prepared.json`: current raw prepared
  baseline used above.
