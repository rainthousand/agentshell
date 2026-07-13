# Adapter Trial Runs

Use adapter trial reports to score real Codex, Claude Code, Cursor, Windsurf, or generic `AGENTS.md` runs against the adapter scorecard.

If you are starting from a real host transcript or command log, use [Adapter Trial Collector](trial-collector.md) first to normalize it into a trial JSON file.

## Input

Start from `examples/adapter-trial.sample.json` or create a small JSON file after a real run:

```json
{
  "host": "codex",
  "fixture": "examples/failing-test-demo",
  "commands": [
    { "command": "agentshell start --compact", "outputTokens": 180, "durationMs": 120 },
    { "command": "agentshell fix test --fast --compact", "outputTokens": 310, "durationMs": 850 },
    { "command": "agentshell verify test", "outputTokens": 160, "durationMs": 420 },
    { "command": "agentshell run status --compact", "outputTokens": 120, "durationMs": 80 }
  ],
  "finalVerification": {
    "ok": true,
    "command": "agentshell verify test",
    "summary": "tests passed; rollback command available in run status"
  },
  "notes": "No broad raw logs were needed."
}
```

Supported hosts are `codex`, `claude`, `cursor`, `windsurf`, `agents-md`, and `other`.

## Generate Reports

```bash
npm run --silent adapter:trial -- --input trial.json
npm run --silent adapter:trial -- --input trial.json --report artifacts/adapter-trial.codex.json --markdown artifacts/adapter-trial.codex.md
npm run --silent adapter:trial -- --input examples/adapter-trial.sample.json
```

The JSON output uses `agentshell.adapter-trial.v1`. The report records score, criterion-level reasons, command count, AgentShell command count, noisy raw command count, output tokens, and duration.

## Interpretation

- 85-100: strong adapter behavior.
- 65-84: usable adapter behavior, but prompt/rule wording likely needs tightening.
- Below 65: the host is still behaving like raw shell-first automation.

This measures host behavior, not only final correctness. A run can fix the test and still score poorly if it starts with broad raw logs or reconstructs state from noisy shell output instead of using AgentShell JSON.

Use [Adapter Trial Suite](trial-suite.md) when you want to compare multiple scored runs across hosts or fixtures.
