# Generic Compact Exec

`agentshell exec --compact -- <command...>` is the bounded fallback for noisy commands that do not yet have a native AgentShell adapter.

Example:

```bash
agentshell exec --compact -- docker compose logs api
```

The response contains the exit code, duration, timeout and truncation state, a short output preview, recognized error evidence with file and line locations, a local `logRef`, and structured next actions. It does not inline the raw log.

## Execution Safety

- The executable and arguments are passed directly to the operating system with `shell: false`.
- Shell metacharacters, variables, pipes, redirects, and substitutions are literal arguments by default.
- A shell can still be invoked explicitly, such as `-- sh -c ...`; the response marks this with `explicitShellExecutable: true` because the caller has deliberately crossed that boundary.
- Commands time out after 30 seconds by default and their process group is terminated. Callers may request a bounded timeout up to five minutes.
- Captured stdout and stderr share a 512 KiB default cap and a 4 MiB hard cap. Output beyond the cap is drained but discarded, and `truncated` becomes true.

## Privacy

Command arguments and environment values are not returned as command metadata. Bounded raw output is stored only in local AgentShell state behind `logRef`; common bearer tokens, API keys, passwords, secrets, and URL credentials are redacted before storage. The compact preview and evidence use the same redacted text.

Redaction is defense in depth, not a complete secret classifier. Avoid commands that intentionally print credentials. AgentShell never uploads the captured output.

## Compact Contract

The summary preview is limited to 900 characters and eight selected lines. At most five error evidence records and three next actions are returned. The full success contract is defined in `schemas/exec.schema.json`.
