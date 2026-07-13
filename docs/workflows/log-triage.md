# Log Triage Workflow

Use this when raw terminal output is too large for an agent to read cheaply.

## Fast Path

```bash
agentshell verify test
agentshell diagnose test --compact
agentshell run status --compact
```

Expected result: a compact failure summary, related file hints, log references, and next actions.

## When More Output Is Needed

```bash
agentshell verify test --tail 120
agentshell log get <logRef> --tail 120
agentshell read <file> --around <query>
```

Fetch a bounded log tail only after the summary is insufficient. Use focused reads near the failing symbol or assertion before broad file dumps.

## Rules

- Prefer summaries and `logRef` before raw logs.
- Keep log tails bounded.
- Use `agentshell read --around` or `--lines` for the smallest useful file context.
- Use `agentshell manual --topic log-triage` when an adapter or plugin needs machine-readable guidance.
