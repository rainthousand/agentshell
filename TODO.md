# AgentShell TODO

## Current Candidate

- Version: `0.25.3+codex.20260716020843`.
- Git import: complete.
- Private GitHub repository push: complete.
- Local standalone, release report, share ZIP, checksum/archive verification,
  and packaged install/update/doctor/uninstall smoke: complete.
- Canonical product path: local CLI + Codex plugin on macOS.

## Completed Release Work

### GitHub Release Assets

- Published `v0.25.3` with the standalone binary, plugin ZIP, both checksums,
  and the release audit report.
- Downloaded the published binary and ZIP into clean temporary locations and
  verified both checksums.
- Verified the downloaded standalone reports version `0.25.3` after applying
  its executable bit, and confirmed strict toolchain and size-budget evidence
  in the downloaded release report.
- Release: `https://github.com/rainthousand/agentshell/releases/tag/v0.25.3`.

No blocking release-engineering task remains for v0.25.3.

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
