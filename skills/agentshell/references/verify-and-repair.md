# Verify And Repair

Use this reference for tests, diagnosis, conservative source edits, and rollback.

## Verification

- `agentshell verify test --compact`: run the configured test command and return summarized evidence. Use `--tail N` only when inline detail is necessary.
- `agentshell verify build`, `verify lint`, `verify format`, and `verify modules`: supported build, lint, read-only format comparison, and module integrity checks.
- Run verification before completion when a supported test script exists. Inspect `verification.summary` and `suggestedNextActions` before stored logs.
- `agentshell verify changed --compact` builds a conservative plan from current Git changes; review it before adding `--execute`.
- `agentshell boundary check --policy <file> --compact` or repeated `--deny/--allow` prefixes checks changed files without modifying them.

## Fast Repair Path

1. Run `agentshell fix test --fast --compact` for a supported failing test.
2. Use `--safe --compact` or `--dry-run --compact` when a preview is required.
3. If automatic repair is refused or unclear, run `agentshell diagnose test --compact`.
4. Inspect `fixPlan`, `changeTemplate`, focused read references, implementation references, and confidence. Use full diagnosis only when omitted content is needed.
5. Prefer `diagnose.fixPlan.target` when confidence is medium or higher.
6. Preview with `agentshell change suggest --dry-run --compact`; apply only when the generated template is clear.
7. Otherwise fill an available template with `agentshell change fill <template.json> <fill.json> --apply`, or submit a reviewed hash-checked spec through `agentshell change <change.json>`.
8. Verify again, then inspect `agentshell run status --compact`.

Automatic suggestions are intentionally narrow: simple deterministic JS/TS assertion, literal, import, export, array, object, string, and TypeScript diagnostic repairs. Refusal is a safety result, not a reason to broaden the edit automatically.

## State And Recovery

- `agentshell run next`: cheapest next recommended action.
- `agentshell run status --compact`: active diagnosis, change, verification, rollback, and token estimate.
- `agentshell run latest --compact`: most recent historical run summary.
- `agentshell run clear`: discard stale active guidance while retaining snapshots.
- `agentshell history`: operation history.
- `agentshell undo [operationId]`: revert an AgentShell edit.

Never invent `expectedHash`. If an edit reports `HASH_MISMATCH`, re-read the target and rebuild the change. Go diagnosis is guidance only; automatic Go source repair is unsupported. See [go-workflows.md](go-workflows.md).
