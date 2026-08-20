---
name: agentshell
description: Use AgentShell when a coding task benefits from compact JSON project inspection, code search, range-based file reads, or summarized test verification. Prefer it over noisy ad hoc shell commands when the `agentshell` CLI is available in the workspace.
---

# AgentShell

AgentShell is a structured local CLI for AI coding agents. Its purpose is to reduce terminal noise, command round trips, and token usage during code understanding and failing-test work while keeping next-action task guidance and previewable conservative suggested changes that agents can inspect cheaply. It detects Node projects from `package.json`, Go modules from `go.mod`, Python projects from common Python manifests, Java projects from Maven/Gradle manifests, and local multi-module Go workspaces from `go.work`. JavaScript and TypeScript have narrow automatic repair strategies; Go has compact structured verification and diagnosis, but automatic Go source repair is not supported. Python and Java support in V1.0 is read-only discovery and summarization. AgentShell also includes `start --compact`/`entry --compact` for the cheapest combined doctor, compact understand, and run-next summary, full `start`/`entry` for debugging payloads, readiness checks, compact run state and metrics, log references, benchmarks, JSON schemas, adapter instructions, and hash-checked edits with undo.

## Activation Contract

1. Establish the actual project root from the opened workspace, git root, or nearest supported project manifest, then run AgentShell from that directory. Never default to `$HOME` unless it is itself the project.
2. Resolve the CLI with `command -v agentshell`. If it is missing, use `./bin/agentshell` from an AgentShell checkout or first resolve the newest version under `${CODEX_HOME:-$HOME/.codex}/plugins/cache/personal/agentshell/`, then invoke that version's `bin/agentshell`.
3. Run `agentshell start --compact` early in a supported coding task, before broad inspection or test repair.
4. Run `agentshell verify test --compact` before declaring a task complete when the project has a supported test script.
5. For beta evidence, run `agentshell trial status`, then `agentshell trial export --verify --rating 1-5`; report actionable status instead of asking the user to diagnose project location or missing verification.

The local CLI/plugin flow is canonical. Do not require or start an MCP server; MCP remains deferred.

## When To Use

Use AgentShell first for supported actions:

- `agentshell manual` for the compact command router; use `agentshell manual --topic repair|plugin|benchmark|profile|onboarding|log-triage|reference` for focused guidance and `agentshell manual --full` only when the compact router is insufficient.
- `agentshell start --compact` or `agentshell entry --compact` to get the cheapest doctor, compact understand, and run-next summary in one machine-readable response; use plain `agentshell start` only when full embedded payloads are needed.
- `agentshell doctor` to check runtime, project manifest/test command, AgentShell state, and git readiness in compact JSON. Go projects also report Go toolchain readiness and optional, non-blocking `golangci-lint` and `goimports` availability.
- `agentshell plugin status --compact` to check source manifest, personal marketplace, Codex plugin cache consistency, and the next install action cheaply; use full `agentshell plugin status` when check details are needed.
- `agentshell understand --compact` for first-pass project inspection; use full `agentshell understand` only when root paths, changed file names, or action reasons are needed.
- `agentshell project health --compact` for a one-command project health summary across test command, config, dependency, git, and CI signals without running tests.
- `agentshell find <query>` for compact code search.
- `agentshell grep <query> --compact` for bounded structured code search when raw `rg`/`grep` would produce noisy output; use `--limit N`, `--per-file N`, `--type py|go|ts|java`, `--context N`, or `--files-with-matches` to narrow the result.
- `agentshell find file --name <pattern> --compact` for bounded filename discovery with file category, size, risk, and a suggested focused read.
- `agentshell ls --compact` and `agentshell pwd --compact` for concise directory and workspace-location context without raw listing noise.
- `agentshell du --compact` for bounded disk-usage hotspots with generated-directory and token-noise hints.
- `agentshell which <command> --compact` for executable path and safe version discovery.
- `agentshell ps --compact` and `agentshell port list --compact [--port N]` for focused development-process and listening-port inspection.
- `agentshell kill suggest --pid N --compact` or `agentshell kill suggest --port N --compact` to preview a process-stop command and risk without executing it.
- `agentshell tree --compact` for a bounded project tree that prioritizes important source, test, docs, script, and entry files while ignoring common generated folders.
- `agentshell files changed --compact` for changed-file category/risk summaries when raw `git status` plus name-only diffs would require multiple noisy commands.
- `agentshell changed impact --compact` for changed-file impact, risk, and recommended validation commands without running tests.
- `agentshell file info <path> --compact` for one-file size, hash, language, generated/binary, git metadata, and JS/TS/Go/Python/Java symbol summaries without dumping file contents.
- `agentshell test list --compact` for discovered Node scripts, test files, Go/Python/Java test files, and packages without actually running tests.
- `agentshell test command --compact` to choose the likely runnable test command across Node, Go, Python, and Java without executing it.
- `agentshell errors from-log <file> --compact` to extract likely failures, stack locations, and short snippets from saved logs without reading the full log.
- `agentshell errors from-command --compact -- <command...>` to execute a command while returning compact error evidence, exit status, duration, and a `logRef` instead of full stdout/stderr.
- `agentshell imports <file> --compact` for JS/TS/Go/Python/Java import summaries when dependency shape matters more than full source content.
- `agentshell symbols <file> --compact` for JS/TS/Go/Python/Java symbol summaries when file structure matters more than implementation bodies.
- `agentshell refs <symbol> --compact` for bounded grouped reference search when raw `rg` would produce too many lines.
- `agentshell config list --compact` for common project config entry points such as package, TS/JS, Python, Java, build, lint, Go, Makefile, Docker, CI, Codex, and AgentShell config.
- `agentshell git status --compact` for structured working-tree state, dirty/clean counts, truncated file lists, and lockfile/generated-output risk hints.
- `agentshell git diff --compact` or `agentshell git diff --compact --staged` for compact diff stats, changed-file summaries, hunk locations, risk hints, and a `diffRef` for raw diff retrieval only when needed.
- `agentshell git log --compact` for recent commit history without raw patches; use `--limit N` for a bounded history window.
- `agentshell git branch --compact` for current branch, upstream, ahead/behind, local branch count, and redacted remote host/provider hints.
- `agentshell package scripts --compact` for package script names, categories, risky/long-running hints, and verification-oriented next actions without reading the whole manifest.
- `agentshell package script <name> --compact` to inspect one script's command, category, risk, and run suggestion before executing it.
- `agentshell package deps --compact` for Node, Go, Python, and Java manifest dependency summaries, framework/runtime hints, and lockfile/dependency-count risks without expanding dependency trees.
- `agentshell read <file> --lines A:B` for bounded file reads.
- `agentshell read <file> --around <query>` for context near known text or symbols.
- `agentshell read <file> --head N` or `agentshell read <file> --tail N` for safe bounded edges of large files; `agentshell head|tail <file> --lines N --compact` are convenient aliases.
- `agentshell verify test --compact` for compact summarized test output. Go verification runs `go test -json` internally and reports structured package, test, and subtest failures.
- `agentshell verify test --tail N` when inline log tail is needed.
- `agentshell verify build`, `agentshell verify lint`, `agentshell verify format`, and `agentshell verify modules` for Go build, `go vet`, read-only `gofmt` comparison, and read-only module integrity/tidy-drift checks.
- `agentshell verify test --profile fast|race|coverage` to select a bounded Go test profile.
- `agentshell verify benchmark --bench 'BenchmarkEncode'` for a Go benchmark run that excludes normal tests; omit `--bench` to match all benchmarks.
- `agentshell verify fuzz --fuzz FuzzName --duration 10s --package ./internal/parser` only with an explicit target, finite duration, and one package.
- `agentshell verify generate` to preview generators with `go generate -n`; it does not execute generators.
- `agentshell fix test --fast --compact` for the fastest supported failing-test repair path; `agentshell fix test --compact` is the compatible default.
- `agentshell fix test --safe --compact` or `agentshell fix test --dry-run --compact` to preview the same one-command repair without changing source files.
- `agentshell diagnose test --compact` when speed and token cost matter; it combines verification, compact read refs, likely implementation reads, `fixPlan`, and `changeTemplate` in one command, and skips generic reads/search for clear deterministic TypeScript or import-path diagnostics. For Go failures it can connect `_test.go` files to sibling package implementations, but the resulting source change must be reviewed and applied manually.
- `agentshell diagnose test` when full test snippet content is useful.
- `agentshell change suggest --dry-run --compact` to preview a conservative suggested replacement.
- `agentshell change suggest --apply --compact` when the active diagnosis has a clear generated template and the preview is enough. It currently supports missing object properties, flat deepEqual missing properties, simple deepEqual array additions, simple deepEqual array tail removals, simple deepEqual extra property removals, simple deepEqual array primitive replacements, small returned-array length shortfalls, simple wrong literals, empty `join('')` separator repairs, simple string case transforms, simple truthy-return assertions, missing named exports, unique local import path repairs, and narrow TypeScript diagnostic repairs. It intentionally refuses automatic Go source repair.
- `agentshell run next` to get the shortest next recommended action for the active task.
- `agentshell run clear` to discard stale active run state while keeping historical run snapshots.
- `agentshell log get <logRef> --tail N` only when more verification output is needed.
- `agentshell change <change.json>` for hash-checked edits.
- `agentshell change fill <template.json> <fill.json> --apply` to fill and apply a generated change template.
- `agentshell history` to inspect AgentShell operations.
- `agentshell run status --compact` to inspect the active diagnosis/change/verify run summary cheaply.
- `agentshell run status` to inspect the full active run graph when debugging AgentShell itself.
- `agentshell run latest --compact` to inspect the most recent run snapshot summary.
- `agentshell undo [operationId]` to revert AgentShell edits.
- `agentshell metrics --compact [--limit N]` to inspect recent output cost cheaply.
- `agentshell dashboard` to open the compact native macOS menu-bar status tool (browser fallback elsewhere) with verified token and time savings; use `--window` for the legacy floating window or `--browser` for the browser surface.
- `agentshell trial status` to check project location, test support, freshness, and verification readiness before beta export.
- `agentshell trial export --verify --rating 1-5` to verify and write a redacted, collector-ready evidence JSON file to the Desktop.
- `agentshell metrics [--limit N]` when debugging detailed recent event history.
- `agentshell benchmark test` to compare raw test output with compact AgentShell output.
- `agentshell schema list` and `agentshell schema get <name>` to inspect stable JSON contracts.

Fall back to normal shell commands only when AgentShell does not support the needed action.

## Availability Check

First enter the actual project root, then run:

```bash
agentshell manual
agentshell manual --topic repair
agentshell start --compact
```

If `agentshell` is not on PATH, keep the same project working directory and invoke a local checkout or installed plugin-cache binary:

```bash
node src/cli.js manual
bin/agentshell manual
node src/cli.js manual --topic repair
bin/agentshell manual --topic repair
node src/cli.js manual --topic onboarding
node src/cli.js manual --topic log-triage
node src/cli.js start --compact
bin/agentshell start --compact
node src/cli.js doctor
bin/agentshell doctor
${CODEX_HOME:-$HOME/.codex}/plugins/cache/personal/agentshell/<version>/bin/agentshell start --compact
```

## Workflow: Diagnose A Failing Test

1. Run `agentshell start --compact` when entering a new checkout and you want readiness, compact workspace shape, and next action in the smallest response.
2. Run `agentshell doctor` when environment readiness is unclear or you need the full readiness response again.
3. Run `agentshell understand --compact` for the first-pass project decision context.
4. Run `agentshell fix test --fast --compact` when the goal is to repair a supported failing test quickly. `agentshell fix test --compact` keeps the same compatible fast default.
5. Use `agentshell fix test --safe --compact` or `agentshell fix test --dry-run --compact` when you want a one-command preview before applying.
6. If `fix` cannot safely apply a suggestion, run `agentshell diagnose test --compact`.
7. Inspect `fixPlan`, `changeTemplate`, `verification.summary`, compact read refs in `focusedReads` and `implementationReads`, and `suggestedNextActions`; run full `diagnose test` only when symbol lists or inline content are needed.
8. Use `agentshell log get <logRef> --tail N` or `agentshell verify test --tail N` only if the diagnosis is insufficient.
9. Create a change JSON using the hash returned by `focusedReads` or `implementationReads`.
10. Prefer `agentshell change suggest --dry-run --compact` when the active diagnosis is clear.
11. Apply with `agentshell change suggest --apply --compact` when the preview is sufficient.
12. Otherwise use `agentshell change fill <template.json> <fill.json> --apply` when `changeTemplate` is available, or apply with `agentshell change <change.json>`.
13. Run `agentshell verify test` again.
14. Run `agentshell run next` when you only need the next recommended action.
15. Run `agentshell run status --compact` to inspect pass/fail state, command count, token estimate, rollback command, and next best action.
16. Run `agentshell run clear` when the active run is stale and should not guide the next action anymore.
17. If the edit was wrong, run `agentshell undo`.

For Go projects, use `start --compact`, then `diagnose test --compact`, then
`verify test --compact`. AgentShell discovers `go.mod` or `go.work`; workspaces
use explicit targets for every valid local module. It may reuse a package-scoped
test command when a previous failure identifies an `_test.go` file. Cache
fingerprints cover module metadata, Go source, `testdata`, `//go:embed`
resources, and native build inputs across valid modules. Very large input sets
use uncached verification.

Use `.agentshell.json` version 1 only for reviewed repository-specific Go
commands or overrides of the built-in `fast`, `race`, and `coverage` profiles:

```json
{
  "version": 1,
  "go": {
    "commands": {
      "test": "make test",
      "build": "make build",
      "lint": "golangci-lint run"
    }
  }
}
```

Treat invalid configuration as a blocker and inspect the reported issue. Do not
override read-only or bounded workflow commands; V1 repository command
overrides are limited to `test`, `build`, and `lint`, while profiles may replace
only their `test` command. Do not
call `change suggest --apply` for Go source; inspect the diagnosis and use the
hash-checked manual change path.

## Rules

- Treat AgentShell JSON as the source of truth.
- Establish and enter the real project root first; never run project commands from `$HOME` merely because the shell opened there.
- Use `agentshell start --compact` or `agentshell entry --compact` for the cheapest first pass in a fresh workspace.
- Use `agentshell doctor` before longer workflows when the checkout, PATH, state directory, or test script may be uncertain.
- Prefer `summary` and `suggestedNextActions` before reading full logs.
- Keep file reads narrow; v0.1 caps reads at 200 lines.
- Do not invent `expectedHash` values; use the current hash from `agentshell read`.
- If `agentshell change` returns `HASH_MISMATCH`, re-read the file and rebuild the change.
- Prefer `verify.summary` and `suggestedNextActions` before fetching stored logs.
- Use `agentshell manual --topic onboarding` for the first-pass checkout workflow when entering an unfamiliar project.
- Use `agentshell manual --topic log-triage` for the summary-first, bounded-tail log workflow when terminal output is noisy.
- Use `agentshell metrics --compact` for measurement, not for diagnosis.
- Treat Dashboard context savings as estimated tool-output context avoided, execution time as measured AgentShell time, and unavailable Codex model tokens or thinking time as unavailable rather than zero.
- Use `agentshell trial status` before evidence collection and prefer `agentshell trial export --verify --rating 1-5`; review the JSON before sharing it, and do not treat its AgentShell-only telemetry as full Codex session token accounting.
- Use `agentshell fix test --fast --compact` before the split diagnose/change/verify loop when the task is to repair a supported failing test.
- Use `agentshell change suggest --apply --compact` only when the active diagnosis has a clear generated template.
- Treat automatic Go source repair as unsupported even when diagnosis identifies a likely target; use bounded reads and a reviewed hash-checked edit instead.
- For `go.work`, execute only the explicit valid local module targets reported by AgentShell; never broaden an invalid or outside-workspace `use` entry.
- Treat `verify format`, `verify modules`, and `verify generate` as read-only checks.
- Never run Go fuzzing without explicit `--fuzz`, finite `--duration`, and one local `--package`.
- Do not assume `golangci-lint` or `goimports` is installed; use the optional doctor result or the standard Go toolchain.
- Do not require MCP for any Go workflow; the local CLI/plugin flow is canonical.
- Use `agentshell run next` for the cheapest next-action check.
- Use `agentshell run clear` when stale active run state would otherwise mislead a new task.
- Use `agentshell run status --compact` for task state after a diagnose/change/verify loop.
- Use `agentshell benchmark test` when measuring demo impact.
- Use `agentshell schema get <name>` for integration work, not routine diagnosis.
- Use `agentshell diagnose test --compact` to reduce command round trips and token cost in the common failing-test workflow; compact read entries are refs with file, hash, range, matched line, and line count, not inline content, and verbose symbol lists are omitted.
- Prefer `diagnose.fixPlan.target` for the first change target when confidence is `medium` or higher.
- Fill `diagnose.changeTemplate.path` when available instead of creating a change spec from scratch.
- Use `agentshell schema get change-fill` for the fill payload contract.
