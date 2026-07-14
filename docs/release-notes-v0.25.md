# AgentShell v0.25 Release Notes

v0.25 freezes the first complete local CLI and Codex plugin product surface. It keeps the CLI as the canonical runtime, makes installation and evidence collection usable outside the source checkout, and keeps MCP deferred as a thin compatibility adapter.

## Product Surface

- Native macOS menu-bar Dashboard with a user-level singleton lifecycle.
- Verified, operation-linked token and elapsed-time savings with workspace and global views.
- Atomic Codex install, update, rollback, doctor, and precise uninstall commands.
- Standalone macOS arm64 CLI, share ZIP, release report, and SHA256 checksum.
- Redacted `trial status` and `trial export --verify` evidence flow for external Beta users.
- Beta funnel aggregation with activation, valid-export, verification, token, and timing outcomes.

## Agent Workflow

The recommended path remains:

```bash
agentshell start --compact
agentshell fix test --fast --compact
# or, when an automatic change is not safe
agentshell diagnose test --compact
agentshell verify test
```

Related-test-file verification runs before the full test command when AgentShell has a safe cached target. Task status, rollback guidance, and compact metrics remain available through `run status`, `undo`, and `metrics`.

## Protocol And Release Contracts

The release preserves the stable `agentshell.plugin-release-local.v1`, `agentshell.plugin-smoke.v1`, `agentshell.plugin-validate.v1`, and `agentshell.cold-start-benchmark.v1` contracts. Schema discovery remains available through `agentshell schema list` and `agentshell schema get <name>`.

The supported repair surface includes the `typescript-property-suggestion` strategy and the conservative JavaScript/TypeScript strategies documented in the manual. Protocol migrations follow `docs/protocol-versioning.md`.

## Evidence

The checked-in fixture suite preserves 51/51 successful repair runs and the historical 22,112 versus 4,459 estimated-token comparison. Batch 5 real-project evidence recorded a 96.3% reduction in its scoped fix-first comparison. Batch 7 repeats the fix-first path. All nine fix-first runs passed. These figures are scoped engineering evidence, not full Codex session token accounting.

## Release Checklist

1. Run `npm test` on Node 20 and 22 for Ubuntu and macOS.
2. Run `npm run security:scan` and `npm run product:readiness -- --heavy --dry-run --compact`.
3. Run `npm run release:gate -- --tag v0.25.0`.
4. Run `npm run release:artifacts` on macOS arm64 and verify the generated checksum.
5. Create the `v0.25.0` tag only after the external release artifacts pass smoke verification.

External-user evidence remains required before v1.0. MCP is not a v0.25 dependency.
