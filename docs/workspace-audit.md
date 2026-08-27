# Workspace Audit

`workspace audit` is a read-only, multi-repository change summary for Agent workflows. It accepts 2–32 explicit Git repository roots and returns compact JSON without exposing absolute paths, file names, raw diffs, command output, or secrets.

## Collected evidence

Each repository is inspected concurrently with bounded, argument-array Git processes:

- `git status --porcelain=v1 -z --untracked-files=all`
- `git branch --show-current`
- staged and unstaged `git diff --check`
- staged and unstaged `git diff --numstat -z`

All Git subprocesses across all roots share one FIFO concurrency limiter. The deterministic default is four active Git processes; an integration may request `maxConcurrency`, which is clamped to the safe range 1–8. The limiter also covers each repository's initial `rev-parse` root check, so nested per-repository parallelism cannot multiply the process count. Repository output remains in input order regardless of completion order.

The response includes the current branch, staged, unstaged, untracked, conflicted, and total changed-file counts; additions, deletions, and binary-file counts; and whether diff checks passed. Detached HEAD is represented as `current: null, detached: true`. Branch text is stripped of control characters and bounded to 160 characters. Untracked file contents are never read.

## Generic risk categories

Changed paths are classified locally and returned only as counts. Categories are exclusive, in this priority order:

1. Generated files and generated directories
2. Common dependency lock files
3. Protocol and schema definitions such as Protobuf, Thrift, OpenAPI, and GraphQL
4. Configuration files and configuration directories

No organization-specific boundary or naming convention is embedded in the classifier.

## Safety

- Root validation reuses `workspace guard`: home, filesystem root, duplicate/symlink-equivalent roots, missing paths, and non-directories are rejected.
- Every input must resolve to the exact Git top-level directory, not a nested directory.
- All Git subprocesses are bounded by timeout and output limits and use `shell: false`.
- A repository failure produces a structured, path-free failure and never changes any worktree.
- Repository results preserve input order and the JSON response has fixed, bounded fields.

The core and command handler are intentionally separable from CLI routing. Public CLI registration can be added independently after integration review.
