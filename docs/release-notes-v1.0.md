# AgentShell V1.0 Release Notes

AgentShell V1.0 is the first stable local CLI and Codex plugin release for
agent-native coding workflows on Apple silicon Macs.

## Stable Product Contract

- Compact, versioned JSON for project inspection, search, bounded reads,
  diagnosis, conservative repair, verification, and rollback.
- A Codex plugin that activates the AgentShell-first workflow in new tasks.
- An optional Beta menu-bar Dashboard with verified context and time savings,
  freshness, and attribution coverage.
- Atomic install, stable-channel update, rollback, doctor, support export, and
  precise uninstall flows.
- A standalone macOS arm64 CLI so end users do not need Node.js or Bun.

## Distribution Gate

The public `v1.0.0` Core release contains the GitHub source, Codex plugin ZIP,
standalone CLI, SHA-256 checksums, and release audit report. It does not publish
a native PKG or use App Store distribution, so Apple Developer credentials are
not a release requirement. Checksums, package lifecycle smoke, clean-machine
acceptance, archive integrity, size budgets, and path-leak scanning remain
blocking gates.

The standalone CLI and optional menu-bar Dashboard use ad-hoc local signing.
They are not represented as Apple-notarized software. A separately branded
Desktop release remains deferred until Developer ID signing and notarization are
available.

## Measurement Boundary

`Verified context saved` estimates tool-output context avoided using the
documented character-based estimator. It is not OpenAI billing data, total Codex
session usage, model thinking time, or a cross-machine performance promise.

## Deferred Scope

External-user evidence remains an optional post-release learning channel. MCP,
native PKG/App Store distribution, Windows/Linux native distribution, and
broader automatic repair strategies do not block the stable Core plugin.
