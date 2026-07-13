# AgentShell Adapter for Claude Code

Claude Code can use AgentShell through its normal shell command runner. No dedicated extension is required for the P3 adapter path.

## Installation Check

From the target workspace, run:

```bash
agentshell manual --topic repair
```

If the command is unavailable while developing AgentShell locally, run `npm link` from the AgentShell checkout and retry.

## Recommended Prompt Policy

Add the following guidance to the project or user-level Claude Code instructions:

```md
When AgentShell is available, prefer it for supported coding-agent workflows.

- Use `agentshell understand --compact` before broad project inspection; run full `agentshell understand` only when paths or changed file names are needed.
- Use `agentshell find <query>` before raw search when compact JSON is enough.
- Use `agentshell read <file> --lines A:B` or `agentshell read <file> --around <query>` for focused context.
- For supported failing-test repairs, run `agentshell fix test --fast --compact` first.
- Use `agentshell fix test --fast --dry-run --compact` when a preview is required before applying.
- If `fix` cannot safely apply a suggestion, run `agentshell diagnose test --compact`.
- Prefer `agentshell change suggest --dry-run --compact` before applying generated edits.
- Apply generated edits with `agentshell change suggest --apply --compact` only when the preview is sufficient.
- Use `agentshell verify test`, `agentshell run next`, and `agentshell run status --compact` for verification and task state.
- Fetch stored logs only when summaries are insufficient.
- Treat AgentShell JSON as the source of truth.

Current strategy/evidence snapshot: 17/17 strategy coverage, about 262 tokens/repair, and 22,112->4,459 tokens.
```

## Package Output

Generate a project-local Claude Code skill package:

```bash
npm run --silent adapter:generate -- --package claude ./agentshell-claude-adapter
```

The package writes `.claude/skills/agentshell/SKILL.md` plus a README. Copy the generated directory contents into the root of the project where Claude Code should use AgentShell.

## Benchmark Prompt

Generate a copyable prompt for checking whether Claude Code uses AgentShell before noisy shell output:

```bash
npm run --silent adapter:generate -- --benchmark-prompts claude
```

## Scorecard

Run the prompt against `examples/failing-test-demo` or another disposable failing-test fixture, then score the run:

```bash
npm run --silent adapter:generate -- --scorecard claude
```

Strong runs call `agentshell start --compact` and `agentshell fix test --fast --compact` within the first two shell commands, verify with `agentshell verify test`, and avoid broad raw logs unless compact JSON is insufficient.

## Failing-Test Workflow

1. Run `agentshell understand --compact` if the workspace shape is unknown.
2. Run `agentshell fix test --fast --compact`.
3. If a preview is required, use `agentshell fix test --fast --dry-run --compact` before the apply path.
4. If `fix` reports that it cannot safely apply, run `agentshell diagnose test --compact`.
5. Inspect `fixPlan`, `changeTemplate`, `verification`, `focusedReads`, `implementationReads`, and `suggestedNextActions`.
6. Use `agentshell change suggest --dry-run --compact` when the generated template is clear.
7. Apply with `agentshell change suggest --apply --compact`, `agentshell change fill <template.json> <fill.json> --apply`, or `agentshell change <change.json>` as appropriate.
8. Run `agentshell verify test`.
9. Run `agentshell run status --compact` to check pass/fail state, estimated output cost, and rollback guidance.

## MCP Status

MCP is a low-priority TODO for this adapter. Claude Code should use the local `agentshell` CLI directly until there is a clear host-side benefit to exposing the same operations as MCP tools.
