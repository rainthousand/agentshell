# Batch read

`read batch` collects several bounded source windows in one ordered response. The
core is ready for CLI routing, but this change intentionally does not modify the
public command registry.

## Target forms

Targets may be repeated strings:

```text
src/a.js:10:30
src/b.go@around=func Handle
README.md@head=40
server.log@tail=20
```

The programmatic API also accepts objects:

```js
await readBatch(root, [
  { file: "src/a.js", lines: "10:30" },
  { file: "src/b.go", around: "func Handle" },
  { file: "README.md", head: 40 }
]);
```

## Bounds and safety

- A request contains 1 to 20 targets.
- Each result contains at most 12,288 content characters.
- All result content together contains at most 49,152 characters.
- File bytes read and hashed across the batch are capped at 4 MiB and fairly
  divided among valid targets. A single target never reads more than 512 KiB.
  `workBytes` reports successful reads, while `workBudgetBytes` includes reserved
  work for failed reads and is the fail-closed value enforced against the cap.
- Results remain in input order. Individual failures produce `partial` or
  `failed` status without discarding successful reads.
- The implementation delegates file access to the existing `read` command. The
  opened file descriptor is checked against the contained real path before and
  after reading; content and hashes come from that same descriptor.
- Large head/tail reads return a window hash (`hashScope: "window"`) instead of
  scanning the whole file. Oversized tail windows use unknown line numbering
  because absolute line numbers would require reading the omitted prefix.
- A hash with `hashScope: "window"` proves only the returned byte window. It
  must never be passed to `agentshell change` or another edit operation as a
  whole-file `expectedHash`. Only `hashScope: "full"` is eligible for that use.
- Absolute paths, paths outside the workspace, and arbitrary shell execution are
  not supported.

The response protocol is `agentshell.read-batch.v1`.
