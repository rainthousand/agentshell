# CLI startup performance

## Current observation

`node src/cli.js manual` spends most of its cold-start time loading the shared CLI entrypoint, not building the manual response. The entrypoint statically imports every command and several cross-cutting subsystems before dispatching even lightweight commands such as `--version`, `--help`, and `manual`.

A 20-sample local baseline (five warm-up runs excluded) measured `manual` at 171.67 ms median and 350.57 ms p95. These numbers are machine-specific and should be compared on the same host.

After reducing the default manual from 5,773 to 1,801 output characters, a 30-sample run on the same host measured 168.18 ms median and 211.36 ms p95. Output size fell by 68.8%, while median startup was effectively unchanged. A second independent 30-sample run under higher host load measured 285.13 ms median and 820.94 ms p95, so wall-time comparisons need isolated, repeated runs rather than a single favorable sample.

Calling the already-imported manual implementation 100,000 times averaged 0.000155 ms per call. Payload construction is therefore negligible compared with process and module startup, even allowing for benchmark noise. The practical optimization target is the shared eager import graph.

## Recommended optimization

Move command implementations behind dynamic imports after the top-level command has been parsed. Keep only argument dispatch, output helpers, and the small command registry on the eager path. Start with `--version`, `--help`, and `manual`, then compare cold-start median and p95 while running the complete CLI test suite.

Do this as a dedicated refactor because `src/cli.js` currently contains command-specific option parsers and shared event recording. Mixing lazy loading into an output-budget change would enlarge the regression surface. A successful implementation must preserve exit codes, JSON protocol versions, profiling, metrics events, and dashboard snapshot updates.

Skill loading follows the same progressive-disclosure rule. `skills/agentshell/SKILL.md` is a routing index with the activation contract and first pass only. Workflow details live under `skills/agentshell/references/` and are loaded on demand. The quality test caps the main skill at 800 estimated tokens while separately checking every linked reference.

## Measurement gate

Use at least 30 measured runs after warm-up and report median and p95 for:

- `node src/cli.js --version`
- `node src/cli.js manual`
- `node src/cli.js pwd --compact`
- `node src/cli.js start --compact --profile`

Accept the refactor only when lightweight commands improve without a statistically meaningful regression in `start --compact` or command contract tests.

## Contract gates

Run both audits after adding or renaming a command, schema, or Skill example:

```bash
node scripts/command-contract-audit.js
node scripts/compact-contract-audit.js
```

The command audit compares the public help registry, every packaged Schema filename, the package binary entry, and all explicit `agentshell` examples in the Skill and focused references. It fails on duplicate registrations, missing or unregistered Schemas, broken package binaries, or documentation that names a command outside the public registry. The compact audit separately executes representative commands and enforces the JSON and output-size contract.

These gates are intentionally static and fast. They detect contract drift; CLI behavior remains covered by command smoke and integration tests.
