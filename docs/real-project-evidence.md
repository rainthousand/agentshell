# Real Project Evidence

Snapshot date: 2026-07-09.

This page summarizes the current local real-project evidence for AgentShell's
Codex plugin fast path. The goal is to measure whether
`agentshell fix test --fast --compact` can preserve passing real project test
state with much less agent-facing terminal output than raw shell logs or the
split diagnose/change/verify flow.

The batch 5 source-checkout artifacts are:

- Candidate report: `artifacts/real-project-candidates.batch5.json`
- Candidate Markdown: `artifacts/real-project-candidates.batch5.md`
- Manifest draft: `artifacts/real-projects.batch5.draft.json`
- Full comparison: `artifacts/real-project-eval.batch5.full.json`
- Fix-first comparison: `artifacts/real-project-eval.batch5.fix-first.json`

The batch 7 source-checkout repeated-run artifact is:

- Fix-first repeated stability:
  `artifacts/real-project-eval.batch7.fix-first-runs3.json`

The checked-in fixture refresh artifacts are:

- Full checked-in fixture comparison:
  `artifacts/real-project-eval.strategy-coverage-full.json`
- Fix-first checked-in fixture repeated stability:
  `artifacts/real-project-eval.strategy-coverage.fix-first-runs3.json`

The core-product evidence gate refresh artifacts are:

- Candidate report:
  `artifacts/real-project-candidates.batch-core.json`
- Candidate Markdown:
  `artifacts/real-project-candidates.batch-core.md`
- Manifest draft:
  `artifacts/real-projects.batch-core.draft.json`
- Fix-first repeated checked-in fixture run:
  `artifacts/real-project-eval.batch-core.fix-first-runs2.json`
- Codex plugin effect trial:
  `artifacts/codex-plugin-trial.batch1.json`
- Strategy intake sample report:
  `artifacts/strategy-intake.batch3.json`

Token counts are estimated with the project-wide `ceil(chars / 4)` convention.
Durations are local command-duration sums from this machine and should be used
only for same-run comparative evidence.

The JSON artifacts live under `artifacts/` in the source checkout. They are not
bundled into the Codex plugin cache because generated evaluation outputs are
excluded from plugin installs; this Markdown page carries the portable summary.

## Scope

The current checked-in repair fixture suite contains eighteen runnable fixtures:

| Fixture group | Count | Purpose |
| --- | ---: | --- |
| Healthy baseline | 1 | Raw-only pass-through baseline |
| Repair fixtures | 17 | Supported conservative repairs across JavaScript and TypeScript failures |

The seventeen repair fixtures cover missing object property, import-path typo,
TypeScript missing property, TypeScript property suggestion, TypeScript
primitive literal mismatch, TypeScript literal mismatch, literal replacement,
deepEqual missing property, deepEqual extra property removal, deepEqual array
element addition, deepEqual array primitive replacement, deepEqual array
tail-element removal, array length shortfall, join separator literal, string
case transform, truthy return, and missing named export.

## Checked-In Repair Fixture Result

The latest checked-in fixture full run passed all runnable projects:

| Mode | Projects pass | Raw success | Split success | Fix success | Tokens | Arm duration ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `full` | 18/18 | 1/18 | 17/17 | 17/17 | 22,112 | 16,962 |
| `fix-first`, averaged from 3 runs | 18/18 | 1/1 | skipped | 51/51 runs | 4,459 | 6,287 |

Compared with running all full arms once, the one-run average `fix-first`
repair path reduced estimated output tokens from 22,112 to 4,459, a 79.8%
reduction, and reduced summed arm duration from 16,962 ms to 6,287 ms, a 62.5%
reduction. The per-repair average across the 51 repeated fix runs was 262.3
estimated output tokens and 369.8 ms.

The full run remains valuable for strategy comparison. The fix-first repeated
run is the better default evidence for the plugin's fast path because it spends
context only on the path an agent should try first.

The latest core-product gate refresh also passed the checked-in fix-first
matrix: 18 of 18 runnable projects passed, with 34 of 34 repeated fix runs
succeeding across 17 repair fixtures. That run used 8,918 estimated fix-arm
output tokens and 11,790 ms of summed fix-arm duration. The candidate importer
refresh classified 18 of 18 checked-in fixture repositories as local runnable
drafts with an average candidate score of 95.

The Codex plugin effect trial keeps the raw baseline and plugin-guided path in
one report: the raw baseline is intentionally weak, while
`codex-plugin-agentshell` is strong with 636 estimated output tokens and
1,110 ms duration in the synthetic trial.

## Healthy Real-Project Smoke Scope

Batch 5 uses three local, runnable project snapshots:

| Project | Source | Test command | Candidate score |
| --- | --- | --- | ---: |
| `agentshell` | local checkout | `npm test` | 100 |
| `chalk` | `artifacts/external-repos/chalk-chalk` | `npm test` | 100 |
| `@sindresorhus/is` | `artifacts/external-repos/sindresorhus-is` | `npm test` | 100 |

The two external snapshots reuse prepared local `node_modules` through
`setupLinks`, so this evidence does not measure clean dependency installation.
The `agentshell` self-eval runs `npm install --offline` in each isolated copy;
that setup cost is included in the arm metrics.

## Overall Result

Both modes passed all runnable projects.

| Mode | Projects pass | Arms run | Tokens | Arm duration ms | Skipped arms |
| --- | ---: | --- | ---: | ---: | ---: |
| `full` | 3/3 | raw, split, fix | 15,789 | 329,168 | 0 |
| `fix-first` | 3/3 | fix only | 581 | 60,496 | 6 |

Compared with running all full arms, `fix-first` reduced estimated output tokens
by 96.3% and arm-duration sum by 81.6% while preserving the same pass count.

## Arm Comparison

The full run compares the three paths on the same manifest:

| Arm | Success | Tokens | Duration ms | Runs |
| --- | ---: | ---: | ---: | ---: |
| `raw` | 3/3 | 10,543 | 104,084 | 3 |
| `split` | 3/3 | 4,665 | 142,629 | 3 |
| `fix` | 3/3 | 581 | 82,455 | 3 |

In full mode, `fix` used 94.5% fewer estimated tokens than `raw` and 87.5%
fewer estimated tokens than `split`. It was also 20.8% lower duration than
`raw` and 42.2% lower duration than `split` in this run.

`split` still reduces output versus raw logs, but it runs multiple commands and
is not the best default path for healthy project pass-through checks.

## Project Details

| Project | Raw tokens / ms | Split tokens / ms | Fix tokens / ms |
| --- | ---: | ---: | ---: |
| `agentshell` | 6,085 / 66,965 | 2,145 / 101,925 | 185 / 66,820 |
| `chalk` | 1,129 / 16,424 | 1,489 / 19,211 | 198 / 7,686 |
| `@sindresorhus/is` | 3,329 / 20,695 | 1,031 / 21,493 | 198 / 7,949 |

The AgentShell self-eval is the heaviest project in this batch because it runs
the full local test suite. Even there, the compact fix path preserved success
with 185 estimated output tokens versus 6,085 for raw test output.

## Fix-First Behavior

`fix-first` runs the `fix` arm before raw or split. If `fix` succeeds, the
runner skips raw and split for that project with reason `fix-succeeded`.

In batch 5:

| Skipped arm | Count |
| --- | ---: |
| `raw` | 3 |
| `split` | 3 |
| `fix` | 0 |

This is the right default for fast plugin evidence: it measures whether the
lowest-context AgentShell path can solve or preserve the project before spending
tokens on raw/split baselines.

## Fix-First Repeated Stability

Batch 7 repeats the fix-first path three times for each of the same three
projects.

| Project | Success runs | Avg tokens / run | Avg duration ms / run | Run durations ms |
| --- | ---: | ---: | ---: | --- |
| `agentshell` | 3/3 | 185 | 82,563 | 50,547, 157,740, 39,401 |
| `chalk` | 3/3 | 198 | 6,660 | 8,456, 5,854, 5,670 |
| `@sindresorhus/is` | 3/3 | 198 | 9,123 | 11,082, 8,211, 8,075 |

Across all nine repeated fix-first runs, success was 9/9 and average estimated
output was 194 tokens per run. Token output was effectively stable across runs;
duration was much noisier because it is dominated by the target project's test
suite and local machine load.

## Caveats

- These are healthy project smoke runs. They prove low-cost pass-through on real
  project layouts, not real bug repair success.
- The checked-in benchmark fixtures and targeted injected-failure artifacts
  remain the current repair-success evidence.
- `split:change-suggest` may exit non-zero with `NO_CHANGE_SUGGESTION` on
  already-passing projects; the split arm is still successful when final
  verification passes.
- Token counts are output-length estimates, not exact model tokenizer counts.
- Durations are local command-duration sums, not portable performance promises.
- Batch 5 full-vs-fix-first comparison uses `runs: 1`, so filesystem cache and
  machine load can affect full-arm timing. Batch 7 repeats only the fix-first
  path with `runs: 3`.
- `safety` and `generalization` are deterministic first-pass buckets derived
  from local arm results, not human review. `checked` means AgentShell repair
  arms succeeded through the controlled edit/verify loop; `covered` means the
  expected repair class succeeded. Future external evaluations should still add
  human or agent-scored safety and generalization review.

## Product Implication

The data supports keeping the Codex plugin's recommended path focused on:

```sh
agentshell start --compact
agentshell fix test --fast --compact
```

The split diagnose/change/verify flow remains useful when the one-command path
cannot produce a safe suggestion or when the agent needs more inspection detail.
