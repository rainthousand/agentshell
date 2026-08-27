# Metrics And Trial Evidence

Use these commands for run state, product evaluation, and explicitly requested evidence. They are not substitutes for diagnosis.

## Run State

- `agentshell run next`: shortest next action.
- `agentshell run status --compact`: active run state, verification result, command count, rollback, and token estimate.
- `agentshell run latest --compact`: latest historical run summary.
- `agentshell run clear`: discard stale active state while retaining history.

## Metrics And Dashboard

- `agentshell metrics --compact [--limit N]`: recent output-cost summary.
- `agentshell metrics [--limit N]`: detailed event history for debugging.
- `agentshell dashboard`: native macOS menu-bar status surface, with browser fallback elsewhere. Use `--window` for the legacy floating window or `--browser` for the browser surface.
- `agentshell benchmark test`: compare raw test output with compact AgentShell output.

Dashboard context savings estimate tool output avoided; measured execution time covers AgentShell-observed execution. Unavailable Codex model tokens, reasoning tokens, and model latency must remain unavailable rather than being reported as zero or inferred as verified.

## Trial Export

1. Run `agentshell trial status` to check project root, supported tests, event freshness, and verification readiness.
2. Run `agentshell trial export --verify --rating 1-5` immediately after successful verification.
3. Review the redacted JSON before sharing it.

The export is AgentShell telemetry, not complete Codex session accounting. If export is not ready, report its actionable status and suggested commands rather than asking the user to infer missing state.
