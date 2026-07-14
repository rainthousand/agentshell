# Codex Plugin Flow

AgentShell is packaged as a Codex plugin with:

- `.codex-plugin/plugin.json`
- `skills/agentshell/SKILL.md`
- `bin/agentshell`
- the zero-dependency Node.js CLI under `src/`

## Local Development Flow

From the AgentShell repo:

```bash
npm link
agentshell manual
agentshell manual --topic plugin
npm run plugin:validate
npm run plugin:validate:source
npm run plugin:install-local -- --dry-run
npm run plugin:install-local
npm run plugin:doctor-local
npm run plugin:release-local -- --dry-run --compact
npm run plugin:release-local -- --dry-run --compact --report artifacts/plugin-release-local.json
```

In any target project:

```bash
agentshell doctor
agentshell start --compact
agentshell understand --compact
agentshell fix test --fast --compact
# or, when automatic repair is not safe:
agentshell diagnose test --compact
agentshell verify test
agentshell benchmark test
```

## Codex Behavior

When the plugin skill is active, Codex should prefer AgentShell for supported actions:

- first-pass plugin health checks with `agentshell start --compact` or `agentshell doctor`
- project inspection
- one-command supported failing-test repair
- compact test verification
- bounded file reads
- hash-checked edits
- undo/history
- cost metrics and benchmark
- schema contract inspection

Codex should fall back to normal shell commands only when AgentShell does not support the needed action.

The recommended first pass is `start --compact -> fix/diagnose/verify`:
run `agentshell start --compact`, then
`agentshell fix test --fast --compact` for supported failures or
`agentshell diagnose test --compact` followed by `agentshell verify test` when
manual inspection is needed. Use plain `agentshell start` when you need the full
embedded `doctor`, compact `understand`, and `run next` payloads for debugging.

## Validation

```bash
npm test
npm run plugin:validate
npm run plugin:validate:source
npm run plugin:doctor-local
npm run plugin:release-local -- --dry-run --compact
npm run plugin:smoke
npm run benchmark
npm run benchmark:cold-start
npm run codex:plugin:trial
npm run codex:plugin:template -- --json artifacts/codex-plugin-run-log.json --markdown artifacts/codex-plugin-run-log.md
npm run codex:plugin:plan -- --runs 3 --out-dir artifacts/codex-plugin-plan
npm run codex:plugin:collect -- --input examples/codex-plugin-new-thread.sample.json
npm run codex:plugin:suite -- --manifest artifacts/codex-plugin-plan/suite.json
npm run codex:e2e
```

`npm run benchmark:first-round` prints JSON by default. Add
`-- --report <path>` to write the JSON report and `-- --markdown <path>` to
write a Markdown artifact; the bare `-- --markdown` flag still prints the
Markdown summary to stdout.

`npm run benchmark:cold-start` measures full CLI wall time, including Node.js
startup and module loading. Profiled commands such as `agentshell start
--compact --profile` and `agentshell plugin validate --compact --profile`
include an internal `profile` object, so agents can compare external wall time
with in-process AgentShell work before deciding whether daemonization or a
native backend is justified.

`agentshell plugin validate --compact` is the one-command local plugin health
probe for agents. It returns `agentshell.plugin-validate.v1` with source checks,
schema/docs checks, installed cache checks, the embedded plugin-status summary,
and a compact `nextAction`. Use `agentshell plugin validate --source-only
--compact` or `npm run plugin:validate:source` before installing a freshly
cachebusted version, because the new version is not expected to exist in Codex's
plugin cache yet.

`npm run plugin:doctor-local` checks that `.codex-plugin/plugin.json`, the
personal marketplace at `~/.agents/plugins/marketplace.json`, and the Codex
personal plugin cache under
`~/.codex/plugins/cache/personal/agentshell/<version>` agree. It prints JSON by
default and includes `primaryNextAction` plus `suggestedNextActions` for
failures and warnings. The cache manifest must match the source manifest name,
version, `author.name`, and `interface.developerName`. Add `-- --markdown` for
a readable report, or pass `-- --home <fixture>` / `-- --marketplace <path>` /
`-- --cache-root <path>` when testing local fixtures.

When `agentshell plugin status --compact` or `npm run plugin:doctor-local`
fails, use the report's `nextAction.command` or `primaryNextAction` first. The
usual repair commands are:

- `npm run plugin:install-local` when the personal marketplace is missing,
  malformed, or points at the wrong local plugin path.
- `codex plugin add agentshell@personal` when the Codex plugin cache is missing
  or its manifest no longer matches the source manifest.
- `npm run plugin:release-local` when both marketplace and cache state need a
  full refresh.

`agentshell plugin status --compact` includes `plugin.authorName` and
`plugin.developerName` from `.codex-plugin/plugin.json`, so local checks can
confirm which developer metadata Codex should surface for the plugin. Its
compact `nextAction.command` is the repair command to run before starting a new
Codex thread.

`npm run plugin:smoke -- --path <installedPath>` checks a specific installed plugin cache; without `--path`, it uses `.codex-plugin/plugin.json` to find the current personal cache path. Default JSON output uses `agentshell.plugin-smoke.v1`, with its contract exposed through `agentshell schema get plugin-smoke`. The manual command contract is exposed through `agentshell schema get manual`, including compact default, topic, and full variants. Add `-- --markdown` or run `npm run plugin:smoke:markdown` for a readable summary while keeping default JSON output stable for automation. The smoke report also checks the installed `.codex-plugin/plugin.json` identity fields (`author.name` and `interface.developerName` must both be `Alvin`) so local installs catch release drift before publishing. It runs the installed `bin/agentshell` to verify the `plugin-status` schema requires `plugin.authorName` and `plugin.developerName` in both full and compact shapes, and that installed `agentshell plugin status --compact` reports both as `Alvin`. It also checks the installed `skills/agentshell/SKILL.md` first-pass guidance: it must recommend `agentshell start --compact` or `agentshell entry --compact` and must not point agents back to the old `doctor -> understand -> fix/diagnose/verify` path as the first pass.

`npm run codex:plugin:trial` scores the synthetic raw-baseline versus
AgentShell-plugin path under `agentshell.codex-plugin-trial.v1`. Before opening
a fresh Codex thread, run
`npm run codex:plugin:template -- --json artifacts/codex-plugin-run-log.json --markdown artifacts/codex-plugin-run-log.md`
to generate a single fillable run-log JSON and Markdown capture form. For a
multi-run stability check, run
`npm run codex:plugin:plan -- --runs 3 --out-dir artifacts/codex-plugin-plan`
to generate several run-log templates plus `suite.json`. After each fresh
thread completes, fill the observed command log in the shape of
`examples/codex-plugin-new-thread.sample.json`, then run
`npm run codex:plugin:collect -- --input run-log.json --report artifacts/codex-plugin-real-run.json --markdown artifacts/codex-plugin-real-run.md`
to score the real plugin behavior with the same protocol. The collector report
also includes a compact evidence block for product review: run count, completed
versus placeholder runs, success rate, token totals and averages, duration
totals and averages, and AgentShell/noisy raw command counts. For the generated
3-run plan, the same collector can read the manifest directly:

```bash
npm run codex:plugin:collect -- --manifest artifacts/codex-plugin-real-3run/suite.json --report artifacts/codex-plugin-real-3run/evidence.json --markdown artifacts/codex-plugin-real-3run/evidence.md
```

After collecting
multiple filled run logs, create a manifest like
`examples/codex-plugin-suite.sample.json` and run
`npm run codex:plugin:suite -- --manifest suite.json --report artifacts/codex-plugin-suite.json --markdown artifacts/codex-plugin-suite.md`
to compare strong rate, average score, average token cost, duration, and
per-fixture stability across real Codex new-thread runs.

For end-to-end speed and token measurement, see [codex-e2e-benchmark.md](codex-e2e-benchmark.md).
For healthy real-project plugin-path evidence, see [real-project-evidence.md](real-project-evidence.md).
For the v0.25 release checklist and current public notes, see [release-notes-v0.25.md](release-notes-v0.25.md).

## Update Loop

When plugin code or skill instructions change, refresh Codex's cache:

```bash
npm run plugin:release-local
```

`plugin:release-local` runs the local release chain in order:

1. `npm run plugin:cachebust`
2. `npm run plugin:validate:source`
3. `npm run plugin:install-local`
4. `codex plugin add agentshell@personal`
5. `npm run plugin:doctor-local`
6. `npm run plugin:smoke`
7. `npm run plugin:smoke:markdown`

Use `npm run plugin:release-local -- --dry-run --compact` to print the plan without
running commands. Use `npm run plugin:release-local -- --skip-codex-add --compact` when
you want to refresh the local marketplace copy and run smoke checks without
installing into the Codex plugin cache. Add `-- --report <path>` to write the
full JSON release report to an artifact file while keeping stdout compact.
Compact stdout includes `status`, `durationMs`, plugin metadata, summary counts,
and `failedStep` under `agentshell.plugin-release-local.v1` so agents can decide
whether to open the full artifact. The `plugin` summary is populated from the
`plugin:doctor-local` step and includes `name`, `version`, `authorName`, and
`developerName`; dry-run reports use `null` because no installed cache is read.

The same steps can still be run manually when debugging a single stage:

```bash
npm run plugin:cachebust
npm run plugin:install-local
codex plugin add agentshell@personal
npm run plugin:doctor-local
npm run plugin:smoke
```

Start a new Codex thread after reinstalling so the updated skill instructions are loaded.

## Install Notes

For a non-developer Codex user with a share package:

1. Unzip it, if needed, and open the `agentshell-codex-plugin` folder.
2. Double-click `install.command`. If Terminal is easier, run:

   ```bash
   npm run install:codex
   ```

3. Quit and reopen Codex, then start a new Codex thread.
4. Verify by asking Codex to use AgentShell, or run `agentshell start --compact`.

After a successful install, no manual Codex configuration or instruction
copy/paste is needed. Existing global instructions are preserved.

For a no-change preview, run:

```bash
npm run install:codex -- --dry-run
```

Dry-run JSON output is intended for automation and keeps the install plan stable:
each step reports `status: "dry-run"` and omits timing fields. Human output is
more direct: success says no manual Codex configuration is needed, and failures
include "Next:" suggestions for the most likely recovery path.

To prepare a folder or zip for another local Codex user before marketplace
publication, run:

```bash
npm run share:package
npm run share:package -- --zip
```

The share package includes `START-HERE.md`, `install.command`, the plugin
payload, docs, schemas, and demo fixtures. It excludes runtime and repository
state such as `.git`, `.agentshell`, `artifacts`, and `node_modules`.

For manual local development, `npm link` is the simplest way to put `agentshell` on PATH.

To surface the plugin in Codex's default personal marketplace, run:

```bash
npm run plugin:install-local
```

This copies the plugin to `~/plugins/agentshell` and upserts the marketplace entry in
`~/.agents/plugins/marketplace.json`.

To install the current marketplace copy into Codex's plugin cache:

```bash
codex plugin add agentshell@personal
npm run plugin:smoke
```

`plugin:smoke` also verifies that the installed payload excludes runtime and
generated state directories such as `.agentshell`, `.git`, `artifacts`, and
`node_modules`, and that the installed skill keeps the compact start/entry
first-pass recommendation.

## Uninstall Notes

Use the managed lifecycle instead of editing Codex state by hand:

```bash
npm run update:codex
npm run doctor:codex
npm run uninstall:codex
```

Updates stage a complete copy before an atomic swap, retain three backups, and
roll back after a later validation failure. Uninstall removes only AgentShell's
marketplace entry, plugin directory, cache directory, Dashboard process, and
managed AGENTS policy block. The source checkout is left untouched.

Later plugin distribution can add:

- personal Codex marketplace entry
- packaged release artifact
- optional MCP server, kept lower priority than the local CLI/plugin flow until
  the primary contracts stabilize
