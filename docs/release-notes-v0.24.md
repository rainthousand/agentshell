# AgentShell v0.24 Release Notes

v0.24 focuses on compact, structured repair loops for Codex-style coding agents. The release keeps the CLI local and conservative: diagnose failing tests, suggest supported edits, apply hash-checked changes, verify, and report rollback guidance with minimal terminal output.

## Feature Summary

- `agentshell start --compact` is the recommended first command in a Codex plugin thread. Use plain `agentshell start` or `agentshell doctor` when full embedded readiness details are needed before the `fix`/`diagnose`/`verify` repair loop.
- `agentshell manual` is now a compact command router by default. Use `agentshell manual --topic repair|plugin|benchmark|profile|onboarding|log-triage|reference` for focused workflows and `agentshell manual --full` for the complete command map.
- `npm run product:readiness` provides a lightweight external-trial gate for product entry points, schema/manual contracts, adapter trial docs, plugin validation scripts, and deferred MCP boundaries.
- `agentshell fix test --fast --compact` is the explicit fast path for supported failing-test repairs; `agentshell fix test --compact` remains the compatible default.
- `agentshell fix test --safe --compact` previews the same conservative repair path without changing source files.
- `agentshell diagnose test --compact` returns compact failure summaries, related files, a structured `fixPlan`, and a fillable change template.
- Deterministic TypeScript and import-path diagnostics now skip generic reads and symbol search when verification output already identifies a clear fix target.
- `agentshell change suggest --dry-run --compact` previews generated edits without writing files.
- `agentshell change suggest --apply --compact` applies supported suggestions through the safe change path.
- `agentshell run next`, `agentshell run status --compact`, and `agentshell metrics --compact` expose task state, next actions, output cost, and rollback hints.
- Related-test-file verification can run focused `node --test`, `vitest`, `jest`, and `mocha` test-file commands before falling back to the full test command.
- `agentshell benchmark test`, `npm run benchmark`, `npm run benchmark:suite`, and `npm run codex:e2e` provide repeatable local measurements.
- `npm run benchmark:suite:ci` turns the benchmark suite into a local quality gate with fix-token, rollback, and pass/fail thresholds.
- `node scripts/benchmark-suite.js --ci --report <path> --markdown <path>` writes CI artifact reports.
- JSON schemas are available through `agentshell schema list` and `agentshell schema get <name>` for stable integrations.
- The protocol compatibility policy now defines additive changes, breaking
  changes, `protocolVersion` bumps, JSON Schema deprecation markers, adapter
  compatibility, and the future MCP compatibility boundary.
- Adapter templates can be generated for Claude Code, Cursor/Windsurf, and generic `AGENTS.md` workflows.
- Codex plugin packaging includes local validation, install, cache refresh, and installed-plugin smoke checks.
- The checked-in real-project evaluation manifest now bundles
  `deep-equal-array-elements`, `deep-equal-array-removal`, `array-length`, and `string-case-transform`
  failing-test fixtures alongside the existing conservative repair fixtures.

## Current Benchmark Evidence

Numbers below are local measurements from the current v0.24 tree. Estimated tokens use `ceil(chars / 4)`.

Measured by `npm run benchmark` on `examples/noisy-test-demo`:

| Path | Output Chars | Estimated Tokens | Result |
|---|---:|---:|---|
| Raw `npm test` | 14,851 | 3,713 | failing test output |
| `agentshell verify test` | 703 | 176 | compact failure summary |

This is about a 95% compact verification context reduction versus raw test output.

Measured by `npm run codex:e2e` on the same noisy demo:

| Path | Commands | Output Chars | Estimated Tokens | Result |
|---|---:|---:|---:|---|
| `agentshell doctor` setup | 1 | 2,318 | about 580 | healthy with warning |
| `agentshell fix test --compact` core flow | 2 | 1,621 | about 406 | passing |
| Single raw failure output | 1 | 14,868 | about 3,717 | failing |

The compact fix core flow produced about 89% less output than one raw failure log. The fix command output alone was 1,008 chars, about 252 estimated tokens. The full Codex e2e report now counts `agentshell doctor` in command totals while excluding it from the recurring core fix-flow comparison.

Additional current `npm run codex:e2e` measurements:

- Fix command reduction versus split diagnose flow: 50%.
- Fix token reduction versus split diagnose flow: 64%.
- Fix elapsed time is lower than the split diagnose flow in current local runs, but wall-clock percentage varies by machine load.
- `run next` output: 232 chars, about 58 tokens.
- `run status --compact` output: 813 chars, about 204 tokens.
- `metrics --compact` output: 1,695 chars, about 424 tokens, a 47% reduction versus the prior full metrics output.
- Default `agentshell manual` output: 2,050 chars, about 513 tokens, versus 8,809 chars, about 2,203 tokens, for `agentshell manual --full`. This is a 76.7% reduction for the common command-discovery path; topic pages are smaller still (`repair`: 787 chars, `plugin`: 657 chars).

Batch 5 real-project evidence extends the healthy-project smoke set to
AgentShell itself, Chalk, and `@sindresorhus/is`. All three local runnable
projects passed in both full and fix-first evaluation modes. The fix-first path
used 581 estimated output tokens versus 15,789 estimated output tokens for the
full raw/split/fix comparison, a 96.3% reduction while preserving the same 3/3
passing project count. In full mode, the `fix` arm used 94.5% fewer estimated
tokens than `raw`.

See `docs/real-project-evidence.md` for the project list, artifact paths,
full-vs-fix-first tables, and caveats. This evidence is a healthy real-project
pass-through measurement, not a claim of real bug repair success; injected
failure fixtures remain the current repair-success evidence.

Batch 7 repeats the fix-first path three times for each of the same three
projects. All nine fix-first runs passed, with average estimated output of 194
tokens per run. Token output was stable across runs; duration remained noisy
because it is dominated by the target project's test suite and local machine
load.

The checked-in real-project fixture suite now covers eighteen runnable fixtures:
one healthy baseline plus seventeen supported repair classes, including all
currently documented repair strategies. The latest full matrix passed 18/18
runnable fixtures, with split repairing 17/17 and fix repairing 17/17.
Repeating fix-first three times passed 51/51 repair runs, averaging 262
estimated output tokens per repair run. On a one-run average basis, fix-first
reduced checked-in fixture output from 22,112 estimated tokens for full
raw/split/fix evaluation to 4,459.

The compact diagnose speed pass preserved 17/17 one-run fix success on the
current checked-in repair fixture set. Local cached profile samples for
deterministic TypeScript and import-path diagnoses completed AgentShell-side
work in about 16-18ms and omitted the generic `symbol-search` phase. The
full-fixture wall-clock delta remains noisy because local subprocess and test
execution dominate at this size.

## Supported Suggestion Strategies

Current automatic fix strategies are intentionally narrow:

- `missing-object-property`: add a missing object property required by an assertion.
- `deep-equal-missing-property`: add a flat missing property from an expected `assert.deepEqual` object.
- `deep-equal-array-elements`: append simple missing elements from an expected `assert.deepEqual` array.
- `deep-equal-array-removal`: remove simple extra tail elements from an actual `assert.deepEqual` array.
- `deep-equal-extra-property-removal`: remove one simple extra property from an actual `assert.deepEqual` object.
- `deep-equal-array-primitive-replacement`: replace one simple primitive element in an actual `assert.deepEqual` array.
- `array-length`: conservatively append `undefined` entries for small returned-array length shortfalls.
- `literal-replacement`: replace a simple incorrect literal.
- `join-separator-literal`: repair an empty `join('')` separator when assertion strings identify the missing separator.
- `string-case-transform`: repair a simple string case mismatch when the expected and actual assertion strings differ only by case.
- `truthy-return`: change a simple falsy return for `assert.ok(fn())`.
- `missing-named-export`: export a uniquely declared function imported by the test.
- `import-path`: repair a relative import path typo or extension mismatch only when the missing module error points to an import line and exactly one nearby file matches.
- `typescript-missing-property`: target a unique tsc/ts-node style diagnostic for a missing required property and add a simple `string`, `number`, or `boolean` default when the type is clear.
- `typescript-primitive-literal-mismatch`: repair unique TypeScript primitive literal mismatches when the diagnostic and source line identify one safe replacement.
- `typescript-literal-mismatch`: repair simple TypeScript literal mismatches when the diagnostic names one concrete replacement.
- `typescript-property-suggestion`: repair clear TypeScript TS2551-style property-name typos when the compiler provides one unambiguous suggestion.

Unsupported failures should remain refusals with enough structured context for the agent to decide the next command.
Safe refusal paths now include `error.details.unsupportedReason` for machine-readable next-step handling.

## Safety, Hashes, And Rollback

- Safe edits require the current file hash returned by `agentshell read` or generated in a change template.
- Applied edits are hash-checked before writing so stale suggestions fail instead of overwriting newer work.
- `fix` and applied `change suggest` responses include rollback guidance when an operation is created.
- Rollback uses `agentshell undo <operationId>`.
- Benchmark suite rows report whether rollback guidance was available.

## Protocol Compatibility

Primary runtime responses now use command-scoped `protocolVersion` values,
including `start`, `understand`, `doctor`, `plugin status`, `find`, `read`,
`verify`, `diagnose`, `fix`, `run status`, `run next`, `run clear`, `benchmark`,
`metrics`, `manual`, `history`, `log get`, `schema list`, and `schema get`.
`agentshell.manual.v1` keeps the same protocol version while changing default
output through additive routing fields (`compact`, `firstPass`, `topics`,
`full`); clients that need the old full `commandMap` should call
`agentshell manual --full`.
The local plugin release report also uses
`agentshell.plugin-release-local.v1`. Additive fields, new schema names, new
error codes, and new `unsupportedReason` values are compatible within an
existing command protocol when clients can ignore unknown values. Field
removals, field meaning changes, and hard-failure envelope changes require a
new command-scoped version.

Deprecated fields should be marked in JSON Schema with `"deprecated": true`,
emitted with their replacement for at least one minor release, and removed only
in a new command protocol version. Adapter packages should treat
`agentshell schema get <name>` as the source of truth. Future MCP work should
preserve the same command payloads and `protocolVersion` values rather than
introducing a separate response contract.

## Codex Plugin Smoke

The recommended plugin first pass is:

```bash
agentshell start --compact
agentshell fix test --fast --compact
# or, when automatic repair is not safe:
agentshell diagnose test --compact
agentshell verify test
```

In short: `start --compact -> fix/diagnose/verify`.
Run `agentshell doctor` separately only when full readiness details are needed.

Local plugin validation and smoke coverage:

```bash
npm run plugin:validate
npm run plugin:validate:source
npm run plugin:smoke
npm run benchmark:cold-start
npm run codex:e2e
```

`agentshell plugin validate --compact` returns `agentshell.plugin-validate.v1`
as the stable one-command local plugin health report. It combines source checks,
schema/docs checks, installed cache checks, the plugin-status summary, and a
compact `nextAction`. `npm run plugin:validate:source` runs the same contract in
pre-install source-only mode for the release chain.

`agentshell start --compact --profile`, `agentshell plugin validate --compact
--profile`, and `agentshell diagnose test --compact --profile` add optional
phase timing without changing default command output. `npm run
benchmark:cold-start` prints `agentshell.cold-start-benchmark.v1`, comparing
external cold-start wall time with internal profile totals so language/runtime
decisions can be evidence-driven.

`npm run plugin:smoke -- --path <installedPath>` checks a specific installed plugin cache. Without `--path`, it resolves the current personal cache path from `.codex-plugin/plugin.json`. The smoke JSON report uses `agentshell.plugin-smoke.v1` and is exposed through `agentshell schema get plugin-smoke`. The `agentshell.manual.v1` response contract is exposed through `agentshell schema get manual`, including compact default, topic, and full variants. The smoke report now explicitly verifies that the installed `skills/agentshell/SKILL.md` recommends `agentshell start --compact` or `agentshell entry --compact` for the first pass and does not recommend the old `doctor -> understand -> fix/diagnose/verify` path as first-pass guidance.

The local install/update path is:

```bash
npm run plugin:install-local
codex plugin add agentshell@personal
```

After changing plugin code or skill instructions, refresh the cache first:

```bash
npm run plugin:cachebust
npm run plugin:install-local
codex plugin add agentshell@personal
```

Start a new Codex thread after reinstalling so updated skill instructions are loaded.

## Known Limitations

- Strategies are conservative and cover simple JavaScript test failures plus the narrow TypeScript diagnostics listed above.
- Ambiguous TypeScript diagnostics, ambiguous import path failures, array removals, nested array/object diffs, and broad refactors are not automatic yet.
- Compact diagnosis can still require `verify --tail` or `log get` when the summary is insufficient.
- Whole-run speed measurements are local and noisy; use `--profile` and
  cold-start benchmarks to separate AgentShell JS/IO work from subprocess and
  process-startup cost.
- Some script-level reports remain schema-stable rather than command-versioned; `plugin-release-local` is the first versioned script-level release control report.
- Plugin distribution is still local/personal-cache oriented; packaged public distribution is future work.
- MCP remains deferred and lower priority than the local CLI/plugin flow until the CLI and plugin contracts stabilize.
- Real-project evidence currently uses local prepared snapshots, estimated
  output tokens, one-run full-arm comparison, and repeated fix-first
  healthy-project smoke measurements; `safety` and `generalization` remain
  explicit future metrics.

## Next Steps

- Expand conservative strategies for broader TypeScript diagnostics, import path issues, and richer array diffs.
- Keep script-level report schemas aligned as release/evaluation utilities mature.
- Repeat real-project evidence with more pinned local repositories and concrete
  failing real-project cases when available.
- Prepare packaged plugin release artifacts once the local plugin flow is stable.
