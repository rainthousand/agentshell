# Codex Beta Evidence

For the external-user handoff and acceptance gates, see [External Beta Playbook](external-beta-playbook.md). Aggregate successful exports and failure envelopes with `npm run beta:funnel -- --input <evidence.json> [--input <failure.json> ...]`.

AgentShell v1.0 needs evidence from real users and real Codex tasks, not only local
fixtures. The user-facing collection step can verify and export in one command:

```bash
agentshell trial export --verify --rating 5
```

The command writes `agentshell-trial-<timestamp>.json` to the user's Desktop when
available. A user who does not work in a terminal can ask Codex:

> Please run `agentshell trial export --verify --rating 5` in this project, then
> tell me where the exported file is.

Use `agentshell trial status` when collection fails. It distinguishes a wrong
directory, a missing test script, missing AgentShell activity, stale evidence, and
a failed verification. From another directory, pass the project explicitly with
`--project /path/to/project`; AgentShell never edits a missing test script
automatically.

An optional 1-5 usefulness rating can be included without adding a form:

```bash
agentshell trial export --rating 5
```

## What The Export Contains

- normalized AgentShell command names and flags;
- per-command wall-clock duration and estimated output tokens;
- raw verification output token estimate when AgentShell observed one;
- final pass/fail evidence from the latest AgentShell run;
- installed plugin version and anonymous runtime shape;
- a clear statement of telemetry coverage and privacy omissions.

The shared JSON omits stdout, stderr, file contents, absolute paths, user and host
names, environment variables, and command argument values that may contain project
data. Users should still review the small JSON file before sharing it.

## Measurement Boundary

The exporter does not have access to Codex model input/output token accounting or
to commands executed outside AgentShell. Therefore:

- `agentShellEstimatedTokens` measures AgentShell JSON output only;
- `tokenSavingsPercentVsRawVerify` compares compact AgentShell output with raw test
  output observed by AgentShell;
- `observedDurationMs` covers the captured AgentShell command sequence;
- none of these fields should be presented as full-session Codex usage.

When an export declares that non-AgentShell commands are not observable, the
collector does not interpret a zero noisy-command count as proof of zero noise.
The noise-control criterion receives zero points and the aggregate report increments
`unobservedNoiseRuns`.

## Internal End-To-End Smoke

The installed plugin was exercised in a clean temporary copy of the failing-test
demo before external collection:

- one `fix test --fast --compact` command repaired and verified the failure;
- three AgentShell commands produced an estimated 683 output tokens;
- measured command execution totaled 491 ms;
- observed elapsed time across the command sequence was 29.2 seconds;
- final verification passed and the observability-adjusted score was 90/100;
- noise control was marked unobserved, not incorrectly counted as zero noise.

The generated reports are
`artifacts/codex-plugin-p0-internal-smoke.json` and
`artifacts/codex-plugin-p0-internal-smoke.md`. This is an internal integration
check, not external-user evidence. It also does not support a positive
token-savings claim by itself because the full compact
workflow output was larger than the raw verification output for this tiny fixture.

## Evaluator Flow

Collect one or more user exports without editing them:

```bash
npm run codex:plugin:collect -- \
  --input /path/to/user-1.json \
  --input /path/to/user-2.json \
  --input /path/to/user-3.json \
  --report artifacts/codex-beta/report.json \
  --markdown artifacts/codex-beta/report.md
```

External collection is optional and has no minimum-user release threshold.
Accepted evidence should still have passing final verification, no placeholder
data, and a reviewable export. Token and speed claims must state the measurement
boundary above.
