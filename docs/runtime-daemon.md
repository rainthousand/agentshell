# AgentShell Runtime Daemon

The runtime daemon is an optional local acceleration layer for repeatedly reading project metadata. It does not execute commands and is not required for correctness.

## Boundary

- macOS and Linux only, over a local Unix domain socket.
- The runtime directory is mode `0700`; socket, lock, and state files are mode `0600`.
- The protocol allowlist is limited to `ping`, `metadata.get`, `cache.invalidate`, and `stop`.
- Requests cannot contain shell commands, argument arrays, environment variables, working-directory overrides, or network destinations.
- Cached values contain bounded, JSON-serializable project metadata only. File contents, command output, credentials, and mutable process state are excluded.
- Unavailable daemons fall back to the same local read-only project inspection path.

## Cache validity

Entries have a bounded TTL, defaulting to 30 seconds and capped at five minutes. A root fingerprint covers the canonical root identity and supported project manifests, lockfiles, Go workspace files, and `.agentshell.json`. A changed fingerprint invalidates an entry immediately, even before TTL expiry.

Concurrent reads for the same root and fingerprint are coalesced. Cache invalidation only removes in-memory metadata; it never changes the project.

## CLI lifecycle

```bash
agentshell runtime start
agentshell runtime status --compact
agentshell runtime request --compact
agentshell runtime invalidate
agentshell runtime stop
```

`start` launches a detached local process. `request` uses the daemon when healthy and otherwise returns the same read-only metadata through a local fallback. The daemon remains opt-in: end-to-end CLI benchmarks must show a benefit before it is allowed to replace the normal `start`, `doctor`, or `understand` path.

## Lifecycle API

The independent command module exports `runtimeCommand`, `startRuntime`, `statusRuntime`, `stopRuntime`, and `runtimeRequest`.

```js
import { startRuntime, runtimeRequest } from "./src/commands/runtime.js";

const session = await startRuntime({ runtimeDir: "/tmp/agentshell-runtime" });
const result = await runtimeRequest(process.cwd(), { runtimeDir: "/tmp/agentshell-runtime" });
await session.close();
```

For a source-checkout foreground service:

```bash
node src/cli.js runtime serve --runtime-dir /tmp/agentshell-runtime
```

Measure only the warm metadata layer with `npm run benchmark:runtime`. This benchmark intentionally excludes CLI cold start and command execution.

## Recovery and failure semantics

On startup, AgentShell probes an existing socket and reuses a healthy daemon. A socket owned by the current user is removed only when its recorded process is dead. Non-socket paths, foreign-owned paths, and live-but-unresponsive owners are preserved and reported as unsafe instead of being replaced.

Clients enforce request and response byte limits plus a bounded timeout. `getRuntimeProjectMetadata` automatically performs local read-only inspection when the daemon is missing or unavailable; callers can set `fallback: false` when they only want to probe daemon availability.
