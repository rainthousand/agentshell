# AgentShell v0.25 Release Notes

v0.25 freezes the first complete local CLI and Codex plugin product surface. It keeps the CLI as the canonical runtime, makes installation and evidence collection usable outside the source checkout, and keeps MCP deferred as a thin compatibility adapter.

## Candidate Status

This document currently describes the v0.25 local release candidate. The remote GitHub Release and final downloadable-asset verification are not complete. Three fresh verified external-user tasks also remain required for the v1.0 evidence bar.

## Product Surface

- Native macOS menu-bar Dashboard with a user-level singleton lifecycle.
- Verified, operation-linked token and elapsed-time savings with workspace and global views.
- Metrics freshness, stale-run lifecycle labels, exact-attribution coverage, and explicit unavailable values when verified evidence does not exist.
- Atomic Codex install, update, rollback, doctor, and precise uninstall commands.
- Standalone macOS arm64 CLI, share ZIP, release report, and SHA256 checksum.
- Node 20-compatible standalone bundling with checks for unsupported `import.meta` residue and build-machine path leakage.
- Managed `~/.local/bin` PATH setup for supported shell profiles, kept idempotent across updates and removed only when still AgentShell-owned.
- Migration of legacy Dashboard launch jobs that still reference a source checkout.
- Installer-managed `com.agentshell.dashboard` LaunchAgent with login startup, abnormal-exit recovery, update restart, doctor checks, and ownership-safe uninstall.
- Permission-independent global Dashboard aggregation through atomic, path-free per-workspace snapshots.
- Isolated-HOME packaged lifecycle smoke covering install, update, doctor, and uninstall without touching the developer's Codex state.
- Maximum-compression ZIP creation with immediate archive integrity verification, SHA256 checksums, auditable Node/Bun builder metadata, and 100 MiB standalone / 40 MiB ZIP release budgets.
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
4. Run `npm run release:artifacts` on macOS arm64 and inspect checksum, archive verification, builder metadata, compression ratio, and size budgets in `release-report.json`.
5. Run `npm run package:lifecycle:smoke` against the packaged delivery directory.
6. Complete the remote Release only after its downloadable artifacts pass smoke and checksum verification.

Three fresh verified external-user tasks remain required before v1.0. MCP is deferred and is not a v0.25 dependency.
