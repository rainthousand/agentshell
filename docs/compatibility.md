# V1.0 compatibility

## Supported

- macOS on Apple Silicon (`darwin-arm64`).
- macOS 13 Ventura or newer.
- Codex desktop with local plugin support, or a Codex CLI build exposing the
  same plugin contract. V1.0 is validated against Codex CLI `0.144.2`; this is
  a tested baseline, not a claimed upstream compatibility guarantee.
- The AgentShell V1.0 standalone release package and its bundled Codex plugin.
- Local JavaScript and TypeScript projects with an npm-compatible `package.json`
  test script for managed test diagnosis, supported repair, and verification.
- Local Python and Java projects for compact project inspection: dependency
  manifests, config entrypoints, test discovery, imports, symbols, file info,
  and changed-file/reference search. Python and Java commands do not execute
  tests or apply automatic repairs in V1.0.
- Local Go modules with `go.mod` and local multi-module workspaces with
  `go.work`. Workspace verification names every valid local module target
  explicitly; invalid or outside-workspace `use` entries are reported.
- Go test verification uses `go test -json` internally to summarize package,
  test, subtest, build, and panic failures while retaining raw output behind a
  bounded `logRef`.
- Go cache fingerprints cover `go.mod`, `go.sum`, Go source, `testdata`,
  `//go:embed` resources, and native build inputs. All valid `go.work` modules
  participate; oversized input sets run uncached.
- Go test, build, `go vet` lint, read-only `gofmt` comparison, and read-only
  module integrity/tidy-drift verification.
- Fast, race, and coverage test profiles; bounded benchmark and fuzz workflows;
  and read-only `go generate -n` preview. Fuzz requires an explicit target,
  finite duration, and one package.
- Version 1 `.agentshell.json` Go command and built-in-profile overrides for
  repositories that use reviewed wrappers. Invalid configuration is surfaced
  rather than silently interpreted.

The packaged standalone CLI is the supported user runtime. End users do not need
Node.js, Bun, npm, a source checkout, or the developer's home directory to run
AgentShell. Node.js 20 or newer and Bun 1.2.20 are release-build requirements for
maintainers, not installation requirements for users.

Go verification requires a working `go` executable on `PATH`. The
`agentshell doctor` command reports the Go version and blocks Go-module
readiness when the toolchain is unavailable. `golangci-lint` and `goimports`
are optional, non-blocking doctor checks; AgentShell does not install them.

## Not supported in V1.0

- Intel Macs (`darwin-x64`), Windows, or Linux standalone installation.
- macOS 12 or older.
- Codex builds without local plugin support.
- Remote execution, hosted telemetry, MCP, or shared team services.
- Automatic repair outside the strategies explicitly reported by AgentShell.
- Automatic Go source repair. Go diagnosis may identify related test and
  implementation files, but source edits remain an explicit, reviewed,
  hash-checked agent action.
- Automatic Python or Java test execution, diagnosis, or source repair. Python
  and Java support in V1.0 is read-only discovery and summarization.
- Unbounded or target-free Go fuzzing, implicit generator execution, mutation by
  `verify format`, or replacement of repository `go.mod`/`go.sum` files by
  `verify modules`.
- Execution of `go.work` modules outside the detected workspace.

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
