# Generic Execution

Use dedicated AgentShell commands when available. Use generic execution as a bounded escape hatch, not as a default shell replacement.

## Environment And Processes

- `agentshell which <command> --compact`: executable path and safe version discovery.
- `agentshell ps --compact`: focused development-process summary.
- `agentshell port list --compact [--port N]`: listening ports and relevant processes.
- `agentshell kill suggest --pid N --compact` or `--port N --compact`: preview a stop command and its risk; it does not silently terminate a process.
- `agentshell du --compact`: bounded disk usage with generated and noisy-directory hints.
- `agentshell job start --timeout-ms N -- <executable> [args...]`: run a long task as an owned background process. Poll with `job status`, consume only new output with `job delta`, and stop it with `job cancel`.

Job state and rotating logs remain under `<workspace>/.agentshell/jobs`. Keep the returned job ID and cursor; never infer or edit state files directly.

## Bounded Escape Hatch

`agentshell exec --compact -- <command...>` executes without shell interpolation, caps time and output, and returns a local `logRef` instead of unbounded stdout or stderr. Profiles recognize common build, test, Docker, Kubernetes, infrastructure, and language-tool commands.

Before execution:

1. Inspect the returned or documented risk category.
2. Prefer previews or read-only subcommands.
3. Surface network access, filesystem mutation, dependency changes, arbitrary code execution, long-running watches, debugger waits, and process termination.
4. Retrieve a bounded `logRef` tail only when the compact result is insufficient.

## Coverage Feedback

- `agentshell coverage --compact`: measured command hit rate and common replacement opportunities.
- `agentshell coverage observe --source codex -- <command...>`: record only an unsupported fallback command family. AgentShell must not retain arguments, paths, output, or event identifiers.
- Adapter integrations may batch privacy-safe fallback families through `npm run coverage:adapter:ingest` when developing AgentShell itself.

If AgentShell cannot express the action, ordinary shell commands are allowed. Keep their scope, output, and duration bounded, and do not represent fallback execution as verified AgentShell savings.
