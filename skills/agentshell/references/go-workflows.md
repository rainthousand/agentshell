# Go Workflows

AgentShell detects `go.mod` and `go.work`, summarizes Go failures from `go test -json`, and supports structured verification. AgentShell automatic Go source repair is not supported. Python and Java support in V1.0 is read-only discovery and summarization.

## Recommended Loop

1. `agentshell start --compact`
2. `agentshell diagnose test --compact`
3. Review the `_test.go` failure, sibling implementation references, and suggested target.
4. Apply a bounded hash-checked manual edit.
5. `agentshell verify test --compact`
6. `agentshell run status --compact`

Workspaces use explicit valid local module targets. Never broaden invalid or outside-workspace `go.work use` entries. Cache fingerprints include module metadata, Go source, `testdata`, `//go:embed` resources, and native build inputs; very large input sets run uncached.

## Verification Profiles

- `agentshell verify test --profile fast|race|coverage`: bounded test profiles.
- `agentshell verify build`: Go build.
- `agentshell verify lint`: `go vet`; optional external linters are not assumed installed.
- `agentshell verify format`: read-only `gofmt` comparison.
- `agentshell verify modules`: read-only module integrity and tidy-drift check.
- `agentshell verify benchmark --bench 'BenchmarkName'`: benchmark without normal tests; omit the pattern to match all benchmarks.
- `agentshell verify fuzz --fuzz FuzzName --duration 10s --package ./pkg`: requires an explicit target, finite duration, and one package.
- `agentshell verify generate`: preview `go generate -n`; it does not execute generators.
- `agentshell verify go --packages ./pkg/... --run '^TestName$' --tags integration --count 1 --timeout 30s --compact`: focused Go verification with structured selectors. Add `--mockey` only when the project requires the fixed `-gcflags=all=-N -l` preset.
- `agentshell go locate symbol <Name> --compact`: find a declaration using bounded `go list` metadata.
- `agentshell go locate dependency <module-or-import> --compact`: identify one concrete SDK or module without scanning the whole module cache.
- `agentshell go locate generated --kind pb|grpc|mock|wire --compact`: locate generated artifacts inside the workspace without exposing cache or home paths.

## Go Commands Through Exec

Use bounded execution for queries such as `go list ./...`, `go env GOMOD`, and `go mod graph`. Profiles also recognize:

- Runtime and dependencies: `go run`, `go get`, `go install`, `go mod download`, `go mod why`
- Analysis: `go tool cover`, `go tool pprof`, `govulncheck`, `staticcheck`, `golangci-lint run`
- Development tools: `dlv`, `mockgen`, and `wire`

Treat returned `profile.risk` as authoritative. Commands may use the network, mutate `go.mod` or `go.sum`, write generated files or installed binaries, execute target code, or wait for a debugger. Do not chain risky follow-up execution automatically.

## Repository Overrides

Use reviewed `.agentshell.json` version 1 overrides only for repository-specific `test`, `build`, or `lint` commands and supported test profiles. Invalid configuration is a blocker. Read-only or bounded workflows cannot be overridden. `doctor` reports Go toolchain readiness and optional, non-blocking `golangci-lint` and `goimports` availability.

Do not require MCP for Go workflows; the local AgentShell CLI/plugin flow is canonical.
