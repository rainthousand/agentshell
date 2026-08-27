# Focused Go verification

`agentshell verify go` is a narrow Go test workflow for selecting packages and tests without accepting an arbitrary shell command. This module supplies the implementation contract; public CLI registration is intentionally separate.

## Intended command

```bash
agentshell verify go \
  --packages ./internal/api,./internal/store \
  --run '^Test(Create|Update)$' \
  --tags integration,linux \
  --count 1 \
  --timeout 90s \
  --mockey \
  --compact
```

`--packages` and `--package` may be repeated. `--tags` and `--tag` accept comma-separated values. With no package selector, the safe default is `./...`.

## Safety contract

- The core creates an argv array and starts `go` with `shell: false` through `runBoundedProcess`.
- Package patterns are restricted to `.` / `./...`-style local patterns and import paths belonging to a `go.mod` or in-root `go.work` member. Absolute paths, URI forms, backslashes, traversal segments, and workspace members outside the project root are rejected.
- Test regexes are single-line and bounded to 256 characters.
- Build tags use a restricted identifier grammar and are passed as one `-tags=` argument.
- `count` is an integer from 0 through 1000.
- Explicit test timeouts are positive Go durations no longer than four minutes. The process receives a five-second termination grace period.
- `--mockey` maps only to the fixed argv element `-gcflags=all=-N -l`. It does not accept user-provided compiler flags.
- Captured output is byte-bounded, redacted, stored under a local `logRef`, and represented inline only by a compact failure summary.

## Module interfaces

```js
planGoFocusedVerify(options)
runGoFocusedVerify(root, options)
parseVerifyGoArgs(args)
verifyGo(root, options)
verifyGoCommand(root, args)
```

The success response uses `agentshell.verify-go.v1` and includes the literal executable and argument array, selected scope, duration, exit code, timeout and truncation state, a bounded failure summary, and a local log reference. A non-zero test exit is a valid response with `ok: false`; invalid input returns the standard AgentShell failure envelope.
