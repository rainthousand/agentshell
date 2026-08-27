# Incremental log deltas

`agentshell log delta <file> --compact` is the bounded log path for watch processes,
development servers, test watchers, and container logs that are already being written
to a local file. It returns only information appended since the previous call instead
of repeatedly loading the complete log into an Agent context.

## Contract

- The first call starts at byte zero. Later calls start at the persisted byte offset.
- `--max-bytes N` bounds one read. The default is 128 KiB and the hard maximum is 1 MiB.
- When unread data exceeds the bound, `cursor.moreAvailable` is true and another call
  continues at the next byte.
- A replaced file (different device/inode) is reported as `resetReason: "rotation"`.
- A file shorter than the saved offset is reported as `resetReason: "truncation"`.
- Invalid or damaged cursor JSON is discarded locally and reported as `recovered: true`.
- `--reset` removes the cursor so the next call reads from the beginning.

The response contains byte progress, compact error evidence, and detected lifecycle
changes such as ready, healthy, retrying, restarting, failed, or stopped. It never
returns the complete raw log. A status change's `line` is relative to the current
delta, while error file and line locations come from the diagnostic itself.

## Privacy and persistence

Cursors live under `.agentshell/log-cursors/`. Their filenames are opaque SHA-256
derived IDs. Cursor records contain only the opaque ID, byte offset, file identity,
version, and update time; they do not persist the workspace path, log path, arguments,
or log contents.

The path must resolve to a regular file inside the active workspace. Symlinks escaping
the workspace are rejected.

## Examples

```bash
agentshell log delta logs/dev.log --compact
agentshell log delta logs/dev.log --max-bytes 65536 --compact
agentshell log delta logs/dev.log --reset --compact
```

For a live process, redirect output to a workspace log file first. Container adapters
can likewise append bounded `docker logs` or `kubectl logs` output to a local file and
use this command as the compact, cursor-based consumer.
