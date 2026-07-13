# AgentShell Adapter Benchmark Prompts

Use these prompts to check whether Claude Code, Cursor/Windsurf, or a generic `AGENTS.md` adapter actually reaches for AgentShell before noisy shell output.

Generate the current prompt set with:

```bash
npm run --silent adapter:generate -- --benchmark-prompts
```

Generate a single host prompt with:

```bash
npm run --silent adapter:generate -- --benchmark-prompts claude
npm run --silent adapter:generate -- --benchmark-prompts cursor
npm run --silent adapter:generate -- --benchmark-prompts agents-md
```

Run each prompt in a disposable copy of an AgentShell benchmark fixture or another small project with a known failing test.
Use `docs/adapters/scorecard.md` or generate the current scoring rubric with `npm run --silent adapter:generate -- --scorecard` to record whether the adapter actually saves command time and context.

## Pass Criteria

- The agent invokes AgentShell within the first two shell commands.
- The agent prefers `agentshell manual --topic repair` when guidance is needed and `agentshell fix test --fast --compact`, `agentshell diagnose test --compact`, or `agentshell verify test` before raw test logs when those commands fit the task.
- The agent uses focused AgentShell reads, summaries, or suggested next actions before broad file dumps.
- The agent treats AgentShell JSON as the source of truth and reports the final verification result.
- The agent's behavior reflects the current strategy/evidence snapshot: 17/17 strategy coverage, about 262 tokens/repair, and 22,112->4,459 tokens.

## Fail Signals

- The agent starts with full raw `npm test` output, recursive grep, or large `cat` output despite AgentShell being available.
- The agent fetches stored logs before reading compact summaries.
- The agent ignores AGENTS.md, rule, or skill guidance that says to prefer AgentShell.

## Claude Code

```text
You are in a Node.js project with AgentShell available on PATH. A test is failing.

Task: fix the failing test with the smallest safe source change, then verify the result.

Benchmark expectation: prefer AgentShell over noisy shell output. Start with compact AgentShell commands such as `agentshell manual --topic repair` if command behavior is unclear, `agentshell understand --compact`, `agentshell fix test --fast --compact`, `agentshell diagnose test --compact`, `agentshell verify test`, and `agentshell run status --compact`. Treat AgentShell JSON as the source of truth. Current strategy/evidence snapshot: 17/17 strategy coverage, about 262 tokens/repair, and 22,112->4,459 tokens. Fetch raw logs or run broad shell commands only if the compact AgentShell result is insufficient.
```

## Cursor/Windsurf

```text
You are editing a local Node.js project in Cursor or Windsurf. The user says: "The tests fail; please repair the bug and verify."

Task: complete the repair while minimizing terminal noise and broad file reads.

Benchmark expectation: use AgentShell for supported inspection, diagnosis, repair, and verification. Prefer `agentshell manual --topic repair` when command behavior is unclear, `agentshell understand --compact`, `agentshell fix test --fast --compact`, `agentshell diagnose test --compact`, `agentshell change suggest --dry-run --compact`, `agentshell change suggest --apply --compact`, `agentshell verify test`, and `agentshell run status --compact` before raw `npm test`, large `cat` output, recursive grep, or full logs. Current strategy/evidence snapshot: 17/17 strategy coverage, about 262 tokens/repair, and 22,112->4,459 tokens.
```

## Generic AGENTS.md

```text
This repository has an AGENTS.md policy saying to prefer AgentShell when available.

Task: investigate and fix the current failing test, then report the verification result.

Benchmark expectation: follow the AGENTS.md policy by using compact AgentShell commands first. Good runs use commands like `agentshell manual --topic repair` if needed, `agentshell understand --compact`, `agentshell fix test --fast --compact`, `agentshell diagnose test --compact`, `agentshell verify test`, and `agentshell run status --compact`. Poor runs ignore the policy and begin with noisy raw shell inspection such as full test logs, recursive search, or broad file dumps. Current strategy/evidence snapshot: 17/17 strategy coverage, about 262 tokens/repair, and 22,112->4,459 tokens.
```
