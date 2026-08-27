# Plugin Maintenance

Use this reference when installation, plugin activation, updates, rollback, or integration contracts are the task. Do not load it for routine project work.

## Status And Activation

- `agentshell plugin status --compact`: compare source manifest, personal marketplace, Codex plugin cache, and the cheapest next installation action.
- Use full `agentshell plugin status` only when individual checks are needed.
- `agentshell doctor`: verify the installed CLI and plugin hashes, runtime readiness, release integrity, project manifest, and state directory.

When `agentshell` is missing from `PATH`, keep the real project root as the working directory and resolve, in order:

1. `./bin/agentshell` in an AgentShell checkout
2. the newest `${CODEX_HOME:-$HOME/.codex}/plugins/cache/personal/agentshell/<version>/bin/agentshell`
3. `node src/cli.js` only inside a source checkout

Do not make the user's home directory the project root merely because the installed executable lives under it.

## Update And Recovery

- `agentshell update --dry-run`: preview update source, version, and integrity before mutation.
- `agentshell rollback --dry-run`: inspect the available rollback before changing installation state.
- Re-run `agentshell doctor` and `agentshell plugin status --compact` after installation or update.

Treat hash or manifest mismatches as installation problems, not reasons to bypass validation. Do not modify a remote repository, publish a release, or change marketplace state without an explicit request.

## Integration Contracts

- `agentshell schema list`: available stable JSON contracts.
- `agentshell schema get <name>`: inspect a focused contract for adapter or integration work.
- Use `agentshell schema get change-fill` before constructing a fill payload.

The local CLI/plugin path remains canonical. MCP is deferred and must not become an installation or runtime dependency.
