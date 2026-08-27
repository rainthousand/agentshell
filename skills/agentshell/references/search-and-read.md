# Search And Read

Use compact discovery first, then read only the range needed to decide or edit.

## Discovery

- `agentshell find <query>`: compact code search.
- `agentshell grep <query> --compact`: bounded structured search. Narrow with `--limit`, `--per-file`, `--type`, `--context`, or `--files-with-matches`.
- `agentshell find file --name <pattern> --compact`: bounded filename discovery with category, size, risk, and focused-read guidance.
- `agentshell ls --compact`, `pwd --compact`, and `tree --compact`: concise location and structure.
- `agentshell du --compact`: disk hotspots with generated-directory and token-noise hints.

## Structure Before Content

- `agentshell imports <file> --compact`: JS/TS, Go, Python, and Java import summary.
- `agentshell symbols <file> --compact`: symbol summary without implementation bodies.
- `agentshell refs <symbol> --compact`: bounded grouped reference search.
- `agentshell file info <path> --compact`: hash and metadata before reading or editing.

## Bounded Reads

- `agentshell read <file> --lines A:B`: explicit range.
- `agentshell read <file> --around <query>`: context near known text or a symbol.
- `agentshell read <file> --head N` or `--tail N`: bounded file edges.
- `agentshell read batch --target <file:A:B> --target <file@around=query> --compact`: fetch up to 20 independent bounded locations in one round trip; inspect each item because partial results are valid.
- `agentshell head <file> --lines N --compact` and `agentshell tail <file> --lines N --compact`: convenient aliases.

Reads are capped; do not fetch an entire large file when symbols, search results, or a range answer the question.

## Error And Log Triage

- `agentshell errors from-log <file> --compact`: extract likely failures and short snippets without reading the full log.
- `agentshell errors from-command --compact -- <command...>`: execute with compact error evidence, duration, exit status, and a `logRef`.
- `agentshell log delta <file> --compact`: return only newly appended errors and state changes from watch, build, or container logs. Use `--reset` only after an intentional replay.
- `agentshell log get <logRef> --tail N`: retrieve more output only when compact evidence is insufficient.

Prefer returned references and summaries over raw stdout or stderr.
