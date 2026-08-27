# Background job management

AgentShell jobs let an agent launch a long-running executable without retaining the full terminal stream in model context. The manager accepts only an explicit argv array and always calls `spawn` with `shell: false`; it has no shell-string API.

## Lifecycle

```bash
agentshell job start --timeout-ms 600000 -- npm test
agentshell job status <job-id>
agentshell job delta <job-id> [--cursor <cursor>]
agentshell job cancel <job-id>
```

`start` persists private state under `<workspace>/.agentshell/jobs/<job-id>`. `status` recovers completed state after the launching AgentShell process exits. `delta` reads only bytes after its opaque two-stream cursor. `cancel` signals a worker only after its PID and random instance identifier match, and that worker verifies ownership again before signalling the command process group.

## Safety and bounds

- Files and directories use modes `0600` and `0700`, with atomic state replacement.
- The filesystem root and the user's home directory cannot be job roots. State cannot be redirected outside the workspace.
- Commands contain at most 64 argv entries, 4 KiB per entry, and 32 KiB in total.
- Four jobs run concurrently by default. Configured limits remain bounded.
- stdout and stderr use separate rotating segments. Defaults retain four 256 KiB segments per stream.
- Status argv and delta output are redacted before being returned; raw local logs remain private for debugging.
- Timeouts first send `SIGTERM`, then `SIGKILL` after a short grace period, and persist `timed_out` with structured termination data.
- A stale or reused PID is never signalled when its worker command line does not contain the expected job ID and instance nonce.
- Log-write errors are caught inside stream callbacks. The worker terminates and reaps its owned command group, then persists `failed` with `log-write-failed` instead of crashing and orphaning the command.
- Before delayed `SIGKILL`, the worker rechecks instance ID, worker PID, child PID, and that the child is still its own process-group leader. If the leader has already exited, ownership can no longer be proven and AgentShell conservatively skips the force signal; descendants are expected to have honored the earlier group `SIGTERM`.
- When a worker first disappears, status keeps the job active for a bounded one-second completion reconciliation window. A short-lived worker can finish its atomic terminal-state write; a genuinely stale job becomes `lost` after the window.

The public CLI wiring is intentionally separate from this module so the lifecycle can be reviewed and tested before being exposed as a stable command.
