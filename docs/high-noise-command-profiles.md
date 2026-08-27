# High-noise command profiles

The generic execution path can use `src/core/high-noise-profiles.js` to recognize noisy engineering commands without retaining command arguments, paths, or raw output in telemetry.

Go profiles extend this contract across query, dependency, performance,
security, quality, debugging, and code-generation commands. Public metadata
includes `risk.level`, `mutatesWorkspace`, `network`, and `interactive`. Safe
defaults are inserted immediately after the matched prefix so flags do not
accidentally become package or profile operands.

## API

- `classifyHighNoiseCommand(command)` returns public profile metadata or `null`.
- `applyHighNoiseSafeDefaults(command, profile?)` returns an argv array plus the defaults it added. Explicit user flags always win.
- `summarizeHighNoiseOutput(profileOrCommand, output, { exitCode })` returns bounded failures, locations, status, and one next action.
- `listHighNoiseProfiles()` exposes the supported profile metadata for inspection.

Callers should execute the returned argv directly, without joining it into a shell string. The module never executes a process.

## Supported profiles

| Profile | Category | Bounded defaults |
| --- | --- | --- |
| `docker-logs`, `docker-compose-logs` | Container logs | Last 200 lines; no Compose color |
| `kubectl-logs` | Kubernetes logs | Last 200 lines; 15 second request timeout |
| `kubectl-describe`, `kubectl-get` | Kubernetes resources | 15 second request timeout |
| `make` | Build | Suppress recursive directory chatter |
| `cargo-test` | Test | No color; short compiler messages |
| `dotnet-test` | Test | No logo; minimal verbosity |
| `terraform-plan` | Infrastructure plan | No color/input; detailed exit code |
| `terraform-validate` | Infrastructure validation | JSON diagnostics; no color |
| `maven`, `gradle` | JVM build | Plain output and reduced transfer/warning noise |
| `ruff`, `mypy` | Python quality | Concise, non-pretty, coded diagnostics |
| `go-list`, `go-env`, Go module profiles | Go query/dependencies | Structured package, key, and module summaries |
| `go-tool-cover`, `go-tool-pprof` | Go performance | Coverage functions or bounded non-interactive top output |
| `govulncheck`, `staticcheck`, `golangci-lint-run` | Go quality/security | Structured findings and source locations |
| `dlv`, `mockgen`, `wire` | Go debug/generation | Explicit risk with bounded lifecycle or generated-file summaries |

Terraform plan exit code `2` is represented as `changed`, not `failed`. An omitted exit code produces `unknown`; the parser does not infer success from quiet output.

## Bounds

- At most 512 KiB of combined stdout/stderr is inspected. Oversized output keeps both the beginning and end.
- At most 8 failures and 8 source locations are returned.
- Failure messages are at most 240 characters.
- ANSI control sequences are removed.

The summary schema is `schemas/high-noise-profile-summary.schema.json`.
