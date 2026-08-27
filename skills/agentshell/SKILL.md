---
name: agentshell
description: Use AgentShell when a coding task benefits from compact JSON project inspection, code search, bounded file reads, command execution, or summarized verification. Prefer it over noisy ad hoc shell commands when the `agentshell` CLI is available.
---

# AgentShell

AgentShell is a structured local CLI for compact project inspection and verification. This file is only the runtime router; load one focused reference when needed.

## Activation Contract

1. Work from the real project root, never `$HOME` by default.
2. Prefer the newest Codex plugin-cache launcher, then checkout `./bin/agentshell`, then `agentshell` on `PATH`. Keep the project root as cwd.
3. Run `agentshell start --compact` early.
4. Before completion, run `agentshell verify test --compact` when a supported test script exists.
5. Close with `agentshell run status --compact`.

The local CLI/plugin flow is canonical. MCP is deferred and must not be required or started.

## First Pass

1. `agentshell start --compact`
2. Inspect with a dedicated compact command or bounded read.
3. Use `agentshell fix test --fast --compact` for supported failing tests.
4. `agentshell verify test --compact`
5. `agentshell run status --compact`

## Workflow Router

- Project entry and change impact: [core-workflow.md](references/core-workflow.md)
- Search, files, symbols, and logs: [search-and-read.md](references/search-and-read.md)
- Tests, diagnosis, edits, and undo: [verify-and-repair.md](references/verify-and-repair.md)
- Go modules, profiles, tools, and risk: [go-workflows.md](references/go-workflows.md)
- Unsupported commands, processes, ports, and coverage: [generic-exec.md](references/generic-exec.md)
- Run state, metrics, dashboard, benchmark, and trial evidence: [metrics-and-trial.md](references/metrics-and-trial.md)
- Plugin status, installation, update, rollback, and schemas: [plugin-maintenance.md](references/plugin-maintenance.md)
- Safety, risk metadata, fallback, and edit invariants: [safety-and-fallback.md](references/safety-and-fallback.md)

Treat AgentShell JSON and risk metadata as authoritative. Keep MCP deferred; the local CLI/plugin flow is canonical.
