# Performance SLA and Regression Gate

AgentShell keeps four performance claims as explicit, independently measured
checks. A missing measurement is `unavailable`; it is never converted to zero
or treated as a pass.

| Check | Default target | Measurement |
| --- | ---: | --- |
| Core inspection cold-start p95 | `< 150ms` | Nearest-rank p95 of `start --compact` external wall-clock samples |
| AgentShell overhead | `< 5%` | Comparable AgentShell and raw baseline wall times only |
| Compact output | `<= 3,000` estimated tokens | Maximum sampled output size, estimated as four characters per token |
| Cache-hit speedup | `> 50%` | End-to-end wall-clock miss versus hit comparison |

The token number is an output-size estimate, not a tokenizer count and not the
model's total session usage. The overhead check stays unavailable unless the
input explicitly marks its baseline as semantically comparable.

## Deterministic Gate

CI should use a checked-in or generated sample with stable numeric inputs:

```bash
node scripts/performance-sla.js \
  --input tests/fixtures/performance-sla/passing.json \
  --gate \
  --output artifacts/performance-sla.json
```

`--gate` exits non-zero when any required check fails or is unavailable. Without
`--gate`, the command still reports the same status but does not fail the shell;
this is useful while collecting incomplete evidence.

Thresholds are configurable without changing code:

```bash
node scripts/performance-sla.js --input sample.json --gate \
  --max-cold-start-p95-ms 150 \
  --max-overhead-percent 5 \
  --max-compact-tokens 3000 \
  --min-cache-speedup-percent 50
```

## Local Probe

Real local measurements are intentionally separate from deterministic fixture
tests because scheduler load, filesystem cache state, and machine hardware can
change wall-clock results:

```bash
node scripts/performance-sla-probe.js \
  --runs 7 \
  --output artifacts/performance-sla-sample.local.json

node scripts/performance-sla.js \
  --input artifacts/performance-sla-sample.local.json \
  --output artifacts/performance-sla.local.json
```

The probe reuses the existing cold-start benchmark, compact contract audit, and
cache benchmark. It does not invent an overhead baseline, so that check is
normally unavailable. Supply an externally collected normalized sample only
when the baseline performs the same work over the same fixture and environment.
An unrelated row may make an upstream benchmark report non-zero; the probe still
retains valid target measurements and records each upstream report's `ok` value
in `evidence` instead of discarding the entire run.

## Input Contract

The normalized sample shape is deliberately small:

```json
{
  "protocolVersion": "agentshell.performance-sla-sample.v1",
  "source": { "mode": "fixture", "description": "controlled sample" },
  "measurements": {
    "coldStartMs": [90, 100, 110],
    "overheadComparison": {
      "comparable": true,
      "baselineMs": 1000,
      "agentshellMs": 1040
    },
    "compactEstimatedTokens": [400, 1200],
    "cacheComparison": { "missMs": 400, "hitMs": 190 }
  }
}
```

The versioned report contract is documented by
`schemas/performance-sla.schema.json`.
