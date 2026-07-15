# AgentShell TODO

## Current Release State

- Current installed Codex personal plugin: v0.25 local candidate; run `node src/cli.js plugin status --compact` for the current local cachebuster version. The GitHub Release is not complete yet.
- Main fast path: `agentshell fix test --fast --compact`; `agentshell fix test --compact` remains the compatible default.
- Current supported automatic fix strategies:
  - `missing-object-property`
  - `deep-equal-missing-property`
  - `deep-equal-array-elements`
  - `deep-equal-array-removal`
  - `deep-equal-extra-property-removal`
  - `deep-equal-array-primitive-replacement`
  - `array-length`
  - `literal-replacement`
  - `join-separator-literal`
  - `string-case-transform`
  - `truthy-return`
  - `missing-named-export`
  - `import-path`
  - `typescript-missing-property`
  - `typescript-primitive-literal-mismatch`
  - `typescript-literal-mismatch`
  - `typescript-property-suggestion`
- MCP server has a minimal stdio JSON-RPC skeleton; fuller host packaging and mutating tool coverage remain low priority until the plugin and CLI protocol stabilize.

## Active Parallel Batch

P0 external evidence is active. The automatic redacted exporter and evaluator path are implemented, and an installed-plugin internal smoke passed at 90/100 after correctly treating non-AgentShell command noise as unobserved. Completion still requires at least three fresh, verified Codex tasks from external users. P1 non-developer installation feedback can use the same `agentshell trial export --rating 1-5` file, while MCP remains deferred.

P1 non-developer support tooling is implemented: `install.command` now preserves failures in `agentshell-install.log` without closing before the user can read them, and `check-install.command` creates a Desktop `agentshell-install-check.json` health report. Real-user installation attempts are still required to close P1 evidence.

The v0.25 local candidate now covers Node 20 standalone compatibility, managed `~/.local/bin` PATH setup, migration of legacy Dashboard launch jobs that reference a source checkout, v0.24-to-v0.25 preservation/cleanup tests, and an isolated-HOME packaged install/update/doctor/uninstall smoke. The remote GitHub Release and its downloadable-asset verification remain unfinished.

The local candidate release package now uses maximum ZIP compression with an immediate integrity test, records Node/Bun builder metadata and real package compression ratio, and blocks standalone artifacts above 100 MiB or ZIPs above 40 MiB. The current 85.3 MiB SEA binary is intentionally not stripped until SEA segment, signing, and runtime safety can be proven on a disposable copy.

The macOS menu-bar Dashboard is now part of the managed install lifecycle through `com.agentshell.dashboard`: install/update start the user LaunchAgent, doctor checks its recorded plist and loaded state, abnormal exits restart, normal stops remain stopped, and uninstall preserves any user-modified plist instead of deleting it.

The managed Dashboard no longer traverses registered source directories from launchd. Project-context commands atomically publish path-free snapshots under `~/.agentshell/dashboard-snapshots`; install/update seeds every accessible registered workspace, and the menu-bar service merges only those snapshots. The local migration refreshed 28 workspaces and preserved verified token/time evidence without requiring Full Disk Access.

The local value Dashboard batch is implemented around `agentshell.metrics.v2` and `agentshell dashboard`: measured execution and elapsed time are separated from estimated context avoided, unavailable Codex accounting remains explicit, and the read-only UI binds only to `127.0.0.1`. Freshness, stale managed runs, and attribution coverage now make the evidence boundary auditable; verified time remains unavailable until a real cache hit has a measured baseline. The macOS native AppKit menu-bar shell is built and CLI integration is active; external-user validation and a later Windows desktop shell remain follow-up evidence/work.

Completed batches were intentionally split by write scope so sub-agents could work in parallel.

| Track | Owner | Status | Write Scope | Goal |
|---|---|---|---|---|
| P0 deepEqual | Sub-agent A | Done | `src/commands/change.js`, `schemas/change-suggest.schema.json`, `tests/change-suggest.test.js` | Add a conservative flat-object `deepEqual` missing-field strategy. |
| P2 protocol | Sub-agent C | Done | `docs/protocol.md`, `docs/protocol-versioning.md`, `schemas/common.schema.json`, `tests/cli-smoke.test.js` | Define protocol rollout, error codes, and `unsupportedReason`. |
| P3 adapters | Sub-agent D | Done | `scripts/adapter-generate.js`, `tests/adapter-generate.test.js`, `docs/adapters/`, README adapter section, package scripts | Generate Claude/Cursor/AGENTS.md adapter templates. |
| P4 benchmark | Sub-agent E | Done | `examples/benchmark-cases/`, `scripts/benchmark-suite.js`, `tests/benchmark-suite.test.js`, `docs/benchmark-suite.md` | Expand suite to multiple cases and grouped JSON output. |
| Integration | Main agent | Done | Versioning, docs, tests, plugin install | Review, merge, run full validation, install plugin. |
| P0 strategy slimming | Sub-agent Socrates | Done | `src/commands/change.js`, `src/strategies/change-suggest.js` | Move suggestion strategies out of the command orchestration file. |
| P4 benchmark report | Main agent + partial Sub-agent Gauss | Done | `scripts/benchmark-suite.js`, `tests/benchmark-suite.test.js`, `docs/benchmark-suite.md` | Add duration, rollback availability, and Markdown output. |
| P5 plugin smoke | Sub-agent Epicurus | Done | `scripts/plugin-smoke.js`, `tests/plugin-smoke.test.js`, `package.json`, docs | Automate installed-plugin smoke checks. |
| P1 benchmark CI | Sub-agent Hume | Done | `scripts/benchmark-suite.js`, `tests/benchmark-suite.test.js`, `docs/benchmark-suite.md`, `package.json` | Add CI thresholds for supported benchmark cases, rollback, command count, and fix token ceiling. |
| P2 unsupportedReason runtime | Sub-agent Cicero | Done | `src/commands/change.js`, `src/commands/fix.js`, `tests/change-suggest.test.js`, `tests/fix.test.js` | Emit `unsupportedReason` in safe refusal error details. |
| P5 release notes | Sub-agent Feynman | Done | `docs/release-notes-v0.24.md`, `README.md`, `docs/codex-plugin-flow.md`, `TODO.md` | Publish v0.24 release notes with feature and benchmark evidence. |
| P6 real project eval | Sub-agent Sagan | Done | `examples/real-projects.json`, `docs/real-project-eval.md`, `scripts/real-project-eval.js`, `tests/real-project-eval.test.js` | Add checked-in manifest samples and runnable/missing/skipped evaluation fields. |
| P1 fix policy modes | Sub-agent Mendel | Done | `src/commands/fix.js`, `src/cli.js`, `src/commands/manual.js`, `tests/fix.test.js`, docs, skill | Add explicit `--fast` apply+verify and `--safe` preview-first policies. |
| P4 benchmark artifacts | Sub-agent Boyle | Done | `scripts/benchmark-suite.js`, `tests/benchmark-suite.test.js`, `docs/benchmark-suite.md`, `README.md` | Write JSON and Markdown CI artifact reports. |
| P6 real project arms | Sub-agent Goodall | Done | `scripts/real-project-eval.js`, `tests/real-project-eval.test.js`, `docs/real-project-eval.md`, `examples/real-projects.json` | Run raw/split/fix arms in isolated temporary copies. |
| P6 real project artifacts | Task B | Done | `scripts/real-project-eval.js`, `tests/real-project-eval.test.js`, `docs/real-project-eval.md`, `schemas/real-project-eval.schema.json`, `README.md` | Add `--report` JSON output and optional compact per-arm artifacts without default raw logs. |
| P1 test-result cache | Sub-agent Fermat | Done | `src/core/cache.js`, `src/commands/verify.js`, `src/commands/diagnose.js`, `src/commands/fix.js`, tests, docs | Reuse repeated identical failing test results with `cacheHit`/`cacheKey`. |
| P2 schema tightening | Sub-agent Helmholtz + main agent | Done | `schemas/`, `src/commands/schema.js`, protocol docs, smoke/tests | Add fix policy, benchmark-suite, real-project-eval, and cache-aware schemas. |
| P6 local fixtures | Sub-agent Lorentz | Done | `examples/real-projects.json`, `examples/real-projects/healthy-node-baseline/`, docs, tests | Add pinned local runnable baseline fixture while preserving missing/skipped samples. |
| P1 cache benchmark | Sub-agent Gibbs | Done | `scripts/cache-benchmark.js`, `tests/cache-benchmark.test.js`, `package.json`, docs | Quantify repeated-failure cache speedup with `npm run benchmark:cache`. |
| P0 array strategies | Sub-agent Confucius | Done | `src/strategies/change-suggest.js`, `src/commands/diagnose.js`, schema, tests, benchmark case, docs | Add conservative array missing-element and small length-shortfall repairs. |
| P6 repeated eval runs | Main agent | Done | `scripts/real-project-eval.js`, `tests/real-project-eval.test.js`, schema, docs, smoke | Add `--runs` repeated-arm aggregation with per-run artifacts. |
| P5 packaging hygiene | Main agent | Done | `scripts/plugin-smoke.js`, `docs/codex-plugin-flow.md`, selected schemas | Verify release payload excludes runtime state and document install/update/uninstall flow. |
| P0 import-path strategy | Sub-agent Noether + main agent | Done | `src/commands/diagnose.js`, `src/strategies/change-suggest.js`, schema, tests, benchmark case, docs | Repair unique nearby relative import path typos or extension mismatches. |
| P1 related-test verification | Sub-agent Archimedes + main agent | Done | `src/commands/verify.js`, cache/package helpers, schema, tests, docs | Use cached related test files for conservative focused verification before full commands. |
| P6 import-path eval fixture | Main agent | Done | `examples/real-projects.json`, `examples/real-projects/import-path-typo/`, docs, tests, smoke | Add a runnable real-project eval fixture for the `import-path` strategy. |
| P0 TypeScript diagnostic | Sub-agent Parfit | Done | `src/commands/diagnose.js`, `src/strategies/change-suggest.js`, schema, tests, benchmark case, docs | Target unique tsc-style diagnostics and conservatively repair simple missing required properties. |
| P6 TypeScript diagnostic eval fixture | Task B | Done | `examples/real-projects.json`, `examples/real-projects/typescript-diagnostic/`, docs, tests, smoke | Add a runnable real-project eval fixture for the `typescript-missing-property` strategy. |
| P6 TypeScript primitive literal eval fixture | Task B | Done | `examples/real-projects.json`, `examples/real-projects/typescript-primitive-literal/`, docs, tests, smoke | Add a runnable real-project eval fixture for the `typescript-primitive-literal-mismatch` strategy. |
| P6 literal replacement eval fixture | Task D | Done | `examples/real-projects.json`, `examples/real-projects/literal-replacement/`, docs, tests, smoke | Add a runnable real-project eval fixture for the `literal-replacement` strategy. |
| P6 truthy return eval fixture | Task C | Done | `examples/real-projects.json`, `examples/real-projects/truthy-return/`, docs, tests, smoke | Add a runnable real-project eval fixture for the `truthy-return` strategy. |
| P6 missing named export eval fixture | Task C | Done | `examples/real-projects.json`, `examples/real-projects/missing-named-export/`, docs, tests, smoke | Add a runnable real-project eval fixture for the `missing-named-export` strategy. |
| P1 compact diagnose slimming | Sub-agent Newton | Done | `src/commands/diagnose.js`, `schemas/diagnose.schema.json`, tests, docs, skill | Remove inline read content and verbose symbol lists from `diagnose test --compact`. |
| P2 verify/diagnose protocol | Sub-agent Dirac | Done | `src/commands/verify.js`, `src/commands/diagnose.js`, schemas, docs, tests | Add `protocolVersion` to verify and diagnose success responses. |
| P2 lower-use runtime protocol | Task A | Done | `src/commands/manual.js`, `src/commands/history.js`, `src/commands/log.js`, `src/commands/schema.js`, tests, smoke, docs | Add command-scoped `protocolVersion` to manual/history/log/schema list/schema get success responses. |
| P3 adapter packages | Sub-agent Popper | Done | `scripts/adapter-generate.js`, tests, docs, package scripts | Generate Claude Code and Cursor/Windsurf drop-in adapter packages. |
| Task D MCP interface draft | Codex | Done | `docs/mcp-interface.md`, `docs/adapters/README.md`, `README.md`, `TODO.md` | Document the deferred MCP server surface, schema mapping, lifecycle, priority rationale, and adapter relationship without implementing a server. |
| Task B MCP server skeleton | Codex | Done | `src/mcp/server.js`, `bin/agentshell-mcp`, `package.json`, `tests/mcp-server.test.js`, `docs/mcp-interface.md`, `README.md`, `TODO.md` | Add a minimal no-dependency stdio JSON-RPC skeleton with initialize, tools/list, and CLI-backed tools/call smoke coverage. |
| Task C compatibility policy | Codex | Done | `docs/protocol-versioning.md`, `docs/protocol.md`, `README.md`, `docs/release-notes-v0.24.md`, `TODO.md` | Define AgentShell JSON compatibility, field deprecation, protocol bump, schema marker, adapter, and MCP policy. |
| Task D repository import | Codex | Done | `docs/repository-import-plan.md`, `README.md`, `TODO.md`, `AGENTS.md` | Decide that `agentshell/` should be imported as a tracked project only after user confirmation, with explicit pre-import checks, ignored runtime state, and commit boundaries. |
| Plugin batch 2 machine-readable status | Codex | Done | `src/commands/plugin-status.js`, `scripts/plugin-release-local.js`, schemas, tests, docs, skill | Add compact `nextAction`, release `status/durationMs/failedStep`, and publish the updated local Codex plugin. |
| Plugin batch 3 release protocol | Codex | Done | `scripts/plugin-release-local.js`, `schemas/plugin-release-local.schema.json`, `src/commands/schema.js`, tests, docs, smoke | Version and expose the local plugin release report contract as `agentshell.plugin-release-local.v1`. |
| Plugin batch 7 protocol hygiene | Codex | Done | `docs/release-notes-v0.24.md`, `docs/protocol.md`, `docs/protocol-versioning.md`, `scripts/plugin-smoke.js`, tests | Align release/protocol docs with current contracts and add smoke coverage against stale release-note claims. |
| Code review packaging hygiene | Codex | Done | `scripts/install-codex-plugin.js`, `scripts/plugin-smoke.js`, `tests/install-codex-plugin.test.js`, docs | Exclude generated `artifacts/` from plugin installs, preserve executable bin modes, and publish the slimmer plugin cache. |
| Batch 4 real-project evaluation run | Codex | Done | `artifacts/real-project-candidates.batch4.*`, `artifacts/real-projects.batch4.draft.json`, `artifacts/real-project-eval.batch4.*` | Import local Chalk and `@sindresorhus/is` candidates, generate a manifest draft, and compare `raw`, `split`, and `fix-first` AgentShell evaluation paths. |
| Batch 5 real-project evidence | Codex + sub-agent analysis | Done | `scripts/real-project-eval.js`, `tests/real-project-eval.test.js`, `docs/real-project-evidence.md`, `README.md`, `artifacts/real-project-candidates.batch5.*`, `artifacts/real-projects.batch5.draft.json`, `artifacts/real-project-eval.batch5.*` | Extend real-project evidence to AgentShell, Chalk, and `@sindresorhus/is`, document 96.3% fix-first token reduction versus full arms, and exclude generated directories from isolated eval copies. |
| Batch 6 plugin stabilization | Codex | Done | `docs/release-notes-v0.24.md`, `docs/codex-plugin-flow.md`, `scripts/plugin-smoke.js`, `TODO.md`, `.codex-plugin/plugin.json`, plugin cache | Fold batch 5 evidence into release docs, add installed-plugin smoke coverage for real-project evidence, and publish local plugin `0.24.0+codex.20260708065222`. |
| Batch 7 fix-first repeated stability | Codex | Done | `artifacts/real-project-eval.batch7.fix-first-runs3*`, `docs/real-project-evidence.md`, `docs/release-notes-v0.24.md`, `scripts/plugin-smoke.js`, `TODO.md`, plugin cache | Repeat fix-first across AgentShell, Chalk, and `@sindresorhus/is` with `--runs 3`; all 9 runs passed with 194 average estimated output tokens per run, and publish local plugin `0.24.0+codex.20260708070747`. |
| Product evidence review fixes | Codex | Done | `README.md`, `docs/real-project-evidence.md`, `docs/benchmark-evidence.md`, `scripts/plugin-smoke.js`, `TODO.md`, plugin cache | Align first-screen README and benchmark docs with current batch 5/7 evidence, clarify source-checkout-only artifacts, add smoke checks against evidence drift, and publish local plugin `0.24.0+codex.20260708071825`. |
| Plugin developer metadata | Codex | Done | `.codex-plugin/plugin.json`, `TODO.md`, plugin cache | Set plugin `author.name` and `interface.developerName` to `Alvin`, then publish local plugin `0.24.0+codex.20260708074303`. |
| Plugin self-maintenance batch | Codex + sub-agents | Done | `src/commands/plugin-status.js`, `schemas/plugin-status.schema.json`, `tests/cli-smoke.test.js`, `scripts/plugin-smoke.js`, `tests/plugin-smoke.test.js`, `docs/codex-plugin-flow.md`, `TODO.md`, plugin cache | Expose `authorName`/`developerName` in plugin status, add installed-plugin identity smoke checks, clarify next candidate batches, and publish local plugin `0.24.0+codex.20260708075242`. |
| Plugin self-maintenance validation batch | Codex + sub-agents | Done | `src/commands/plugin-status.js`, `scripts/plugin-smoke.js`, `scripts/plugin-release-local.js`, `schemas/plugin-release-local.schema.json`, tests, `docs/codex-plugin-flow.md`, `TODO.md`, plugin cache | Check cache metadata drift, verify installed plugin-status developer metadata contracts, expose plugin metadata in release reports, fix smoke cache pollution, and publish local plugin `0.24.0+codex.20260708082716`. |
| Plugin smoke protocol batch | Codex | Done | `scripts/plugin-smoke.js`, `schemas/plugin-smoke.schema.json`, `src/commands/schema.js`, tests, protocol docs, release notes, plugin cache | Version plugin smoke JSON as `agentshell.plugin-smoke.v1`, expose `agentshell schema get plugin-smoke`, add installed smoke self-checks, and publish local plugin `0.24.0+codex.20260708093441`. |
| Plugin validate protocol batch | Codex | Done | `src/commands/plugin-validate.js`, `schemas/plugin-validate.schema.json`, `src/cli.js`, `src/commands/schema.js`, tests, protocol docs, release notes, plugin cache | Add `agentshell plugin validate --compact` and `--source-only` as `agentshell.plugin-validate.v1`, wire npm/release/smoke validation, and publish local plugin `0.24.0+codex.20260708094719`. |
| Performance evidence batch | Codex | Done | `src/core/profile.js`, profiled command paths, `scripts/cold-start-benchmark.js`, schemas, tests, performance docs, plugin cache | Add optional command-local profiling, `agentshell.cold-start-benchmark.v1`, baseline artifacts, and plugin smoke coverage; publish local plugin `0.24.0+codex.20260708154450`. |
| Command surface slimming batch | Codex | Done | `src/commands/manual.js`, `src/cli.js`, tests, skill, docs, smoke, plugin cache | Make `agentshell manual` compact by default, add focused `manual --topic` payloads and `manual --full`, measure a 76.7% default manual output reduction, and publish local plugin `0.24.0+codex.20260708163015`. |
| Plugin self-maintenance schema batch | Codex + sub-agent | Done | `schemas/manual.schema.json`, `src/commands/schema.js`, `scripts/plugin-smoke.js`, docs, tests, plugin cache | Expose `agentshell schema get manual`, smoke compact/topic/full manual contracts and agent-facing docs, and publish local plugin `0.24.0+codex.20260708164150`. |
| String case transform strategy batch | Codex + sub-agent | Done | `src/strategies/change-suggest.js`, `schemas/change-suggest.schema.json`, tests, docs, skill, plugin cache | Add conservative `string-case-transform` repairs for simple return expressions when assertion strings differ only by case, keep ambiguous cases as safe refusals, and publish local plugin `0.24.0+codex.20260708164820`. |
| Batch 3 real-project candidate and eval refresh | Codex + sub-agent | Done | `artifacts/real-project-candidates.batch3.*`, `artifacts/real-project-eval.batch3.*`, `artifacts/batch3-summary.json` | Re-run candidate import and full/fix-first eval to confirm the checked-in repair fixtures were stable before adding another pinned fixture. |
| Batch 4 string-case eval fixture | Codex + sub-agent | Done | `examples/real-projects.json`, `examples/real-projects/string-case-transform/`, `tests/real-project-eval.test.js`, `docs/real-project-eval.md`, `scripts/plugin-smoke.js` | Add a runnable real-project eval fixture for the `string-case-transform` strategy and smoke the bundled fixture files. |
| Batch 5 checked-in repair evidence refresh | Codex | Done | `artifacts/real-project-eval.batch5.*`, `artifacts/batch5-summary.json`, `docs/real-project-evidence.md`, `docs/benchmark-evidence.md`, `README.md`, `docs/release-notes-v0.24.md` | Document the 10/10 checked-in fixture matrix, 27/27 fix-first repeated repair runs, and 81.2% one-run token reduction versus the full raw/split/fix matrix. |
| Batch 6 plugin self-maintenance evidence hardening | Codex | Done | `scripts/plugin-smoke.js`, `tests/plugin-smoke.test.js`, `TODO.md`, plugin cache | Harden installed-plugin smoke checks against checked-in repair evidence drift and publish local plugin `0.24.0+codex.20260708171148`. |
| P0/P6 array fixture expansion | Codex + sub-agent | Done | `examples/real-projects.json`, `examples/real-projects/deep-equal-array-elements/`, `examples/real-projects/array-length/`, tests, docs, smoke, artifacts | Add checked-in real-project fixtures for `deep-equal-array-elements` and `array-length`, then refresh fixture evidence for the expanded repair set. |
| P1 deterministic diagnose speed | Codex + sub-agent review | Done | `src/commands/diagnose.js`, `tests/diagnose.test.js`, performance docs, release notes | Skip generic reads/search for deterministic TypeScript/import-path diagnoses and skip compact symbol search when implementation imports already identify the target. |
| Plugin polish batch | Codex | Done | `src/commands/manual.js`, `skills/agentshell/SKILL.md`, `docs/agent/codex.md`, docs | Align agent-facing guidance with compact diagnose refs, deterministic fast paths, and the expanded supported strategy list. |
| P1 verify cache context reuse | Codex | Done | `src/core/cache.js`, `src/commands/verify.js`, tests, artifacts | Reuse a per-verify cache context across full lookup, related-test planning, and cache write-back without changing response contracts. |
| P0/P6 deepEqual array removal | Codex | Done | `src/strategies/change-suggest.js`, schema, tests, `examples/real-projects/deep-equal-array-removal/`, docs, smoke, artifacts | Add conservative extra-tail-element removal for simple `assert.deepEqual` arrays and pin a checked-in eval fixture; refresh evidence to 13/13 runnable and 36/36 repeated fix-first repair runs. |
| Batch 1-5 plugin hardening | Codex + sub-agents | Done | `src/commands/fix.js`, `src/commands/change.js`, `src/strategies/change-suggest.js`, schemas, scripts, tests, docs, plugin cache | Add in-memory suggest/apply fast path, `fix --profile`, two conservative deepEqual strategies, strategy coverage matrix/self-validation, adapter evidence refresh, and publish local plugin `0.24.0+codex.20260709031502`. |
| Core product evidence gates 1-4 | Codex | Done | `scripts/codex-plugin-trial.js`, `scripts/strategy-intake.js`, `scripts/product-readiness.js`, `scripts/real-project-candidates.js`, tests, docs, artifacts | Add Codex plugin effect validation, strategy intake, heavy readiness dry-run wiring, fix local two-segment candidate path classification, and refresh checked-in candidate/eval evidence. |
| Evidence gate protocolization | Codex | Done | `schemas/codex-plugin-trial.schema.json`, `schemas/strategy-intake.schema.json`, `src/commands/schema.js`, `scripts/product-readiness.js`, `scripts/plugin-smoke.js`, tests, docs | Give Codex plugin trial and strategy intake their own exposed schema contracts, align plugin smoke/readiness checks, and keep installed-plugin version state current. |
| Real Codex plugin run collector | Codex | Done | `scripts/codex-plugin-trial-collect.js`, `examples/codex-plugin-new-thread.sample.json`, package scripts, readiness, plugin smoke, tests, docs | Collect real Codex new-thread command logs and score them under the same `agentshell.codex-plugin-trial.v1` protocol as the synthetic plugin-effect trial. |
| Real Codex capture template | Codex | Done | `scripts/codex-plugin-trial-template.js`, `schemas/codex-plugin-trial-template.schema.json`, package scripts, readiness, plugin smoke, tests, docs | Generate fillable JSON and Markdown capture forms for real Codex new-thread plugin-effect evidence before scoring with `codex:plugin:collect`. |
| Real Codex plugin run suite | Codex | Done | `scripts/codex-plugin-trial-suite.js`, `schemas/codex-plugin-trial-suite.schema.json`, `examples/codex-plugin-suite.sample.json`, package scripts, readiness, plugin smoke, tests, docs | Aggregate multiple real Codex new-thread plugin runs into strong-rate, average score, token, duration, and per-fixture stability evidence. |
| Real Codex plugin trial plan | Codex | Done | `scripts/codex-plugin-trial-plan.js`, `schemas/codex-plugin-trial-plan.schema.json`, package scripts, readiness, plugin smoke, tests, docs | Generate several real Codex run-log templates, Markdown capture forms, and a suite manifest draft for 3-5 fresh-thread stability trials. |
| P0 external evidence exporter | Codex | Tooling done; external runs pending | `src/commands/trial-export.js`, CLI/schema/tests, beta evidence docs, skill | Export redacted AgentShell command timing, output-token estimates, final verification, plugin version, anonymous runtime, and optional rating with one user-facing command. |

## Next Candidate Batches

These are backlog groupings for future parallel work. They are not an active implementation plan, and MCP remains a low-priority compatibility surface rather than the current product mainline.

### Ready: Plugin Self-Maintenance And Validation

Can start without new product samples if the goal is to harden the existing local plugin workflow.

- Re-run installed-plugin smoke checks after any docs, schema, or packaging change.
- Keep plugin release report/status contracts aligned with schema exposure and release docs.
- Maintain packaging hygiene checks for excluded runtime state, executable bin modes, and evidence-document drift.
- Refresh local plugin publication only after a meaningful plugin-facing change.

### Ready: Core Product Evidence Gates

Can start without adding new runtime commands.

- Run `npm run codex:plugin:trial` to compare Codex raw-shell behavior with Codex AgentShell-plugin behavior using the adapter trial suite.
- Run `npm run codex:plugin:template -- --json artifacts/codex-plugin-run-log.json --markdown artifacts/codex-plugin-run-log.md` before a fresh Codex thread to generate the capture form.
- Run `npm run codex:plugin:plan -- --runs 3 --out-dir artifacts/codex-plugin-plan` before a 3-run fresh-thread stability check.
- Run `npm run codex:plugin:collect -- --input examples/codex-plugin-new-thread.sample.json` to score a real Codex new-thread transcript under the same plugin-effect protocol.
- Run `npm run codex:plugin:suite -- --manifest examples/codex-plugin-suite.sample.json` to aggregate several real Codex run logs into a stability report.
- Run `npm run strategy:intake -- --input examples/strategy-intake.sample.json` to classify real failure samples before expanding P0 strategies.
- Run `npm run product:readiness -- --heavy` for the release-candidate gate; use `-- --heavy --dry-run` when checking wiring only.

### Needs Real Samples: P0/P6 Fix And Evaluation Work

Wait for concrete failing diagnostics or locally available candidate repositories before implementation.

- P0: Broader TypeScript diagnostic fixes beyond the currently supported unique missing-property, primitive-literal, concrete-literal, and TS2551 property-suggestion cases.
- P0: Broader import-path diagnostics beyond unique local relative/CommonJS typos, missing extensions, extension mismatches, and directory `index` imports.
- P6: Run candidate import/evaluation on selected external or local repo candidates, then pin only repos that are locally available, stable, and valuable.
- P6: Resolve package-level workspace scripts only after a concrete monorepo candidate needs per-package eval selection.

### Low Priority: MCP Host Compatibility

Defer until a real host integration needs it. Keep this behind the plugin and CLI protocol work.

- Harden cancellation behavior.
- Resolve packaged binary discovery for hosts.
- Add schema validation at the MCP boundary.
- Consider mutating tools only when a host workflow proves the need and the safety model is clear.

### Needs User Confirmation: Git Import

Do not execute without explicit user approval.

- Import `agentshell/` as a tracked project only after confirmation.
- Follow `docs/repository-import-plan.md` for pre-import checks, ignored runtime state, staging boundaries, and commit boundaries.

## P0: Fix Success Rate

Done:

- Missing object property.
- Simple literal replacement.
- Quote-style literal replacement.
- Empty `join('')` separator repairs when assertion strings identify the missing separator.
- Simple string case transforms when expected and actual assertion strings differ only by case and the implementation has one simple return expression.
- Simple truthy return for `assert.ok(fn())`.
- Missing named export.
- Flat `deepEqual` object missing fields.
- Simple `deepEqual` array missing elements.
- Simple `deepEqual` array tail-element removals.
- Small returned-array length shortfalls.
- Relative import path typo, CommonJS `require` path typo without an extension, missing extension, extension mismatch, or directory `index` import when a missing-module error has one unique local match.
- Simple TypeScript missing required property diagnostics when the target object literal is clear.
- Simple TypeScript TS2322/TS2345 primitive literal mismatches when the diagnostic names one concrete string, number, or boolean literal replacement and the diagnostic line has one unique candidate.
- Simple TypeScript TS2322 primitive literal mismatches when the diagnostic line has one unique string, number, or boolean literal candidate.
- Simple TypeScript TS2551 property-name typos when the diagnostic line has one unique misspelled property and the compiler provides one clear suggestion.
- Suggestion strategies return `{ strategy, replacement }` from a single source of truth.
- Strategy implementation moved out of `src/commands/change.js` into `src/strategies/change-suggest.js`.

Deferred:

- Broader TypeScript diagnostic fixes beyond unique missing required properties, primitive literal mismatches, concrete primitive literal replacements, and clear TS2551 property suggestions, once a concrete failing diagnostic is selected.
- Broader import path diagnostics beyond unique local relative/CommonJS `require` typos, missing extensions, extension mismatches, and directory `index` imports, once a concrete failing import pattern is selected.

## P1: Speed And Token Cost

Done:

- `fix test --compact` one-command repair loop.
- `fix test --fast --compact` explicit apply+verify policy.
- `fix test --safe --compact` preview-first policy.
- Slim compact response, currently around 200 output tokens on the noisy demo.
- Raw/split/fix benchmark suite across multiple cases.
- CI threshold mode for the benchmark suite.
- Conservative test-result cache for repeated identical failures, surfaced through `cacheHit` and `cacheKey`.
- Cache benchmark via `npm run benchmark:cache`.
- Related-test-file verification before full test command for conservative `node --test`, `vitest`, `jest`, and `mocha` single-file runs.
- Slimmer `diagnose --compact` without inline read content.
- Deterministic compact diagnose path for clear TypeScript and import-path failures, avoiding generic reads and symbol search.
- Compact diagnose skips symbol search when local imports have already identified an implementation target.
- Per-verify cache context reuse across cache lookup, related-test planning, and cache write-back.
- In-memory `change suggest --apply` fast path avoids re-reading the generated fill/template through `fillChange` before applying.
- `fix test --fast --compact --profile` reports `diagnose-test`, `suggest-apply`, and `verify-final` phase timings; a local demo sample showed `suggest-apply` at 4ms with final verification dominating.

## P2: Protocol Stability

Done:

- `fix` success responses include `protocolVersion: "agentshell.fix.v1"`.
- `verify` verification-result responses include `protocolVersion: "agentshell.verify.v1"`.
- `diagnose` success responses include `protocolVersion: "agentshell.diagnose.v1"`.
- `understand`, `find`, `read`, and `run next` success responses include command-scoped protocol versions.
- `run status`, `benchmark`, and `metrics` success responses include command-scoped protocol versions.
- `manual`, `history`, `log get`, `schema list`, and `schema get` success responses include command-scoped protocol versions. `schema get` remains a direct JSON Schema document response with the command response version as a top-level schema extension keyword.
- `fix.schema.json` includes the protocol version.
- `verify.schema.json` and `diagnose.schema.json` include protocol versions.
- `read.schema.json` and `run-next.schema.json` include protocol versions while failures remain on the shared common failure shape.
- `fix.schema.json` includes stable `policy: fast|safe` when present.
- `verify.schema.json` exposes cache metadata.
- `benchmark-suite` and `real-project-eval` schemas are exposed through `agentshell schema get`.
- Shared protocol versioning document.
- Shared error-code table.
- Shared `unsupportedReason` vocabulary.
- Compatibility policy for additive changes, breaking changes, and command-scoped protocol bumps.
- Field deprecation policy with JSON Schema `"deprecated": true` markers and at least one minor release of overlap.
- Adapter compatibility policy for schema-driven validation, unknown-field handling, and stable control-flow fields.
- MCP compatibility boundary preserving AgentShell command payloads and `protocolVersion` values.
- `change-suggest` preview schema tightened to `{ file, range, fill }`.
- `change-suggest.applied`, `metrics`, `run`, and `benchmark` schemas tightened beyond broad object fields.
- `metrics.byCommand` remains a dynamic command-name map by design; keys are non-empty strings and values are closed stat objects.
- `benchmark-suite.cases` remains a dynamic fixture-id map with constrained lowercase kebab-case keys; real-project-eval arm maps are closed to `raw`, `split`, and `fix`.
- `unsupportedReason` emitted in `change suggest` and `fix test` safe refusal error details.

Deferred:

- When the first replacement field is introduced, add a concrete schema test that asserts `"deprecated": true` and replacement text are present.

## P3: Agent And Host Adapters

Done:

- Claude Code adapter guide.
- Cursor/Windsurf adapter guide.
- Generic `AGENTS.md` adapter guide.
- Adapter generator script.
- Dedicated Claude Code skill/package output.
- Cursor/Windsurf rules package output.
- Adapter benchmark prompts for Claude Code, Cursor/Windsurf, and generic `AGENTS.md`.
- Adapter docs and generated packages now recommend `agentshell manual --topic repair` plus `agentshell fix test --fast --compact`, and include the current evidence snapshot (`36/36`, about 257 tokens/repair, `15,494->3,086`).

Deferred:

- Harden MCP only when a concrete host needs it: cancellation, packaged binary resolution, schema validation, and carefully selected mutating tools.

## P4: Benchmark Productization

Done:

- `npm run benchmark:suite` comparing raw/split/fix.
- Multiple benchmark cases under `examples/benchmark-cases/`.
- Per-case success rate, command count, chars, and tokens.
- Duration and rollback availability in suite rows.
- Markdown report mode for benchmark suite.
- CI-friendly failure thresholds.
- JSON and Markdown CI artifact output via `--report <path>` and `--markdown <path>`.
- Cache benchmark JSON for first-run versus cache-hit verification.

## P6: Real Project Evaluation

Done:

- Offline runner skeleton that reads `examples/real-projects.json`, falls back to a docs/example manifest location, and uses a built-in skipped sample when no manifest exists.
- Offline candidate importer/evaluator via `npm run eval:real-project-candidates` that inspects local repo paths or remote URL placeholders, scores suitability, and writes manifest drafts without downloading repositories.
- Candidate importer Markdown summaries via `--markdown <path>` for quick human review of summary counts, candidate tables, blockers/warnings, and manifest draft reminders.
- Checked-in `examples/real-projects.json` covering runnable, missing, and skipped sample projects.
- Pinned local healthy baseline fixture under `examples/real-projects/healthy-node-baseline`.
- Pinned local import-path typo fixture under `examples/real-projects/import-path-typo`.
- Pinned local TypeScript diagnostic fixture under `examples/real-projects/typescript-diagnostic`.
- Pinned local TypeScript property suggestion fixture under `examples/real-projects/typescript-property-suggestion`.
- Pinned local TypeScript primitive literal fixture under `examples/real-projects/typescript-primitive-literal`.
- Pinned local literal replacement fixture under `examples/real-projects/literal-replacement`.
- Pinned local deep equal array elements fixture under `examples/real-projects/deep-equal-array-elements`.
- Pinned local deep equal array removal fixture under `examples/real-projects/deep-equal-array-removal`.
- Pinned local array length fixture under `examples/real-projects/array-length`.
- Pinned local string case transform fixture under `examples/real-projects/string-case-transform`.
- Pinned local truthy return fixture under `examples/real-projects/truthy-return`.
- Pinned local missing named export fixture under `examples/real-projects/missing-named-export`.
- Manifest shape for local repo path, setup command, test command, expected failure class, allowed strategies, and metrics.
- JSON output shape with top-level `ok`, per-project statuses, availability, evaluation fields, and `pass`/`fail`/`skipped`/`missing`/`runnable` summary counts.
- Raw/split/fix arm orchestration runs in isolated temporary copies and reports per-arm tokens, duration, and success.
- `--report <path>` writes the full eval JSON, and `--artifacts-dir <dir>` stores compact per-arm artifacts.
- `--runs <n>` repeats runnable arms and reports `successRuns`, `successRate`, averages, and per-run artifacts.
- Scientific evaluation plan covering real repo selection, baseline/split/fix comparison arms, and tokens/speed/success/safety/generalization metrics.
- Candidate importer reports stable Node engine, package manager spec, dependency count, and workspace/monorepo metadata, with simple score and warning signals.

Deferred:

- Run the candidate importer on selected external/local repo candidates, then pin only repos that are locally available, stable, and valuable.
- Resolve package-level workspace scripts only after a concrete monorepo candidate needs per-package eval selection.

## P5: Engineering Hygiene

Done:

- Added v0.24 release notes covering features, benchmark evidence, supported strategies, safety/rollback, plugin smoke, limitations, and next steps.
- Plugin smoke verifies installed payload excludes `.agentshell`, `.git`, and `node_modules`.
- Install, update, and manual uninstall flows are documented.
- Decided to import `agentshell/` as a tracked project only after explicit user confirmation.
- Added `docs/repository-import-plan.md` with pre-import checks, ignored runtime state, staging and commit boundaries, and the rationale for not automatically staging or committing during planning work.
- Added `scripts/strategy-coverage-matrix.js`, `schemas/strategy-coverage-matrix.schema.json`, and `npm run strategy:coverage` to track strategy coverage across schema enum, unit tests, benchmark cases, real-project fixtures, docs, skill, and manual.
- `plugin validate` now includes strategy self-maintenance checks: unit-test and docs gaps are errors; benchmark and real-project fixture gaps are tracked as warnings.

Needs User Confirmation:

- Wait for user confirmation to execute the repository import.
