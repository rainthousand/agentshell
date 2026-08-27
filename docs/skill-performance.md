# Skill performance guardrails

AgentShell treats `SKILL.md` as an activation router, not a complete command manual. The static checks in this repository keep that activation context measurable while allowing detailed guidance to live under `references/` and load only when needed.

## Metrics

`scripts/skill-performance.js` reports:

- total UTF-8 bytes, lines, and estimated tokens for the main `SKILL.md`;
- frontmatter bytes, lines, estimated tokens, parsed metadata, and description tokens;
- body bytes, lines, and estimated tokens;
- files under `references/`, their aggregate size, and links from the main body;
- missing linked reference files;
- budget checks for the main Skill and its description.

Token estimates use `ceil(UTF-8 bytes / 4)`. This is a deterministic static proxy, not provider billing or tokenizer telemetry. It is intended for regression detection and A/B comparison.

Default budgets:

| Surface | Budget |
| --- | ---: |
| Main `SKILL.md` | 1,200 estimated tokens |
| Frontmatter `description` | 120 estimated tokens |

Run a report without enforcing the budget:

```bash
node scripts/skill-performance.js --skill skills/agentshell/SKILL.md
```

Use `--gate` when a budget failure should return exit code 1:

```bash
node scripts/skill-performance.js --skill skills/agentshell/SKILL.md --gate
```

Budgets can be overridden with `--max-skill-tokens` and `--max-description-tokens`.

## Static A/B evaluation

Compare the current Skill with a candidate before replacing it:

```bash
node scripts/skill-ab-eval.js \
  --current skills/agentshell/SKILL.md \
  --candidate /path/to/candidate/SKILL.md \
  --output /tmp/agentshell-skill-ab.json \
  --gate
```

The comparison reports the estimated activation-context token reduction, reduction percentage, bytes, lines, description size, and reference payload size. Reference tokens are deliberately excluded from activation-context savings because reference files are expected to be loaded on demand.

The A/B report passes only when the candidate stays within both budgets and does not grow the estimated activation context. This is a static guardrail; model routing accuracy, time to first tool call, prompt-cache behavior, and end-to-end latency require a separate runtime evaluation.
