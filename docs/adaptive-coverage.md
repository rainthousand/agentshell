# Adaptive command coverage

From a project root, run `agentshell coverage candidates --limit 10` to inspect the bounded candidate list. Use `npm run coverage:adaptive -- --input observations.json --gate` for offline intake and configurable promotion thresholds.

AgentShell can turn privacy-safe external command observations into a ranked backlog of unsupported command families. This module is deliberately independent from the main CLI and command registry: it produces evidence and implementation drafts, but never changes production profiles automatically.

## Input contract

By default, the helper reads `.agentshell/command-observations.jsonl` from the selected workspace through the existing command-coverage reader:

```bash
node scripts/adaptive-coverage.js --root /path/to/workspace
```

An explicit JSON array, an object with an `observations` array, or JSONL can be supplied with `--input`. Inputs must already follow the privacy-safe observation contract. Raw `argv`, arguments, command lines, paths, working directories, stdout, stderr, output, and raw event IDs are rejected.

Only these signals affect ranking:

- normalized executable family;
- supported or unsupported classification;
- normalized category;
- observation count;
- distinct source count, without exposing source names.

The report never writes observations and never includes arguments, paths, output, source names, event identifiers, or fingerprints.

## Ranking and drafts

Only observations without a supported replacement become candidates. Priority is a bounded 0-100 score:

- frequency relative to the promotion count: up to 50 points;
- share of all unsupported observations: up to 30 points;
- distinct source evidence relative to the promotion threshold: up to 20 points.

Each returned candidate includes a generic bounded-summary profile draft, a three-scenario fixture draft, and explicit promotion checks. These are review inputs, not generated executable code.

## Thresholds

Defaults:

| Threshold | Default |
| --- | ---: |
| Candidate minimum observations | 2 |
| Candidate minimum priority score | 20 |
| Promotion minimum observations | 10 |
| Promotion minimum sources | 2 |
| Promotion minimum priority score | 70 |
| Returned candidates | 10, hard maximum 25 |

Override them independently:

```bash
node scripts/adaptive-coverage.js \
  --input observations.jsonl \
  --candidate-min-observations 3 \
  --candidate-min-score 25 \
  --promotion-min-observations 20 \
  --promotion-min-sources 3 \
  --promotion-min-score 75 \
  --limit 15
```

`--gate` exits with status 1 when no candidate passes every promotion threshold. Invalid or unsafe input exits with status 2. Every successful and error response uses the stable `agentshell.adaptive-coverage.v1` protocol version, and successful candidate arrays are capped at 25 entries.

## Promotion workflow

1. Collect local privacy-safe observations.
2. Review ranked candidates and their score components.
3. For eligible candidates, turn the profile and fixture drafts into real bounded-output fixtures.
4. Verify exit status, diagnostic recall, and output budget before adding a production profile.
5. Keep promotion human-reviewed; telemetry alone must not alter command execution behavior.
