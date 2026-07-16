# AgentShell Quickstart

This guide gets a local user from zero to a useful AgentShell run in about 5-10 minutes. You should see compact JSON readiness, a safe repair preview, an applied and verified supported fix, rollback guidance, and optional adapter scoring.

## Requirements

- macOS 13+ on Apple Silicon
- Codex desktop or CLI with local plugin support
- A project with a `package.json` test script for managed test repair

The release package includes the native CLI. Node.js 20+, Bun, npm, and a source
checkout are maintainer build requirements, not end-user requirements.

AgentShell runs locally. The core CLI does not need a service or API key.

The current Core release is `1.0.0`. Its local share ZIP and packaged
install/update/doctor/uninstall flow have been verified. GitHub Release
[`v1.0.0`](https://github.com/rainthousand/agentshell/releases/tag/v1.0.0)
contains the standalone binary, plugin ZIP, checksums, and audit report;
clean downloaded copies passed checksum and standalone version verification.

## Easiest Codex Install

Download
[`agentshell-codex-plugin.zip`](https://github.com/rainthousand/agentshell/releases/download/v1.0.0/agentshell-codex-plugin.zip)
from the V1.0 release, or use a share package supplied by the publisher:

1. Unzip it, if needed, and open the `agentshell-codex-plugin` folder.
2. Double-click `install.command`. If you prefer Terminal, run:

   ```bash
   ./install.command
   ```

3. Quit and reopen Codex, then start a new Codex thread.
4. Verify by asking Codex to use AgentShell, or run `agentshell start --compact` in Terminal.

Success means the installer finished without a blocking error and says no manual
Codex configuration is needed. Existing global instructions are preserved. On
macOS the AgentShell savings item also appears in the menu bar automatically;
there is no separate Dashboard startup step.

To preview the same steps without changing anything, run:

```bash
./bin/agentshell-darwin-arm64 setup codex install --source "$PWD" --dry-run
```

Update, diagnose, or remove only AgentShell-managed state with:

```bash
agentshell setup codex update --channel stable
agentshell setup codex doctor
agentshell setup codex uninstall
agentshell support export --out agentshell-support.zip
```

The share package exposes the same actions through `update.command`,
`check-install.command`, and `uninstall.command`.

If installation stops, use the "Next:" lines in the output first. They name the
failed command and the most likely retry path, such as installing Codex,
rerunning with `--skip-link`, or retrying only the AgentShell policy step.

## For A Shared Folder

The share package is meant for local handoff: unzip, double-click
`install.command`, restart Codex, then verify in a new Codex thread.

The sender can create that folder or zip without publishing a plugin:

```bash
npm run share:package
npm run share:package -- --zip
```

The generated package includes a short `START-HERE.md` and excludes local state
such as `.git`, `.agentshell`, `artifacts`, and `node_modules`.

The source repository has already been imported and pushed privately; creating
this ZIP does not require publishing or changing the remote repository.

## Path A: Try The Local CLI

From the AgentShell checkout:

```bash
node src/cli.js start --compact
node src/cli.js manual
node src/cli.js manual --topic onboarding
node src/cli.js manual --topic repair
```

Expected result: compact JSON that reports local readiness, workspace shape, focused command guidance, and the next useful command.

## Path B: Run The Failing-Test Demo

```bash
cd examples/failing-test-demo
node ../../src/cli.js fix test --safe --compact
node ../../src/cli.js fix test --fast --compact
node ../../src/cli.js verify test
node ../../src/cli.js run status --compact
node ../../src/cli.js undo
```

Use `--safe` when you want a preview. Use `--fast` when you want AgentShell to apply and verify a conservative supported fix. `undo` restores AgentShell-managed edits after the demo.

## Optional: See Noise Reduction

```bash
cd examples/noisy-test-demo
npm test
node ../../src/cli.js verify test
node ../../src/cli.js benchmark test
```

The raw `npm test` output is intentionally noisy. `verify test` and `benchmark test` show why compact, structured output matters for agents.

## Path C: Use AgentShell In Your Own Project

From the AgentShell checkout:

```bash
npm link
```

Then in a target project:

```bash
agentshell start --compact
agentshell manual --topic onboarding
agentshell fix test --safe --compact
agentshell fix test --fast --compact
agentshell diagnose test --compact
agentshell verify test
agentshell run status --compact
```

If `agentshell` is not on `PATH`, use `node src/cli.js <command>` from the checkout or `bin/agentshell <command>` from a source/plugin cache.

## Path D: Validate The Codex Plugin Path

From the AgentShell checkout:

```bash
npm run plugin:validate
npm run plugin:validate:source
npm run plugin:smoke
node src/cli.js plugin status --compact
```

For local plugin development, publish a cachebusted local plugin only after tests pass:

```bash
npm run plugin:release-local -- --dry-run --compact
npm run plugin:release-local -- --compact --report artifacts/plugin-release-local.json
```

Open a new Codex thread after reinstalling so the updated skill and plugin cache are loaded.

## External Trial Readiness

Before sharing a checkout with another developer or PM, run the lightweight gate:

```bash
npm run product:readiness
npm run product:readiness -- --markdown
npm run product:readiness -- --heavy --dry-run
```

Expected result: `status` is `ready`, `summary.blockingFailed` is `0`, and any warning is explicitly non-blocking. The standard gate checks product entry points and contracts. Heavy mode additionally runs or dry-runs benchmark CI, cache/cold-start checks, strategy coverage, Codex plugin trial scoring, and strategy intake. Use [Product status for PMs](product-status-pm.html) and [Performance analysis](performance-analysis.md) for token reduction and speed evidence.

## Path E: Measure Adapter Behavior

Score one normalized run:

```bash
npm run --silent adapter:trial -- --input examples/adapter-trial.sample.json
```

Normalize a real host transcript or command log:

```bash
npm run --silent adapter:trial:collect -- --input examples/adapter-trial-collect.sample.json
```

Aggregate multiple host or fixture runs:

```bash
npm run --silent adapter:trial:suite -- --manifest examples/adapter-trial-suite.sample.json
```

Adapter trials measure behavior, not just correctness: did the agent call AgentShell early, avoid broad raw logs, verify the result, and report safety or rollback signals?

For a real Codex new-thread plugin run, record the commands and compact outputs
in the same shape as `examples/codex-plugin-new-thread.sample.json`, then run:

```bash
npm run --silent codex:plugin:template -- --json artifacts/codex-plugin-run-log.json --markdown artifacts/codex-plugin-run-log.md
npm run --silent codex:plugin:plan -- --runs 3 --out-dir artifacts/codex-plugin-plan --report artifacts/codex-plugin-plan/report.json --markdown artifacts/codex-plugin-plan/plan.md
npm run --silent codex:plugin:collect -- --input examples/codex-plugin-new-thread.sample.json
npm run --silent codex:plugin:collect -- --input run-log.json --report artifacts/codex-plugin-real-run.json --markdown artifacts/codex-plugin-real-run.md
npm run --silent codex:plugin:suite -- --manifest artifacts/codex-plugin-plan/suite.json --report artifacts/codex-plugin-suite.json --markdown artifacts/codex-plugin-suite.md
```

The template command returns `agentshell.codex-plugin-trial-template.v1`; the
collector returns `agentshell.codex-plugin-trial.v1`, the same protocol as the
synthetic Codex plugin effect trial. The plan command returns
`agentshell.codex-plugin-trial-plan.v1` for preparing several fresh-thread
capture forms at once. The suite command returns
`agentshell.codex-plugin-trial-suite.v1` for multi-run stability review.

## Workflows

- [Onboarding workflow](workflows/onboarding.md)
- [Log triage workflow](workflows/log-triage.md)

Machine-readable equivalents:

```bash
agentshell manual --topic onboarding
agentshell manual --topic log-triage
```

## Evidence And References

- [Product status for PMs](product-status-pm.html)
- [Demo v0.24](demo-v0.24.md)
- [Real-project evidence](real-project-evidence.md)
- [Performance analysis](performance-analysis.md)
- [Codex plugin flow](codex-plugin-flow.md)
- [Adapter guides](adapters/README.md)
- [Adapter trial suite](adapters/trial-suite.md)
- [Adapter trial suite playbook](adapters/trial-suite-playbook.md)
- [Protocol contracts](protocol.md)

## Caveats

Token counts are estimates using `ceil(chars / 4)`. Durations are local command timings and should be compared only within the same machine and fixture setup. Automatic repairs are intentionally conservative and cover supported JavaScript/TypeScript failure patterns, not arbitrary bugs. Unsupported failures should return structured context, `unsupportedReason`, and next actions instead of guessing.
