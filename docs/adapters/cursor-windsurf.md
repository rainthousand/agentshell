# AgentShell Adapter for Cursor and Windsurf

Cursor and Windsurf can use AgentShell through their normal terminal or agent shell command execution. The P3 adapter path is instruction-based: teach the agent when to call `agentshell`, then let it consume compact JSON output.

## Installation Check

In the workspace being edited, run:

```bash
agentshell manual --topic repair
```

For local AgentShell development, run `npm link` from the AgentShell checkout if the binary is not on PATH.

## Recommended Rules

Place this guidance in the editor's project rules, memories, or agent instructions:

```md
Use AgentShell for supported local coding workflows when the `agentshell` binary is available.

- Prefer `agentshell understand --compact` for broad project shape; run full `agentshell understand` only when paths or changed file names are needed.
- Prefer `agentshell find <query>` and focused `agentshell read` calls over noisy terminal output.
- For failing tests, start with `agentshell fix test --fast --compact`.
- Use `agentshell fix test --fast --dry-run --compact` when reviewing the proposed repair first.
- Fall back to `agentshell diagnose test --compact` when `fix` cannot safely apply.
- Prefer compact summaries before fetching logs.
- Use `agentshell verify test` after edits.
- Use `agentshell run next` for the next recommended action.
- Use `agentshell run status --compact` for current task state and rollback guidance.
- Use hash-checked AgentShell change commands when applying structured edits.

Current strategy/evidence snapshot: 17/17 strategy coverage, about 262 tokens/repair, and 22,112->4,459 tokens.
```

## Package Output

Generate project-local Cursor and Windsurf rules:

```bash
npm run --silent adapter:generate -- --package cursor ./agentshell-cursor-adapter
```

The package writes `.cursor/rules/agentshell.mdc`, `.windsurf/rules/agentshell.md`, and a README. Copy the generated directory contents into the root of the project where the editor agent should use AgentShell.

## Benchmark Prompt

Generate a copyable prompt for checking whether Cursor or Windsurf uses AgentShell before noisy shell output:

```bash
npm run --silent adapter:generate -- --benchmark-prompts cursor
```

## Scorecard

Run the prompt against `examples/failing-test-demo` or another disposable failing-test fixture, then score the run:

```bash
npm run --silent adapter:generate -- --scorecard cursor
```

Strong runs call `agentshell start --compact` and `agentshell fix test --fast --compact` within the first two shell commands, verify with `agentshell verify test`, and avoid broad raw logs unless compact JSON is insufficient.

## Suggested Flow

For a normal failing-test task:

```bash
agentshell understand --compact
agentshell fix test --fast --compact
agentshell verify test
agentshell run status --compact
```

If the one-command repair cannot apply safely:

```bash
agentshell diagnose test --compact
agentshell change suggest --dry-run --compact
agentshell change suggest --apply --compact
agentshell verify test
agentshell run status --compact
```

Use `agentshell log get <logRef> --tail N` only when the compact diagnosis or verification summary is not enough.

## MCP Status

MCP remains a low-priority TODO for Cursor and Windsurf. Direct CLI usage is the preferred adapter mechanism for now because it works with existing shell execution and does not require a separate server lifecycle.
