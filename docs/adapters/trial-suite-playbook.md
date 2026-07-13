# Adapter Trial Suite Playbook

Use this playbook when comparing AgentShell adapter behavior across hosts, fixtures, or repeated runs.

## Recommended Flow

```text
real host run -> collector -> trial scorecard -> suite aggregate -> PM/engineering report
```

1. Run the same task prompt in each host adapter.
2. Capture shell/tool commands, command output, duration, and final verification.
3. Normalize each run with `adapter:trial:collect` when starting from a transcript.
4. Score individual runs with `adapter:trial` when a normalized trial JSON already exists.
5. Aggregate all runs with `adapter:trial:suite`.

## Naming

Use stable ids that encode host, fixture, and run number:

```text
<host>-<fixture>-run<n>
codex-failing-test-demo-run1
claude-failing-test-demo-run1
cursor-array-length-run2
```

Recommended artifact names:

```text
artifacts/adapter-trial.<host>.<fixture>.json
artifacts/adapter-trial-collect.<host>.<fixture>.json
artifacts/adapter-trial-suite.<batch>.json
artifacts/adapter-trial-suite.<batch>.md
```

## PM Metrics

Report these first:

- average adapter score;
- strong / usable / weak distribution;
- host-level average score;
- first-two-command AgentShell hit rate;
- noisy raw command count;
- total and average output tokens;
- total and average duration;
- final verification success rate;
- safety or rollback signal rate.

Duration should be treated as same-machine, same-fixture evidence. Token counts are output-length estimates using the project-wide `ceil(chars / 4)` convention.

## Engineering Metrics

For debugging adapter instructions, inspect:

- first AgentShell command index;
- first noisy raw command index;
- missed criteria reasons;
- host runs that scored below 85;
- raw shell command count before AgentShell;
- commands that fetched broad logs or broad file dumps.

The suite does not change the scorecard. It only aggregates scored or collected trial evidence.
