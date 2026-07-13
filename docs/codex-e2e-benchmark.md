# Codex E2E Benchmark Plan

Goal: compare ordinary Codex shell behavior with Codex guided by the AgentShell plugin skill.

## Scenario

Use `examples/noisy-test-demo`.

Task prompt:

```text
Fix the failing test in this project. Prefer AgentShell when available.
```

## Baseline: Ordinary Shell

Record:

- elapsed time from first command to passing test
- number of shell commands
- total command output chars
- estimated output tokens, using `ceil(chars / 4)`
- whether raw logs were read directly
- whether the fix passed on first attempt

## AgentShell Plugin Path

Expected flow:

```bash
agentshell doctor
agentshell manual
agentshell understand --compact
agentshell fix test --compact
agentshell run status --compact
agentshell metrics --compact
```

Record the same metrics as the baseline.

## Target Result

- output tokens reduced by 70%+
- end-to-end fix time improved by 30%+
- command count reduced by 30%+
- no raw log read unless `summary` is insufficient
- edit can be reverted with `agentshell undo`

## Current Single-Step Evidence

On `examples/noisy-test-demo`:

```text
raw npm test: 14,851 chars, about 3,713 tokens
agentshell benchmark/verify: 703 chars, about 176 tokens
context reduction: 95%
```

## Current Simulated Plugin Flow

Run:

```bash
npm run codex:e2e
```

This copies `examples/noisy-test-demo` to a temporary workspace and executes the AgentShell-guided
flow that the Codex plugin should encourage.

Latest legacy result:

```text
core fix flow before diagnose: 7 AgentShell commands
core fix output before diagnose: 3,700 chars, about 925 tokens
single raw failure output: 14,868 chars, about 3,717 tokens
core flow vs one raw failure: 75% less output
final verify: passing
```

The full session includes `agentshell doctor`, `agentshell manual`, and
`agentshell metrics --compact`, which are useful for setup and measurement but
should not be counted as recurring per-fix diagnosis cost.

## v0.24 Speed Path

`agentshell diagnose test --compact` combines the recurring failure-discovery loop into one command, includes a compact `fixPlan` target, writes a fillable `changeTemplate`, and supports previewing then applying conservative generated suggestions.
`agentshell fix test --compact` wraps the supported happy path into one agent command: diagnose, generate a conservative suggestion, apply it with hash checks, verify, and return rollback guidance.

```bash
agentshell fix test --compact
agentshell run status --compact
```

Split flow:

```bash
agentshell diagnose test --compact
agentshell change suggest --dry-run --compact
agentshell change suggest --apply --compact
agentshell verify test
agentshell run next
agentshell run status --compact
```

This should reduce the core fix loop from 7 commands to about 3-4 commands when the diagnosis is sufficient. The dry-run command is optional for automation speed, but useful when Codex wants a cheap safety check before applying.

Latest measured result on the noisy demo:

```text
legacy core flow: 7 commands, 3,700 chars, about 925 tokens, 2,259 ms
compact diagnose + suggested change/apply core flow: 4 commands, 4,054 chars, about 1,014 tokens, 672 ms
command reduction: 43%
token delta versus legacy AgentShell flow: +10%
elapsed-time improvement versus legacy AgentShell flow: 70%
compact diagnose + suggested change/apply core flow vs one raw failure: 73% less output
```

## v0.24 Slim One-Command Fix, Suggested Change Preview, Compact Run, Next, And Metrics

`agentshell run next` and `agentshell run status --compact` add task-level guidance over the diagnose/change/verify loop. They are observational and should not be counted as required fix commands, but they let Codex avoid reconstructing state from command history and logs.
`agentshell fix test --compact` is the preferred fast path when the task is to repair a supported failing test.

Latest run summary from the same E2E:

```text
fix full measured path: 6 commands, 13,476 chars, about 3,369 tokens, 742 ms
doctor setup output: 2,318 chars, about 580 tokens, 98 ms
fix core flow: 2 commands, 1,621 chars, about 406 tokens, 492 ms
fix command output: 1,008 chars, about 252 tokens, 406 ms
fix command reduction versus split diagnose flow: 50%
fix token reduction versus split diagnose flow: 64%
fix elapsed-time improvement versus split diagnose flow varies by local run
fix core flow vs one raw failure: 89% less output
run status: passed
run nodes: 3
run commands counted: 1
run next output: 232 chars, about 58 tokens
run status --compact output: 813 chars, about 204 tokens
run task output counted: 1,008 chars, about 252 tokens
run duration: 177 ms
diagnosis target: src/user.js
rollback command: agentshell undo <operationId>
next best action: null
metrics --compact output: 1,695 chars, about 424 tokens
full metrics output before compact: about 3,112 chars, about 778 tokens
metrics compact reduction: 47%
change suggest --dry-run --compact output: 734 chars, about 184 tokens
change suggest --apply --compact output: 802 chars, about 201 tokens
change suggest coverage: missing object properties, flat deepEqual missing properties, simple deepEqual array additions/removals, simple wrong literals, simple truthy-return assertions, and missing named exports
```
