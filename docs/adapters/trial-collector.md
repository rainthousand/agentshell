# Adapter Trial Collector

Use the adapter trial collector when you have a real Codex, Claude Code, Cursor, Windsurf, or `AGENTS.md` run transcript and want to turn it into a scoreable AgentShell trial.

The collector is not a new scoring standard. It prepares evidence for `adapter:trial`, then embeds the same `agentshell.adapter-trial.v1` score report inside a collection report.

## Input

Start from:

```bash
examples/adapter-trial-collect.sample.json
```

Collector input can use either `events` or a simpler `commands` array. Command events may include `stdout`, `stderr`, `outputTokens`, `durationMs`, or `startedAt`/`finishedAt`.

If `outputTokens` is omitted, the collector estimates tokens from `stdout + stderr` using the project-wide `ceil(chars / 4)` convention.

```json
{
  "host": "codex",
  "fixture": "examples/failing-test-demo",
  "source": "manual-transcript",
  "events": [
    {
      "type": "command",
      "command": "agentshell start --compact",
      "stdout": "{\"ok\":true}",
      "durationMs": 120
    }
  ],
  "finalVerification": {
    "ok": true,
    "command": "agentshell verify test",
    "summary": "tests passed"
  }
}
```

## Generate Evidence

```bash
npm run --silent adapter:trial:collect -- --input examples/adapter-trial-collect.sample.json
npm run --silent adapter:trial:collect -- --input run-log.json --trial artifacts/adapter-trial.codex.json --report artifacts/adapter-trial-collect.codex.json --markdown artifacts/adapter-trial-collect.codex.md
```

Outputs:

- `--trial`: normalized `agentshell.adapter-trial.v1` input for the scorer.
- `--report`: collector report with protocol `agentshell.adapter-trial-collect.v1`.
- `--markdown`: human-readable score and evidence summary.

## Relationship To Scorecard

The scorecard defines what good adapter behavior means:

- AgentShell appears within the first two shell/tool commands.
- The run tries `agentshell fix test --fast --compact` before raw logs when the fixture fits.
- The run prefers compact AgentShell context and verification.
- The run records safety or rollback guidance.
- The run avoids noisy raw logs unless AgentShell output is insufficient.

The collector turns observed commands into the data needed to score those criteria consistently across hosts.

Use [Adapter Trial Suite](trial-suite.md) when you have multiple collected or scored runs and want one aggregate host comparison.
