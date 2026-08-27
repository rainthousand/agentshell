# AgentShell TODO

## Current Candidate

- Core version: `1.0.0`.
- Public GitHub repository and immutable `v1.0.0` release: complete.
- Release assets, checksums, clean install/update/doctor/uninstall smoke: complete.
- Canonical product path: local CLI + Codex plugin on macOS.

## Post-v1.0 Reliability Work

- [x] Verify source and installed plugin content hashes, not version strings alone.
- [x] Make verification cache decisions explainable and safe for untracked files.
- [x] Enforce compact-output budgets in CI.
- [x] Keep savings, baseline, observed output, and unavailable model metrics distinct.
- [x] Keep fast, integration, release, and benchmark tests independently runnable.
- [x] Attribute every compact fix and verification to real operation IDs.
- [x] Gate compact semantic quality across JS/TS, Go, Python, and Java fixtures.
- [x] Measure privacy-safe command hit rate without inventing external telemetry.
- [x] Provide checkout-free update, doctor, rollback, hash, and release-integrity checks.
- [x] Enforce explicit cold-start, overhead, compact-token, and cache-speedup SLA contracts.
- [x] Show Today, Last 7 days, and All time verified savings in the Dashboard.
- [x] Ingest privacy-safe adapter fallback observations with idempotent deduplication.
- [x] Provide bounded generic exec with high-noise command profiles.
- [x] Read only incremental log deltas with rotation and truncation recovery.
- [x] Rank privacy-safe fallback observations into adaptive profile and fixture candidates.
- [x] Add an optional read-only local Runtime with TTL and fingerprint invalidation.
- [x] Gate compact output on semantic fidelity, extra-read risk, and measured Token reduction.
- [x] Add bounded multi-repository branch guards and aligned cross-repository search.
- [x] Add structured focused Go verification, including safe Mockey parameters.
- [x] Add conservative changed-file verification plans and generic boundary policies.
- [x] Add bounded multi-repository branch, dirty-state, and risk auditing.
- [x] Add ordered multi-file reads with partial results and a global output budget.
- [x] Add offline dependency-aware changed verification for Go and Node workspaces.
- [x] Add owned background jobs with rotating logs, delta cursors, timeout, and cancellation.
- [x] Add bounded Go symbol, SDK/module, and generated-code location.

## Completed Release Work

### GitHub Release Assets

- Published `v0.25.3` with the standalone binary, plugin ZIP, both checksums,
  and the release audit report.
- Downloaded the published binary and ZIP into clean temporary locations and
  verified both checksums.
- Verified the downloaded standalone reports version `0.25.3` after applying
  its executable bit, and confirmed toolchain attestation and size-budget evidence
  in the downloaded release report.
- Release: `https://github.com/rainthousand/agentshell/releases/tag/v0.25.3`.

The `v1.0.0` Core release is public and its downloadable assets have been
checksum-verified. No blocking release-engineering task remains for V1.0.

The failed `v0.25.1` and `v0.25.2` workflow tags have no GitHub Releases and
must not be presented as published versions. Their tags remain immutable audit
records of failed release attempts.

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

- Keep local builds compatible with Node `>=20 <23` and Bun `>=1.2 <1.4`.
- Keep GitHub Release CI fixed to the reproducible Node `20.20.2` and Bun
  `1.2.20` baseline.
- Keep build-report actual versions, supported ranges, and baseline versions
  explicit and independently verifiable.
- Keep CI, security scan, product readiness, plugin smoke, and package lifecycle
  checks blocking on release-contract drift.
- Re-run local release artifacts only when candidate code or bundled docs change.
- Keep Dashboard snapshot diagnostics explicit about freshness, skipped data,
  exact attribution, and unavailable values.

## Deferred

- Developer ID signing, Apple notarization, native PKG, and App Store/Desktop
  distribution. These belong to a future Desktop release, not V1.0 Core.
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
