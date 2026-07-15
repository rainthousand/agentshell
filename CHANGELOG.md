# Changelog

All notable changes to AgentShell are documented here.

## Unreleased

## 0.25.2 - 2026-07-16

- Publish the standalone macOS executable as a verified GitHub Release Asset instead of tracking the 85 MB build output in Git.
- Make clean-clone CI use an explicit test-only launcher while delivery and release jobs continue to build and verify the real Node SEA executable.

## 0.25.1 - 2026-07-15

- Move the native Dashboard into an installer-managed, crash-recovering menu-bar service.
- Aggregate verified savings through permission-independent, path-free workspace snapshots.
- Add bounded snapshot retention, corruption quarantine, lifecycle diagnostics, and migration seeding.
- Pin and attest the Node 20.20.2/Bun 1.2.20 release toolchain and verify delivery artifacts in CI.
- Harden install, update, rollback, doctor, packaged lifecycle, checksums, and release size budgets.

## 0.25.0 - 2026-07-14

- Add a user-level singleton lifecycle for the native Dashboard.
- Add operation-linked metrics attribution, measurement windows, reset, and export.
- Add atomic install/update, automatic rollback, doctor, and precise uninstall flows.
- Add cross-platform CI, release gates, reproducible share archives, and checksums.
- Add redacted external Beta evidence export, funnel aggregation, and workspace-wide verified metrics.
- Add a standalone macOS arm64 CLI and Codex setup flow that does not depend on a source checkout.

## 0.24.0 - 2026-07-13

- Initial private GitHub release of the AgentShell CLI and Codex plugin.
