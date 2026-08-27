# Safety And Fallback

Treat AgentShell JSON, especially `summary` and `suggestedNextActions`, as the source of truth. Fetch full logs only when compact evidence is insufficient.

## Bounded Evidence

- Keep reads and searches bounded. Prefer a `logRef` or `diffRef` over large inline output.
- Never invent an `expectedHash`. Re-read after `HASH_MISMATCH`, preview generated changes, and keep `agentshell undo` available.
- Do not automatically repair Go source. Review diagnosis and apply a bounded hash-checked edit.

## Risk

Treat command risk metadata as authoritative. Surface network access, dependency or module mutation, generated files, installed binaries, arbitrary code execution, debugger waits, and process termination before follow-up execution.

Keep Go format, module integrity, and generator verification read-only. Run fuzzing only with an explicit target, finite duration, and one local package.

## Fallback

Use the narrowest dedicated AgentShell command first. Use `agentshell exec --compact -- <command...>` when no dedicated command exists. Fall back to ordinary shell commands only when AgentShell cannot support the action, and keep fallback scope, duration, and output bounded.

The local CLI/plugin flow is canonical. MCP is deferred and must not be required or started.
