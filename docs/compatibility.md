# V1.0 compatibility

## Supported

- macOS on Apple Silicon (`darwin-arm64`).
- macOS 13 Ventura or newer.
- Codex desktop with local plugin support, or a Codex CLI build exposing the
  same plugin contract. V1.0 is validated against Codex CLI `0.144.2`; this is
  a tested baseline, not a claimed upstream compatibility guarantee.
- The AgentShell V1.0 standalone release package and its bundled Codex plugin.
- Local projects with an npm-compatible `package.json` test script for managed
  test diagnosis, repair, and verification.

The packaged standalone CLI is the supported user runtime. End users do not need
Node.js, Bun, npm, a source checkout, or the developer's home directory to run
AgentShell. Node.js 20 or newer and Bun 1.2.20 are release-build requirements for
maintainers, not installation requirements for users.

## Not supported in V1.0

- Intel Macs (`darwin-x64`), Windows, or Linux standalone installation.
- macOS 12 or older.
- Codex builds without local plugin support.
- Remote execution, hosted telemetry, MCP, or shared team services.
- Automatic repair outside the strategies explicitly reported by AgentShell.

## Acceptance boundary

The clean-machine gate uses an unpacked release directory supplied through
`--package-dir`. It runs with a temporary `HOME`, `USERPROFILE`, and `CODEX_HOME`,
and does not read or modify the developer's Codex installation. Success requires
install, doctor, update, Dashboard status, and uninstall to complete, with no
managed CLI, plugin, install record, or LaunchAgent file left behind.

Real LaunchAgent loading is validated separately by installer/service tests on a
normal supported macOS account. The isolated acceptance test verifies that this
service is explicitly skipped rather than accidentally touching the logged-in
user's service domain.
