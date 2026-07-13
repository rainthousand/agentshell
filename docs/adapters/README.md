# Agent Adapter Guides

These guides describe how other coding-agent environments can use AgentShell as a local structured CLI without requiring a first-class plugin.

Use AgentShell for the supported local workflow first:

| Need | Preferred command |
|---|---|
| Read focused repair guidance | `agentshell manual --topic repair` |
| Read focused workflow guidance | `agentshell manual --topic repair|plugin|benchmark|profile|onboarding|log-triage|reference` |
| Read the complete command map | `agentshell manual --full` |
| First combined workspace entry | `agentshell start --compact` or `agentshell entry --compact` |
| Understand a workspace | `agentshell understand --compact` |
| Search code | `agentshell find <query>` |
| Read focused context | `agentshell read <file> --lines A:B` or `agentshell read <file> --around <query>` |
| Repair a supported failing test | `agentshell fix test --fast --compact` |
| Preview the repair loop | `agentshell fix test --fast --dry-run --compact` |
| Diagnose when fix cannot apply | `agentshell diagnose test --compact` |
| Verify tests compactly | `agentshell verify test` |
| Inspect next action | `agentshell run next` |
| Inspect task state | `agentshell run status --compact` |

Adapter-specific notes:

- [Claude Code](claude-code.md)
- [Cursor and Windsurf](cursor-windsurf.md)
- [Generic AGENTS.md](agents-md.md)
- [Adapter benchmark prompts](benchmark-prompts.md)
- [Adapter scorecard](scorecard.md)
- [Adapter trial runs](trial-runs.md)
- [Adapter trial collector](trial-collector.md)
- [Adapter trial suite](trial-suite.md)
- [Adapter trial suite playbook](trial-suite-playbook.md)

## Package Output

The adapter generator can also write small, dependency-free rule packages for hosts that support project-local instruction files:

```bash
npm run --silent adapter:generate -- --package claude ./agentshell-claude-adapter
npm run --silent adapter:generate -- --package cursor ./agentshell-cursor-adapter
```

The Claude package writes `.claude/skills/agentshell/SKILL.md`. The Cursor/Windsurf package writes `.cursor/rules/agentshell.mdc` and `.windsurf/rules/agentshell.md`.

Each package includes a README and only static instruction files. It does not install AgentShell, download dependencies, start a server, or require MCP.

## Benchmark Prompts

Generate copyable prompts that evaluate whether an adapted agent uses AgentShell before noisy shell output:

```bash
npm run --silent adapter:generate -- --benchmark-prompts
npm run --silent adapter:generate -- --benchmark-prompts claude
npm run --silent adapter:generate -- --benchmark-prompts cursor
npm run --silent adapter:generate -- --benchmark-prompts agents-md
```

Use these prompts in a disposable copy of a benchmark fixture or a small project with a known failing test. A passing run should invoke AgentShell within the first two shell commands and prefer compact commands such as `agentshell manual --topic repair`, `agentshell fix test --fast --compact`, `agentshell diagnose test --compact`, or `agentshell verify test` before raw logs.

## Scorecard

Generate a reusable scoring rubric for real adapter trials:

```bash
npm run --silent adapter:generate -- --scorecard
npm run --silent adapter:generate -- --scorecard claude
npm run --silent adapter:generate -- --scorecard cursor
npm run --silent adapter:generate -- --scorecard agents-md
```

The scorecard evaluates first-command behavior, use of the fast repair path, compact context, verification, safety reporting, and noise control. Use `examples/failing-test-demo` as the default disposable fixture.

## Trial Reports

Score a recorded real host run and write JSON/Markdown artifacts:

```bash
npm run --silent adapter:trial -- --input trial.json
npm run --silent adapter:trial -- --input trial.json --report artifacts/adapter-trial.codex.json --markdown artifacts/adapter-trial.codex.md
npm run --silent adapter:trial -- --input examples/adapter-trial.sample.json
```

The trial report uses `agentshell.adapter-trial.v1` and records the final score, criterion-level reasons, output tokens, command count, and wall-clock duration.

Use the collector when starting from a real host transcript or command log:

```bash
npm run --silent adapter:trial:collect -- --input examples/adapter-trial-collect.sample.json
npm run --silent adapter:trial:collect -- --input run-log.json --trial artifacts/adapter-trial.codex.json --report artifacts/adapter-trial-collect.codex.json --markdown artifacts/adapter-trial-collect.codex.md
```

The collector report uses `agentshell.adapter-trial-collect.v1` and embeds the same `agentshell.adapter-trial.v1` score report.

Aggregate multiple scored or collected runs into one suite report:

```bash
npm run --silent adapter:trial:suite -- --manifest examples/adapter-trial-suite.sample.json
npm run --silent adapter:trial:suite -- --manifest suite.json --report artifacts/adapter-trial-suite.batch1.json --markdown artifacts/adapter-trial-suite.batch1.md
```

The suite report uses `agentshell.adapter-trial-suite.v1` and compares average score, strong/usable/weak counts, host-level totals, output tokens, duration, AgentShell command count, and noisy raw command count.

Recommended evaluation flow:

```text
collector -> trial scorecard -> suite aggregate -> PM/engineering report
```

## Current Strategy/Evidence Snapshot

The adapter guidance is aligned with the current repair strategy/evidence overview: 17/17 strategy coverage, about 262 tokens/repair, and output reduced from 22,112->4,459 tokens.

## Priority

The P3 adapter path is a prompt-and-documentation integration. Each agent should call the `agentshell` binary directly from its normal shell tool and treat returned JSON as the source of truth.

MCP remains a low-priority TODO. It may become useful later for hosts that prefer tool schemas over shell commands, but the current adapter guidance should not depend on MCP.

See [MCP Interface Draft](../mcp-interface.md) for the deferred minimal tool surface, schema mapping, lifecycle notes, and reasons to keep MCP behind the CLI/plugin adapter path for now.
