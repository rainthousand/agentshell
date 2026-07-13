# Onboarding Workflow

Use this when an agent enters a local checkout and needs readiness, project shape, and the next action without spending context on broad shell output.

## Fast Path

```bash
agentshell start --compact
agentshell manual
agentshell manual --topic repair
agentshell run next
```

Expected result: compact JSON with runtime readiness, workspace shape, and a short next action. If `agentshell` is not on `PATH`, use `node src/cli.js <command>` from this checkout or `bin/agentshell <command>` from a plugin cache.

## When The Checkout Looks Unusual

```bash
agentshell doctor
agentshell understand --compact
agentshell run status --compact
```

Use `doctor` when Node, test scripts, state directory, or git readiness may be the problem. Use `understand --compact` when the agent needs package metadata and workspace shape without full changed-file listings.

## Rules

- Start with `agentshell start --compact` in a fresh checkout.
- Read focused manual topics before broad shell exploration when command behavior is unclear.
- Use `agentshell run next` and `agentshell run status --compact` to avoid following stale task state.
- Fall back to normal shell commands only when AgentShell does not support the action.
