# Go command profiles

AgentShell keeps managed `verify` commands for tests, builds, lint, format,
modules, benchmarks, fuzzing, and generator preview. Other common Go tooling is
handled through the bounded generic executor:

```bash
agentshell exec --compact -- <go-command...>
```

The executor never invokes a shell implicitly. It applies only compatible safe
defaults, uses a 30 second default timeout, caps captured output, redacts common
secrets, and stores bounded raw output locally behind a `logRef`.

## Covered families

| Family | Commands | Main summary |
| --- | --- | --- |
| Query | `go list`, `go env` | Packages and environment key names, never environment values |
| Execution | `go run` | Process failures and Go source locations |
| Dependencies | `go get`, `go install`, `go mod download`, `go mod graph`, `go mod why` | Module changes, graph nodes, reasons, and failures |
| Performance | `go tool cover`, `go tool pprof` | Coverage totals/functions and top hot functions |
| Quality/security | `govulncheck`, `staticcheck`, `golangci-lint run` | Vulnerabilities, diagnostics, rule IDs, and locations |
| Debug/generate | `dlv`, `mockgen`, `wire` | Debug lifecycle, generated files, failures, and locations |

`pprof` receives `-top -nodecount=10` when the caller did not choose another
presentation mode, preventing an unattended agent from entering the interactive
prompt. An explicit `-http` remains explicit and is reported as interactive.

## Risk contract

Every matched result includes `risk.level`, `mutatesWorkspace`, `network`, and
`interactive`. `go get`, module download, generators, installed tools, target
programs, and debuggers can have effects beyond terminal output. AgentShell
reports those effects but does not turn them into hidden follow-up commands.
Missing optional tools are reported as executable failures; AgentShell never
downloads or installs them automatically.
