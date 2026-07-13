# AgentShell Workflows

These playbooks turn AgentShell commands into repeatable agent routines.

| Workflow | Use when |
|---|---|
| [Onboarding](onboarding.md) | An agent enters a new checkout and needs the cheapest useful first pass. |
| [Log triage](log-triage.md) | A test or command emits too much output and the agent needs compact context first. |

The matching machine-readable entry points are:

```bash
agentshell manual --topic onboarding
agentshell manual --topic log-triage
```

Use `agentshell manual --full` only when the topic pages do not include the command you need.
