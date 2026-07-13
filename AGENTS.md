# AgentShell Agent Instructions

This repository contains AgentShell, a structured CLI for AI coding agents.

Repository import boundary:

- Treat `docs/repository-import-plan.md` as the source of truth for deciding
  when to import this checkout into the parent repository.
- Do not stage or commit the untracked `agentshell/` project unless the user
  explicitly confirms the import action.
- When importing, keep `.agentshell/`, `node_modules/`, generated reports, logs,
  caches, and other runtime state untracked.
- Keep the initial import commit focused on AgentShell project files only; do
  not combine it with unrelated parent-repository cleanup or feature work.

When AgentShell is available, prefer it over ad hoc shell exploration for supported actions:

- Use `agentshell understand` before broad project inspection.
- Use `agentshell find <query>` before raw `rg` when a compact JSON result is enough.
- Use `agentshell read <file> --lines A:B` instead of reading whole files.
- Use `agentshell read <file> --around <query>` when a symbol, test name, or error text is known.
- Use `agentshell verify test` instead of raw test commands when diagnosing test failures. It is compact by default.
- Use `agentshell fix test --compact` first for supported failing-test repairs; it combines diagnose, suggested apply, verify, and run summary in one command.
- Use `agentshell fix test --dry-run --compact` to preview the one-command repair without changing source files.
- Use `agentshell diagnose test --compact` when speed and token cost matter; it combines compact verification, focused test refs, symbol search, and likely implementation reads in one command.
- Use `diagnose.fixPlan.target` to select the target file, range, expectedHash, and repair intent before building `change.json`.
- Use `diagnose.changeTemplate.path` when you want to fill an existing hash-checked change spec instead of creating one from scratch.
- Use `agentshell change suggest --dry-run --compact` to preview a conservative suggestion when the active diagnosis has a clear generated template.
- Use `agentshell change suggest --apply --compact` when that preview is sufficient. It currently supports missing object properties, simple wrong literals, simple truthy-return assertions, and missing named exports.
- Use `agentshell change fill <template.json> <fill.json> --apply` to fill and apply a generated template in one command.
- Use `agentshell run next` when you only need the shortest next recommended action for the active task.
- Use `agentshell run status --compact` after diagnose/change/verify to inspect the active run summary, command count, estimated token cost, rollback command, and next best action.
- Use `agentshell run latest --compact` when you need the most recent run summary rather than the active run file.
- Use `agentshell run status` only when you need the full run graph for debugging.
- Use `agentshell verify test --tail N` only when the initial summary needs inline log context.
- Use `agentshell log get <logRef> --tail N` only when `verify` summary and `logTail` are insufficient.
- Use `agentshell change <change.json>` for hash-checked edits when possible.
- Use `agentshell undo` to revert the most recent AgentShell change.
- Use `agentshell manual` for the compact command router; use `agentshell manual --topic repair|plugin|benchmark|profile|reference` for focused guidance and `agentshell manual --full` only when the complete command map is needed.
- Use `agentshell metrics --compact` when you need recent command-output cost estimates.
- Use `agentshell benchmark test` when asked to compare raw test output cost against compact AgentShell output.
- Use `agentshell schema get <name>` when an integration or agent needs the exact JSON contract.

Core rules:

- Treat AgentShell JSON as the source of truth.
- Prefer summarized verification output before requesting full logs.
- Keep file reads narrow; v0.1 intentionally caps reads at 200 lines.
- Before using `agentshell change`, read the target file and use the returned `hash` as `expectedHash`.
- If `agentshell change` returns `HASH_MISMATCH`, re-read the file and rebuild the change.
- Prefer `verify.summary`, `relatedFiles`, and `suggestedNextActions` before fetching stored logs.
- Prefer `fix test --compact` over the split diagnose/change/verify loop when the task is to repair a supported failing test.
- Prefer `diagnose test --compact` over separate `verify`, `find`, and `read` commands for the common failing-test loop.
- Prefer `change suggest --dry-run --compact` before applying or manually filling a generated template when the diagnosis is clear.
- Prefer `run next` when a short next-action check is enough.
- Prefer `run status --compact` over manually reconstructing task state from history and logs.
- Use `metrics --compact` for measurement, not for task diagnosis.
- Fall back to normal shell commands only when AgentShell does not support the needed action.
