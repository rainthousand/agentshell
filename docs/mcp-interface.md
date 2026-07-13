# MCP Interface Draft

This is a low-priority interface note for AgentShell's MCP adapter path. A minimal local stdio JSON-RPC skeleton now lives at `src/mcp/server.js` and is exposed as `agentshell-mcp`; it is intentionally an adapter around the existing CLI, not a separate AgentShell runtime or full MCP SDK implementation.

The current integration path remains:

1. AgentShell CLI JSON protocols.
2. Codex plugin skill that tells Codex when to call the CLI.
3. Static adapter packages for hosts that can call shell commands.

The MCP layer should stay thin and follow the CLI/plugin protocol. Broader host packaging, cancellation polish, and mutating tools should still wait until the CLI/plugin protocol is stable enough that MCP does not become a second contract surface.

## Non-Goals

- Do not replace the `agentshell` CLI as the source of truth.
- Do not add a long-running server requirement to the Codex plugin path.
- Do not expose broad filesystem or shell execution tools.
- Do not invent response contracts that differ from the checked-in JSON schemas.
- Do not raise MCP above the current CLI/plugin adapter work.

## Current Skeleton

The current skeleton is deliberately small:

1. It reads newline-delimited JSON-RPC 2.0 messages from stdin and writes one JSON response per line to stdout.
2. It supports `initialize`, `tools/list`, and `tools/call`.
3. `tools/list` exposes the draft stable AgentShell tool names and small input schemas.
4. `tools/call` maps tool arguments to an AgentShell CLI argv payload, spawns `node src/cli.js ...` in the current workspace, parses stdout JSON, and returns the CLI payload unchanged as `structuredContent`.
5. It also includes the same payload as JSON text content for smoke clients that only inspect MCP text blocks.
6. It has no network dependency and does not affect `agentshell`, `ashell`, or the Codex plugin path.

Example smoke request:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
```

Example tool call:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"agentshell_manual","arguments":{}}}
```

Run the focused smoke test with:

```bash
npm run test:mcp
```

## Minimal Tool Surface

The first MCP server should expose only stable, high-value AgentShell workflows. Tool names use an `agentshell_` prefix so hosts can distinguish them from generic tools.

| MCP tool | CLI equivalent | Purpose |
|---|---|---|
| `agentshell_manual` | `agentshell manual` | Return current usage and supported commands. |
| `agentshell_understand` | `agentshell understand` | Summarize the current workspace; CLI callers should prefer `agentshell understand --compact` for first-pass context. |
| `agentshell_find` | `agentshell find <query>` | Search project context without dumping raw grep output. |
| `agentshell_read` | `agentshell read <file> --lines A:B` or `--around <query>` | Read bounded file context and return hashes for safe edits. |
| `agentshell_verify_test` | `agentshell verify test [--tail N]` | Run the project test command and return compact verification JSON. |
| `agentshell_diagnose_test` | `agentshell diagnose test --compact` | Diagnose a failing test run without inline raw logs. |
| `agentshell_fix_test` | `agentshell fix test --fast\|--safe\|--dry-run --compact` | Run the conservative repair loop using existing fix policies. |
| `agentshell_run_next` | `agentshell run next` | Return the shortest next action for the latest task run. |
| `agentshell_run_status` | `agentshell run status --compact` | Return compact task-run state. |
| `agentshell_log_get` | `agentshell log get <logRef> --tail N` | Fetch bounded log tails referenced by prior responses. |
| `agentshell_schema_get` | `agentshell schema get <name>` | Return the JSON Schema for a CLI protocol. |
| `agentshell_metrics` | `agentshell metrics --compact` | Return compact usage and run metrics. |

`change suggest`, `change fill`, `change`, `undo`, `history`, benchmark, and real-project evaluation commands should stay CLI-only for the first MCP draft unless a host has a concrete need. They either mutate files, are release/evaluation utilities, or are less central to the initial agent loop.

## JSON Schema Mapping

MCP input schemas should be small wrappers around CLI arguments. MCP output should be the CLI JSON response unchanged.

| MCP concept | Mapping rule |
|---|---|
| Tool `inputSchema` | Define only the arguments needed to build the corresponding CLI invocation. |
| Tool output | Return the parsed JSON emitted by the CLI without renaming fields. |
| Protocol versions | Preserve command-scoped `protocolVersion` fields such as `agentshell.fix.v1`, `agentshell.verify.v1`, and `agentshell.diagnose.v1`. |
| Validation | Validate outputs against the same schemas exposed by `agentshell schema get <name>`. |
| Errors | Preserve the shared `{ ok: false, error: { code, message, details, suggestedNextActions } }` shape. Transport failures may wrap the CLI error, but successful CLI JSON should not be rewritten. |
| Logs | Preserve `logRef` indirection. MCP should not inline full raw logs by default. |
| File safety | Preserve `expectedHash` and range semantics from `agentshell read` and change schemas. |

Suggested first-pass input schemas:

- `agentshell_find`: `{ "query": "string" }`
- `agentshell_read`: `{ "file": "string", "lines": "string" }` or `{ "file": "string", "around": "string" }`, with exactly one of `lines` or `around`.
- `agentshell_verify_test`: optional `{ "tail": "number" }`
- `agentshell_diagnose_test`: no required fields; always compact.
- `agentshell_fix_test`: optional `{ "policy": "fast|safe", "dryRun": "boolean" }`; `dryRun: true` maps to `--dry-run` and must not combine with `policy`.
- `agentshell_run_status`: optional `{ "compact": "boolean" }`, defaulting to true.
- `agentshell_log_get`: `{ "logRef": "string", "tail": "number" }`
- `agentshell_schema_get`: `{ "name": "string" }`
- `agentshell_metrics`: optional `{ "limit": "number" }`, always compact.

The server should not copy full JSON Schemas into source by hand. It should either reuse the checked-in `schemas/*.schema.json` files or shell out to `agentshell schema get` during tests to confirm the output contract.

## Lifecycle

The skeleton follows this simple model:

1. Start as a local stdio MCP server inside a target workspace.
2. Use `node src/cli.js` from this source checkout for the current local skeleton. A packaged host adapter can later resolve `agentshell` from PATH.
3. For each MCP call, spawn one CLI command in the workspace directory.
4. Parse stdout as JSON and return it as structured MCP tool content.
5. Keep AgentShell runtime state in the existing `.agentshell` workspace directory.
6. Apply conservative timeouts around CLI commands.
7. Add cancellation by terminating the child process when a real MCP host integration needs it.
8. Avoid background indexing or hidden mutation outside the existing CLI behavior.

This model keeps the MCP server as an adapter layer rather than a second implementation of AgentShell.

## Why Full MCP Is Still Deferred

MCP is useful for hosts that prefer tool schemas and structured tool discovery, but the full server path is not the bottleneck yet.

Reasons to defer:

- The CLI protocol is still expanding across commands.
- The Codex plugin and static adapters already cover the current supported workflow.
- A large server would duplicate contracts before schemas and versioning settle.
- Long-running server lifecycle, cancellation, and host packaging add test surface without improving the core repair strategies.
- The current priority is better fix success, protocol stability, benchmarks, and adapter ergonomics.

## Relationship To CLI And Plugin Adapters

The CLI remains the canonical runtime. The plugin and adapters are instructions that tell an agent when to call the CLI. A future MCP server would be another adapter with stricter tool schemas, not a new execution engine.

| Layer | Status | Role |
|---|---|---|
| CLI | Current source of truth | Implements commands, JSON output, schemas, file safety, and runtime state. |
| Codex plugin | Current preferred Codex path | Provides skill instructions and packaged CLI files. |
| Static adapters | Current cross-host path | Provide host-specific instructions for shell-based CLI use. |
| MCP server | Minimal skeleton | Exposes initialize, tool discovery, and CLI-backed tool calls for the stable draft subset. |

Any future MCP implementation should be accepted only if it passes the same schema, smoke, and benchmark expectations as the shell-based adapter path.
