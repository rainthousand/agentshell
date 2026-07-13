# Generic AGENTS.md Adapter

Projects that use an `AGENTS.md` file can opt into AgentShell by adding a short policy section. This is the most portable adapter path because most coding agents already read repository instructions before making changes.

## Drop-In Section

```md
## AgentShell

When the `agentshell` CLI is available, prefer it for supported project inspection, failing-test repair, verification, and task-state checks.

- Run `agentshell manual --topic repair` or another focused topic if command behavior is unclear.
- Use `agentshell understand --compact` before broad project inspection; run full `agentshell understand` only when paths or changed file names are needed.
- Use `agentshell find <query>` for compact code search.
- Use `agentshell read <file> --lines A:B` or `agentshell read <file> --around <query>` for focused reads.
- For supported failing-test repairs, run `agentshell fix test --fast --compact` first.
- Use `agentshell fix test --fast --dry-run --compact` when a preview is required.
- If `fix` cannot safely apply, run `agentshell diagnose test --compact`.
- Prefer `agentshell change suggest --dry-run --compact` before applying generated edits.
- Apply generated edits with `agentshell change suggest --apply --compact`, `agentshell change fill <template.json> <fill.json> --apply`, or `agentshell change <change.json>`.
- Run `agentshell verify test` after changes.
- Use `agentshell run next` for the shortest next action.
- Use `agentshell run status --compact` for pass/fail state, output-cost estimate, and rollback guidance.
- Fetch stored logs only when compact summaries are insufficient.
- Treat AgentShell JSON as the source of truth.

Current strategy/evidence snapshot: 17/17 strategy coverage, about 262 tokens/repair, and 22,112->4,459 tokens.
```

## Minimal Version

For smaller projects, this shorter instruction is enough:

```md
When AgentShell is available, prefer `agentshell manual --topic repair` when guidance is needed, `agentshell fix test --fast --compact` for supported failing-test repairs, `agentshell diagnose test --compact` when the fix path cannot apply, focused `agentshell read`/`find` for context, `agentshell verify test` for verification, and `agentshell run status --compact` for task state. Treat AgentShell JSON as the source of truth. Current strategy/evidence snapshot: 17/17 strategy coverage, about 262 tokens/repair, and 22,112->4,459 tokens.
```

## Benchmark Prompt

Generate a copyable prompt for checking whether an AGENTS.md-aware agent follows the AgentShell policy before noisy shell output:

```bash
npm run --silent adapter:generate -- --benchmark-prompts agents-md
```

## Scorecard

Run the prompt against `examples/failing-test-demo` or another disposable failing-test fixture, then score the run:

```bash
npm run --silent adapter:generate -- --scorecard agents-md
```

Strong runs call `agentshell start --compact` and `agentshell fix test --fast --compact` within the first two shell commands, verify with `agentshell verify test`, and avoid broad raw logs unless compact JSON is insufficient.

## MCP Status

Do not require MCP for the generic `AGENTS.md` adapter. MCP is a low-priority TODO and should be documented later only if a host needs schema-advertised tools instead of direct CLI calls.
