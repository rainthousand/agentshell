# AgentShell

AgentShell is an agent-native local CLI and Codex plugin for coding assistants.

It turns noisy terminal workflows into compact JSON that an AI agent can act on:
read only the lines it needs, diagnose failing tests, suggest conservative
patches, apply hash-checked edits, verify the result, and report rollback
commands.

Use it when raw shell output is wasting context. AgentShell is built for:

- **Less token burn:** compact test summaries instead of full terminal logs.
- **Less terminal noise:** structured `relatedFiles`, `logRef`, next actions,
  schemas, and machine-readable errors.
- **Faster failing-test repair:** one-command diagnose/suggest/apply/verify for
  supported JavaScript and TypeScript failures.
- **Safer agent edits:** hash-checked change plans, dry runs, and undo guidance.

Start here: [Quickstart](docs/quickstart.md). For a PM-friendly product summary,
see [Product Status](docs/product-status-pm.html). For scope, freeze criteria,
and fallback behavior, see [Product Boundary](docs/product-boundary.md). Stable
release details are in [V1.0 Release Notes](docs/release-notes-v1.0.md), with
security reporting covered by [SECURITY.md](SECURITY.md).

Download the current public release:
[AgentShell V1.0 Codex plugin ZIP](https://github.com/rainthousand/agentshell/releases/download/v1.0.0/agentshell-codex-plugin.zip).
The matching checksum and release audit report are on the
[V1.0 release page](https://github.com/rainthousand/agentshell/releases/tag/v1.0.0).

Latest local evidence in this tree: `agentshell verify test` reduced default
test-output context by about **94%** versus raw `npm test` on the noisy demo.
On the checked-in repair fixture suite, `real-project-eval --mode fix-first
--runs 3` passed **51/51** repeated repair runs with **262** estimated output
tokens per repair run on average. Compared with running one full raw/split/fix
matrix across the same checked-in fixtures, the one-run average fix-first path
reduced estimated output tokens from **22,112** to **4,459**.
The compact diagnose path now also skips generic file reads and symbol search
for deterministic TypeScript and import-path diagnostics; local profile samples
show those diagnoses completing their AgentShell-side work in about 16-18ms when
the verification result is cached.
On three local healthy real-project snapshots, fix-first preserved **9/9**
repeated passing smoke runs with **194** estimated output tokens per run.
See [Benchmarks](#benchmarks).

## Quick Start

The V1.0 release package includes a native Apple Silicon CLI. End users do not
need Node.js, npm, Bun, or a source checkout. Maintainers building from source
need Node.js 20+ and the pinned release toolchain.

Full guide: [docs/quickstart.md](docs/quickstart.md).

For a non-developer Codex user with a share package:

1. Unzip it, if needed, and open the `agentshell-codex-plugin` folder.
2. Double-click `install.command`. If Terminal is easier, run:

   ```bash
   ./install.command
   ```

3. Quit and reopen Codex, then start a new Codex thread.
4. Verify by asking Codex to use AgentShell, or run `agentshell start --compact`.

After a successful install, no manual Codex configuration or instruction
copy/paste is needed. Existing global instructions are preserved. On macOS the
installer also creates and starts an AgentShell-owned menu-bar LaunchAgent;
updates replace it atomically, `doctor:codex` checks it, and uninstall removes it
only while its recorded configuration is unchanged. AgentShell commands publish
path-free snapshots to `~/.agentshell/dashboard-snapshots`, so the LaunchAgent
does not need permission to open each source project while refreshing metrics.

To preview the exact install sequence without changing files, links, or Codex
settings:

```bash
agentshell setup codex install --channel stable --dry-run
```

Lifecycle commands are symmetric and rollback-aware:

```bash
agentshell setup codex update --channel stable
agentshell setup codex doctor
agentshell setup codex uninstall
agentshell support export --out agentshell-support.zip
```

Install and update stage a complete copy before swapping it into place, retain up
to three backups, and restore the previous installation automatically when later
validation fails. Share packages include double-clickable update, check, and
uninstall commands.

If the installer stops, read the "Next:" lines at the bottom of the output;
they point to the command or setup step to retry.

Check AgentShell itself from this checkout:

```bash
node src/cli.js start --compact
node src/cli.js manual
node src/cli.js manual --topic onboarding
```

Try the repair loop in a prepared demo fixture:

```bash
cd examples/failing-test-demo
node ../../src/cli.js fix test --safe --compact
node ../../src/cli.js fix test --fast --compact
```

Or link the binary locally and use it inside a target project that has a
`package.json` test script:

```bash
npm link
agentshell start --compact
agentshell fix test --safe --compact
agentshell fix test --fast --compact
```

The V1.0 managed installer adds `~/.local/bin` to supported shell profiles when
needed. Until a new shell is opened, or when working without the installer, use
`node src/cli.js <command>` from this checkout or `bin/agentshell <command>` from
a source/plugin-cache checkout.

## Before / After

**Before: raw terminal output**

```bash
npm test
```

The agent receives long logs, stack traces, repeated noise, and has to infer
which files to inspect next.

**After: compact agent workflow**

```bash
agentshell start --compact
agentshell diagnose test --compact
agentshell change suggest --dry-run --compact
agentshell change suggest --apply --compact
agentshell verify test
```

The agent receives JSON with the failure summary, related files, suggested next
actions, safe change templates, operation IDs, and rollback commands.

For supported failures, collapse the loop to one command:

```bash
agentshell fix test --fast --compact
```

Use preview-first mode when you want the suggestion without changing files:

```bash
agentshell fix test --safe --compact
```

## Core Commands

### Understand and read

```bash
agentshell manual
agentshell manual --topic repair
agentshell start --compact
agentshell entry --compact
agentshell doctor
agentshell plugin status --compact
agentshell understand --compact
agentshell find <query>
agentshell read <file> --lines A:B
agentshell read <file> --around <query>
```

### Test and repair

```bash
agentshell verify test
agentshell verify test --tail N
agentshell diagnose test --compact
agentshell fix test --fast --compact
agentshell fix test --safe --compact
agentshell change suggest --dry-run --compact
agentshell change suggest --apply --compact
agentshell undo [operationId]
```

### Logs, task state, and cost

```bash
agentshell log get <logRef> --tail N
agentshell run next
agentshell run status --compact
agentshell run latest --compact
agentshell metrics --compact
agentshell metrics --compact --since 24h
agentshell metrics --compact --scope global
agentshell metrics export --out metrics-evidence.json --since 7d
agentshell trial export --rating 1-5
agentshell dashboard
```

After a real Codex task, `agentshell trial export --verify --rating 5` verifies the
project and creates a small redacted JSON evidence file on the user's Desktop. It includes AgentShell command duration,
output-token estimates, final verification, and plugin version while omitting logs,
file contents, paths, user/host names, and environment variables. See
[Codex Beta Evidence](docs/codex-beta-evidence.md) for the non-developer handoff and
the exact measurement boundary; it does not claim visibility into full Codex model
tokens or commands run outside AgentShell.
Use `agentshell trial status` to diagnose the wrong directory, a missing test
script, stale evidence, or a failed verification before asking a user to retry.

### Local Dashboard

Run `agentshell dashboard` on macOS to open the native AgentShell menu-bar utility.
The status item shows compact verified savings such as `AS 79K`; clicking it shows
the full `Verified savings` and cache-backed `Time saved` values. It refreshes every
five seconds, does not appear in the Dock, and does not open a window by default.
The local read-only service binds to `127.0.0.1` and never uploads file contents or
command output. Metrics v2 labels measured, estimated, unavailable,
exact-attribution, and legacy-fallback values explicitly.

Use `agentshell dashboard --window` for the optional detailed panel,
`agentshell dashboard --browser` for the browser UI, or `agentshell dashboard
--no-open` when another process will open or embed the local URL. Non-macOS hosts
currently use the browser surface automatically.
The Dashboard is a user-level singleton. Repeated launches reuse a healthy matching
process, while stale versions are stopped before replacement. Use
`agentshell dashboard --status` and `agentshell dashboard --stop` for lifecycle
control.

### Protocol and integration

```bash
agentshell schema list
agentshell schema get <name>
agentshell benchmark test
```

AgentShell JSON contracts are documented in [docs/protocol.md](docs/protocol.md),
with compatibility rules in
[docs/protocol-versioning.md](docs/protocol-versioning.md). Integrations should
use `agentshell schema list` and `agentshell schema get <name>` as the schema
source of truth.

### Plugin self-diagnosis

Use `agentshell plugin status --compact` for the quick in-plugin health check,
or `npm run plugin:doctor-local` while working from this repo. Both reports
include the next repair command when something is blocked:

- Missing or stale personal marketplace: `npm run plugin:install-local`
- Missing or stale Codex plugin cache: `codex plugin add agentshell@personal`
- Full local refresh when several checks fail: `npm run plugin:release-local`

## Product Readiness

Before handing a checkout to another developer, run the lightweight product gate:

```bash
npm run product:readiness
npm run product:readiness -- --markdown
npm run product:readiness -- --heavy --dry-run
```

It checks the external trial surface: quickstart, PM status page, workflow docs,
Codex plugin docs, adapter trial suite, manual topics, package scripts, and JSON
schema registry. Heavy mode adds benchmark CI, cache/cold-start checks, strategy
coverage, Codex plugin trial scoring, and strategy intake. Use
[Product Boundary](docs/product-boundary.md) as the freeze/scope contract for
V1.0. MCP remains deferred and non-blocking for this phase.

The current Core release is `1.0.0`. The source is published in the public
[AgentShell GitHub repository](https://github.com/rainthousand/agentshell). Local release
artifacts, the share ZIP, checksum verification, archive integrity, and the
isolated-HOME packaged lifecycle smoke are complete. GitHub Release `v1.0.0`
is published, and its downloaded binary, ZIP, checksums, and audit report have
been verified. Three fresh verified
tasks from external users are no longer a release requirement. External trial
exports remain available as an optional post-release learning channel.

V1.0 is a Core GitHub/Codex plugin release. Its published assets are the source,
Codex plugin ZIP, standalone CLI, SHA-256 checksums, and release audit report.
It does not publish a native PKG or use App Store distribution, and therefore
does not require Apple Developer credentials. The standalone CLI and optional
menu-bar Dashboard are not represented as Apple-notarized software; a signed
Desktop release is deferred.

## Share Package

For a local real-user handoff or release-candidate inspection, create a share
package:

```bash
npm run share:package
npm run share:package -- --zip
```

The package includes the source, plugin metadata, `install.command`,
`check-install.command`, docs, schemas, and demo fixtures needed for local Codex installation. It excludes
`.git`, `.agentshell`, `artifacts`, and `node_modules`, and writes a short
`START-HERE.md` for non-developer users: unzip, double-click or run
`npm run install:codex`, restart Codex, and verify in a new Codex thread. The
installer keeps `agentshell-install.log` when support is needed; the check command
writes `agentshell-install-check.json` to the Desktop for a review-before-sharing
health report.

Before handing off a candidate, run `npm run package:lifecycle:smoke` against the
generated delivery directory. It exercises packaged install, update, doctor, and
uninstall in an isolated HOME without changing the developer's Codex state.
ZIP delivery uses maximum compression and must pass an immediate archive
integrity check. `npm run release:artifacts` also records checksums, standalone
builder versions, package compression ratio, and blocking size budgets in
`artifacts/release/release-report.json`.

Standalone executables are build outputs rather than repository source. Git
ignores `bin/agentshell-darwin-arm64`; tagged releases rebuild and audit it with
the pinned toolchain, then publish the executable, checksums, plugin ZIP, and
release report as GitHub Release Assets.

The latest local Dashboard snapshot covers 30 registered workspaces and reports
351,219 verified context tokens avoided, 12.371 seconds of verified time saved, and 83%
exact attribution. These are point-in-time measurements from this development
machine, not a general performance promise or full Codex session accounting.

Key workflow topics:

```bash
agentshell manual --topic onboarding
agentshell manual --topic log-triage
```

`agentshell start --compact` and its alias `agentshell entry --compact` return a
single slim `agentshell.start.v1` JSON response with readiness summary,
workspace shape, and the next recommended action without three separate shell
round trips. Use plain `agentshell start` when an agent needs the full embedded
`doctor`, compact `understand`, and `run next` payloads for debugging.

## Failing-Test Repair

`agentshell fix test --fast --compact` is the explicit fast path for supported
failing-test repairs. It diagnoses the failure, generates a conservative edit,
applies it through the safe change path, verifies the result, and returns compact
JSON with rollback guidance.

Current automatic strategies are intentionally narrow:

- Missing object properties from assertions or flat `assert.deepEqual` objects.
- Missing array elements from simple `assert.deepEqual` arrays.
- Extra tail elements from simple `assert.deepEqual` arrays.
- Extra simple properties from actual `assert.deepEqual` objects via `deep-equal-extra-property-removal`.
- Single primitive element mismatches from simple `assert.deepEqual` arrays via `deep-equal-array-primitive-replacement`.
- Small returned-array length shortfalls.
- Simple wrong literal replacements.
- Empty `join('')` separator repairs.
- Simple string case-transform repairs when the assertion value differs only by case.
- Simple falsy returns for truthy assertions.
- Missing named exports when one declaration is the clear match.
- Relative import path typos or extension mismatches with one clear local match.
- Narrow TypeScript diagnostics for concrete primitive literals, missing
  required properties, and clear property-name suggestions.

Unsupported failures should remain structured refusals with enough context for
the agent to choose the next command.

## Benchmarks

Run the compact-output benchmark:

```bash
npm run benchmark
```

Current noisy-demo result:

| Path | Output Chars | Estimated Tokens | Result |
|---|---:|---:|---|
| Raw `npm test` | 14,851 | 3,713 | failing test output |
| `agentshell verify test` | 848 | 212 | compact failure summary |

Run the multi-case repair suite:

```bash
npm run benchmark:suite
npm run benchmark:suite:ci
node scripts/benchmark-suite.js --ci --report artifacts/benchmark-suite.json --markdown artifacts/benchmark-suite.md
```

The suite compares:

- `raw`: run `npm test` directly.
- `split`: diagnose, suggest/apply, then verify.
- `fix`: run `agentshell fix test --compact`.

Run the Codex-style end-to-end comparison:

```bash
npm run codex:e2e
```

Run the benchmark inside any package with a test script:

```bash
agentshell benchmark test
```

For details, see [docs/benchmark-evidence.md](docs/benchmark-evidence.md),
[docs/benchmark.md](docs/benchmark.md),
[docs/benchmark-suite.md](docs/benchmark-suite.md), and
[docs/codex-e2e-benchmark.md](docs/codex-e2e-benchmark.md).

## Adapter Guides

AgentShell can generate drop-in instruction templates for Claude Code,
Cursor/Windsurf, and generic `AGENTS.md` integrations:

```bash
npm run --silent adapter:generate -- <claude|cursor|agents-md>
npm run --silent adapter:generate -- --benchmark-prompts
npm run --silent adapter:trial -- --input examples/adapter-trial.sample.json
npm run --silent adapter:trial:collect -- --input examples/adapter-trial-collect.sample.json
npm run --silent adapter:trial:suite -- --manifest examples/adapter-trial-suite.sample.json
```

Use `adapter:trial:suite` for multi-host or multi-project comparisons. It aggregates scored/collected runs into average score, strong/usable/weak counts, host-level totals, output tokens, duration, AgentShell command count, and noisy raw command count.

Generate project-local instruction packages with:

```bash
npm run --silent adapter:generate -- --package claude ./agentshell-claude-adapter
npm run --silent adapter:generate -- --package cursor ./agentshell-cursor-adapter
```

See [docs/adapters](docs/adapters/README.md).
For multi-host evidence collection, see the
[Adapter Trial Suite Playbook](docs/adapters/trial-suite-playbook.md).

## Codex Plugin Flow

Recommended first pass for Codex plugin threads:

```bash
agentshell start --compact
agentshell fix test --fast --compact
# or, when automatic repair is not safe:
agentshell diagnose test --compact
agentshell verify test
```

In short: `start --compact -> fix/diagnose/verify`.

Keep MCP as a later, lower-priority integration path; the local CLI and plugin
flow are the supported V1.0 path.

```bash
npm run plugin:validate
npm run plugin:smoke
npm run codex:e2e
```

See [docs/codex-plugin-flow.md](docs/codex-plugin-flow.md). If `PATH` does not
include `agentshell`, run `node src/cli.js manual` or `bin/agentshell manual`
from the checkout/cache.

`agentshell manual` is compact by default. Use `agentshell manual --topic repair|plugin|benchmark|profile|onboarding|log-triage|reference` for focused workflows, or `agentshell manual --full` for the complete command map.

## Demo

```bash
cd examples/failing-test-demo
node ../../src/cli.js doctor
node ../../src/cli.js understand
node ../../src/cli.js diagnose test --compact
node ../../src/cli.js fix test --safe --compact
```

## Safe Change Format

```json
{
  "reason": "Return an id from createUser",
  "dryRun": false,
  "edits": [
    {
      "file": "src/user.js",
      "expectedHash": "sha256:...",
      "range": {
        "start": 2,
        "end": 5
      },
      "replacement": "  return { id: \"user_1\", ...input };"
    }
  ]
}
```

Always use the current hash returned by `agentshell read`.

## More

- [v0.25 release notes](docs/release-notes-v0.25.md)
- [v0.24 release notes](docs/release-notes-v0.24.md)
- [Quickstart](docs/quickstart.md)
- [Product status for PMs](docs/product-status-pm.html)
- [AgentShell workflows](docs/workflows/README.md)
- [MCP interface scope](docs/mcp-interface.md)
- [Real-project evaluation](docs/real-project-eval.md)
- [Real-project evidence](docs/real-project-evidence.md)
