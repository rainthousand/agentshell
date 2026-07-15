# AgentShell TODO

## Current Candidate

- Version: `0.25.3+codex.20260716020843`.
- Git import: complete.
- Private GitHub repository push: complete.
- Local standalone, release report, share ZIP, checksum/archive verification,
  and packaged install/update/doctor/uninstall smoke: complete.
- Canonical product path: local CLI + Codex plugin on macOS.

## Active Release Work

### P0: Publish And Verify The GitHub Release

- Publish the v0.25.3 GitHub Release with the approved artifacts and checksums.
- Download every published asset into a clean location.
- Verify downloaded checksums, ZIP integrity, size budgets, and manifest data.
- Run the packaged lifecycle smoke against the downloaded delivery package.
- Record the final Release URL and downloaded-asset verification report.

This work changes remote state and should run only when explicitly requested.

### Post-release: Optional External Evidence

- Collect verified AgentShell tasks when willing external users are available.
- Ask each user to run `agentshell trial status`, then
  `agentshell trial export --verify --rating 1-5` immediately after a task.
- Review redaction and verification status before accepting an export.
- Aggregate activation, successful verification, token, timing, and rating
  outcomes without treating AgentShell telemetry as full Codex accounting.

There is no minimum-user release gate. This evidence is useful for post-release
learning and broader claims, but it does not block v0.25.3 or v1.0.

## Release Maintenance

- Keep Node `20.20.2` and Bun `1.2.20` release-toolchain enforcement green.
- Keep CI, security scan, product readiness, plugin smoke, and package lifecycle
  checks blocking on release-contract drift.
- Re-run local release artifacts only when candidate code or bundled docs change.
- Keep Dashboard snapshot diagnostics explicit about freshness, skipped data,
  exact attribution, and unavailable values.

## Deferred

- MCP productization, host packaging, and broader mutating tool coverage.
- Native Windows and Linux Dashboard/status-bar applications.
- Cloud telemetry, hosted execution, and account-dependent services.
- New broad automatic-repair categories without real failure evidence.

These items do not block v0.25.3 or v1.0 of the macOS local CLI/plugin product.

## Completed Product Foundation

The following major tracks are complete and are no longer active TODOs:

- Compact project inspection, bounded reads/search, verification, and log refs.
- Conservative JS/TS repair strategies, hash-checked changes, undo, and rollback.
- Codex plugin activation, validation, cache install, managed update, and doctor.
- Non-developer share package with install/check/update/uninstall commands.
- Native macOS menu-bar Dashboard and permission-independent global snapshots.
- Metrics v2, verified savings, freshness, attribution, and trial evidence export.
- Benchmark, strategy coverage, real-project evaluation, and product-readiness gates.
- Reproducible local release artifacts and isolated-HOME lifecycle verification.

Detailed implementation history remains available in Git history and release
notes. It is intentionally not duplicated in this active TODO list.
