# AgentShell for Codex

AgentShell is a structured local CLI for AI coding agents. Its v0.24 goal is to reduce terminal noise, command round trips, and token usage during code understanding and failing-test repair while keeping next-action task guidance and previewable conservative suggested changes that Codex can inspect cheaply. It includes `start --compact`/`entry --compact` for the cheapest combined doctor, compact understand, and run-next summary, full `start`/`entry` for debugging payloads, `doctor` for plugin health checks, a slim `fix test --fast --compact` response for the one-command diagnose/suggest/apply/verify loop, `fix test --safe --compact` for the preview-first policy, compact test diagnosis, structured fix plans, generated change templates, `change suggest --dry-run --compact` and `change suggest --apply --compact` for missing object properties, flat deepEqual missing properties, simple deepEqual array additions, simple deepEqual array tail removals, simple deepEqual extra property removals, simple deepEqual array primitive replacements, small returned-array length shortfalls, simple wrong literals, empty `join('')` separator repairs, simple string case transforms, simple truthy-return assertions, missing named exports, unique local import path repairs, and narrow TypeScript diagnostic repairs, `run next`, compact run status, compact metrics, compact verification, log references, raw-vs-compact benchmarking, JSON schemas, adapter instruction generation, and hash-checked edits with undo.

Use these commands first when available:

| Need | Command |
|---|---|
| Read AgentShell usage | `agentshell manual` |
| Read focused manual topics | `agentshell manual --topic repair|plugin|benchmark|profile|onboarding|log-triage|reference` |
| Read the complete command map | `agentshell manual --full` |
| First combined workspace entry | `agentshell start --compact` or `agentshell entry --compact` |
| Check plugin and CLI health first | `agentshell doctor` |
| Check local plugin install consistency | `agentshell plugin status --compact` |
| Understand workspace | `agentshell understand --compact` |
| Search code | `agentshell find <query>` |
| Read a file range | `agentshell read <file> --lines A:B` |
| Read near a symbol/text | `agentshell read <file> --around <query>` |
| Run compact tests with summary | `agentshell verify test` |
| Run tests with inline log tail | `agentshell verify test --tail N` |
| Fix supported failing tests fastest | `agentshell fix test --fast --compact` |
| Preview one-command fix | `agentshell fix test --safe --compact` |
| Diagnose failing tests fast | `agentshell diagnose test --compact` |
| Read stored logs if needed | `agentshell log get <logRef> --tail N` |
| Apply hash-checked edits | `agentshell change <change.json>` |
| Preview generated edit | `agentshell change suggest --dry-run --compact` |
| Suggest and apply generated edit | `agentshell change suggest --apply --compact` |
| Fill and apply generated edits | `agentshell change fill <template.json> <fill.json> --apply` |
| Inspect AgentShell actions | `agentshell history` |
| Inspect next task action | `agentshell run next` |
| Inspect active task run summary | `agentshell run status --compact` |
| Inspect latest run snapshot summary | `agentshell run latest --compact` |
| Revert latest AgentShell edit | `agentshell undo` |
| Inspect output cost | `agentshell metrics --compact [--limit N]` |
| Compare raw vs compact test output | `agentshell benchmark test` |
| Inspect JSON schemas | `agentshell schema list` / `agentshell schema get <name>` |

## Plugin Flow

Prefer the CLI on PATH:

```bash
agentshell manual
agentshell manual --topic repair
agentshell manual --topic onboarding
agentshell manual --topic log-triage
```

If it is unavailable, run AgentShell from a local/plugin checkout instead:

```bash
node src/cli.js manual
bin/agentshell manual
node src/cli.js manual --topic repair
bin/agentshell manual --topic repair
node src/cli.js manual --topic onboarding
node src/cli.js manual --topic log-triage
```

Workflow for a failing test:

1. Run `agentshell start --compact` first when you want readiness, compact workspace shape, and next action in the smallest response; use plain `agentshell start` only when full embedded payloads are useful.
2. Run `agentshell doctor` separately only when you need the full readiness object again.
3. Run `agentshell understand --compact` for the first-pass project decision context; run full `agentshell understand` only when root paths, changed file names, or action reasons are needed.
4. Run `agentshell fix test --fast --compact` when the goal is to repair a supported failing test quickly. `agentshell fix test --compact` keeps the same compatible fast default.
5. Use `agentshell fix test --safe --compact` or `agentshell fix test --dry-run --compact` when you want a one-command preview before applying.
6. If `fix` cannot safely apply a suggestion, run `agentshell diagnose test --compact`.
7. Inspect `fixPlan`, `changeTemplate`, `verification.summary`, compact read refs in `focusedReads` and `implementationReads`, `logRef`, and `suggestedNextActions`; run full `diagnose test` only when symbol lists or inline content are needed. Clear TypeScript and import-path diagnostics may skip generic reads/search and go straight to a deterministic fix target.
8. Fetch stored logs with `agentshell log get <logRef> --tail N` or rerun with `agentshell verify test --tail N` only if the diagnosis is insufficient.
9. Use `agentshell change suggest --dry-run --compact` when the active diagnosis is clear.
10. Apply with `agentshell change suggest --apply --compact` when the preview is sufficient.
11. Otherwise fill `changeTemplate.path` with `agentshell change fill <template.json> <fill.json> --apply` when available, or apply a change JSON with `agentshell change <change.json>`.
12. Run `agentshell verify test` again.
13. Run `agentshell run next` when only the next recommended command is needed.
14. Run `agentshell run status --compact` to inspect pass/fail state, command count, token estimate, rollback command, and next best action.
15. If the edit was wrong, run `agentshell undo`.

The first recommended plugin pass is `start --compact -> fix/diagnose/verify`. Treat MCP as lower priority than this local CLI/plugin loop until the CLI and plugin contracts are stable.

Avoid:

- Reading entire large files when a range is enough.
- Skipping `agentshell start --compact` or `agentshell doctor` in a fresh plugin thread when PATH, cache, or install state may be stale.
- Parsing raw test output before checking AgentShell's `summary`.
- Running several discovery commands when `agentshell understand --compact` already provides the project shape.
- Running separate `verify`, `find`, and `read` commands when `agentshell diagnose test --compact` gives enough context.
- Running the split diagnose/change/verify loop when `agentshell fix test --fast --compact` can safely handle the repair.
- Inventing `expectedHash` values instead of using `agentshell read`.
