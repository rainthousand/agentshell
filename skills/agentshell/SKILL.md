---
name: agentshell
description: Use AgentShell when a coding task benefits from compact JSON project inspection, code search, range-based file reads, or summarized test verification. Prefer it over noisy ad hoc shell commands when the `agentshell` CLI is available in the workspace.
---

# AgentShell

AgentShell is a structured local CLI for AI coding agents. Its v0.24 purpose is to reduce terminal noise, command round trips, and token usage during code understanding and failing-test repair while keeping next-action task guidance and previewable conservative suggested changes that agents can inspect cheaply. It includes `start --compact`/`entry --compact` for the cheapest combined doctor, compact understand, and run-next summary, full `start`/`entry` for debugging payloads, `doctor` readiness checks, a slim `fix test --fast --compact` response for the one-command diagnose/suggest/apply/verify loop, `fix test --safe --compact` for the preview-first policy, compact test diagnosis, structured fix plans, generated change templates, `change suggest --dry-run --compact` and `change suggest --apply --compact` for missing object properties, flat deepEqual missing properties, simple deepEqual array additions, simple deepEqual array tail removals, simple deepEqual extra property removals, simple deepEqual array primitive replacements, small returned-array length shortfalls, simple wrong literals, empty `join('')` separator repairs, simple string case transforms, simple truthy-return assertions, missing named exports, unique local import path repairs, and narrow TypeScript diagnostic repairs, `run next`, compact run status, compact metrics, compact verification, log references, raw-vs-compact benchmarking, JSON schemas, adapter instruction generation, and hash-checked edits with undo.

## When To Use

Use AgentShell first for supported actions:

- `agentshell manual` for the compact command router; use `agentshell manual --topic repair|plugin|benchmark|profile|onboarding|log-triage|reference` for focused guidance and `agentshell manual --full` only when the compact router is insufficient.
- `agentshell start --compact` or `agentshell entry --compact` to get the cheapest doctor, compact understand, and run-next summary in one machine-readable response; use plain `agentshell start` only when full embedded payloads are needed.
- `agentshell doctor` to check runtime, package/test-script, AgentShell state, and git readiness in compact JSON.
- `agentshell plugin status --compact` to check source manifest, personal marketplace, Codex plugin cache consistency, and the next install action cheaply; use full `agentshell plugin status` when check details are needed.
- `agentshell understand --compact` for first-pass project inspection; use full `agentshell understand` only when root paths, changed file names, or action reasons are needed.
- `agentshell find <query>` for compact code search.
- `agentshell read <file> --lines A:B` for bounded file reads.
- `agentshell read <file> --around <query>` for context near known text or symbols.
- `agentshell verify test` for compact summarized test output.
- `agentshell verify test --tail N` when inline log tail is needed.
- `agentshell fix test --fast --compact` for the fastest supported failing-test repair path; `agentshell fix test --compact` is the compatible default.
- `agentshell fix test --safe --compact` or `agentshell fix test --dry-run --compact` to preview the same one-command repair without changing source files.
- `agentshell diagnose test --compact` when speed and token cost matter; it combines verification, compact read refs, likely implementation reads, `fixPlan`, and `changeTemplate` in one command, and skips generic reads/search for clear deterministic TypeScript or import-path diagnostics.
- `agentshell diagnose test` when full test snippet content is useful.
- `agentshell change suggest --dry-run --compact` to preview a conservative suggested replacement.
- `agentshell change suggest --apply --compact` when the active diagnosis has a clear generated template and the preview is enough. It currently supports missing object properties, flat deepEqual missing properties, simple deepEqual array additions, simple deepEqual array tail removals, simple deepEqual extra property removals, simple deepEqual array primitive replacements, small returned-array length shortfalls, simple wrong literals, empty `join('')` separator repairs, simple string case transforms, simple truthy-return assertions, missing named exports, unique local import path repairs, and narrow TypeScript diagnostic repairs.
- `agentshell run next` to get the shortest next recommended action for the active task.
- `agentshell run clear` to discard stale active run state while keeping historical run snapshots.
- `agentshell log get <logRef> --tail N` only when more verification output is needed.
- `agentshell change <change.json>` for hash-checked edits.
- `agentshell change fill <template.json> <fill.json> --apply` to fill and apply a generated change template.
- `agentshell history` to inspect AgentShell operations.
- `agentshell run status --compact` to inspect the active diagnosis/change/verify run summary cheaply.
- `agentshell run status` to inspect the full active run graph when debugging AgentShell itself.
- `agentshell run latest --compact` to inspect the most recent run snapshot summary.
- `agentshell undo [operationId]` to revert AgentShell edits.
- `agentshell metrics --compact [--limit N]` to inspect recent output cost cheaply.
- `agentshell dashboard` to open the native macOS floating value window (browser fallback elsewhere) with measured execution time, estimated context avoided, task success, and recent trends; use `--browser` to request the browser surface explicitly.
- `agentshell trial export [--rating 1-5]` after a verified real-user task to write a redacted, collector-ready evidence JSON file to the Desktop.
- `agentshell metrics [--limit N]` when debugging detailed recent event history.
- `agentshell benchmark test` to compare raw test output with compact AgentShell output.
- `agentshell schema list` and `agentshell schema get <name>` to inspect stable JSON contracts.

Fall back to normal shell commands only when AgentShell does not support the needed action.

## Availability Check

Before relying on AgentShell in a workspace, run:

```bash
agentshell manual
agentshell manual --topic repair
agentshell start --compact
```

If `agentshell` is not on PATH, use a local checkout or plugin cache fallback:

```bash
node src/cli.js manual
bin/agentshell manual
node src/cli.js manual --topic repair
bin/agentshell manual --topic repair
node src/cli.js manual --topic onboarding
node src/cli.js manual --topic log-triage
node src/cli.js start --compact
bin/agentshell start --compact
node src/cli.js doctor
bin/agentshell doctor
```

## Workflow: Diagnose A Failing Test

1. Run `agentshell start --compact` when entering a new checkout and you want readiness, compact workspace shape, and next action in the smallest response.
2. Run `agentshell doctor` when environment readiness is unclear or you need the full readiness response again.
3. Run `agentshell understand --compact` for the first-pass project decision context.
4. Run `agentshell fix test --fast --compact` when the goal is to repair a supported failing test quickly. `agentshell fix test --compact` keeps the same compatible fast default.
5. Use `agentshell fix test --safe --compact` or `agentshell fix test --dry-run --compact` when you want a one-command preview before applying.
6. If `fix` cannot safely apply a suggestion, run `agentshell diagnose test --compact`.
7. Inspect `fixPlan`, `changeTemplate`, `verification.summary`, compact read refs in `focusedReads` and `implementationReads`, and `suggestedNextActions`; run full `diagnose test` only when symbol lists or inline content are needed.
8. Use `agentshell log get <logRef> --tail N` or `agentshell verify test --tail N` only if the diagnosis is insufficient.
9. Create a change JSON using the hash returned by `focusedReads` or `implementationReads`.
10. Prefer `agentshell change suggest --dry-run --compact` when the active diagnosis is clear.
11. Apply with `agentshell change suggest --apply --compact` when the preview is sufficient.
12. Otherwise use `agentshell change fill <template.json> <fill.json> --apply` when `changeTemplate` is available, or apply with `agentshell change <change.json>`.
13. Run `agentshell verify test` again.
14. Run `agentshell run next` when you only need the next recommended action.
15. Run `agentshell run status --compact` to inspect pass/fail state, command count, token estimate, rollback command, and next best action.
16. Run `agentshell run clear` when the active run is stale and should not guide the next action anymore.
17. If the edit was wrong, run `agentshell undo`.

## Rules

- Treat AgentShell JSON as the source of truth.
- Use `agentshell start --compact` or `agentshell entry --compact` for the cheapest first pass in a fresh workspace.
- Use `agentshell doctor` before longer workflows when the checkout, PATH, state directory, or test script may be uncertain.
- Prefer `summary` and `suggestedNextActions` before reading full logs.
- Keep file reads narrow; v0.1 caps reads at 200 lines.
- Do not invent `expectedHash` values; use the current hash from `agentshell read`.
- If `agentshell change` returns `HASH_MISMATCH`, re-read the file and rebuild the change.
- Prefer `verify.summary` and `suggestedNextActions` before fetching stored logs.
- Use `agentshell manual --topic onboarding` for the first-pass checkout workflow when entering an unfamiliar project.
- Use `agentshell manual --topic log-triage` for the summary-first, bounded-tail log workflow when terminal output is noisy.
- Use `agentshell metrics --compact` for measurement, not for diagnosis.
- Treat Dashboard context savings as estimated tool-output context avoided, execution time as measured AgentShell time, and unavailable Codex model tokens or thinking time as unavailable rather than zero.
- Use `agentshell trial export` only after final verification; review the JSON before sharing it, and do not treat its AgentShell-only telemetry as full Codex session token accounting.
- Use `agentshell fix test --fast --compact` before the split diagnose/change/verify loop when the task is to repair a supported failing test.
- Use `agentshell change suggest --apply --compact` only when the active diagnosis has a clear generated template.
- Use `agentshell run next` for the cheapest next-action check.
- Use `agentshell run clear` when stale active run state would otherwise mislead a new task.
- Use `agentshell run status --compact` for task state after a diagnose/change/verify loop.
- Use `agentshell benchmark test` when measuring demo impact.
- Use `agentshell schema get <name>` for integration work, not routine diagnosis.
- Use `agentshell diagnose test --compact` to reduce command round trips and token cost in the common failing-test workflow; compact read entries are refs with file, hash, range, matched line, and line count, not inline content, and verbose symbol lists are omitted.
- Prefer `diagnose.fixPlan.target` for the first change target when confidence is `medium` or higher.
- Fill `diagnose.changeTemplate.path` when available instead of creating a change spec from scratch.
- Use `agentshell schema get change-fill` for the fill payload contract.
