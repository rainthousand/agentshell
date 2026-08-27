# Compact Semantic Quality

AgentShell treats output reduction as useful only when an agent can still make the same correct decision. The quality gate therefore measures semantics and size together.

Run the default corpus:

```bash
npm run quality:compact-semantic
```

The v2 report includes error recall, file and line accuracy, decision consistency, necessary-information retention, extra-read risk, and token reduction. It reports micro and macro scores globally and by language and scenario. A missing measurement is shown as `null`; it is not equivalent to a perfect score.

The default corpus contains JavaScript/TypeScript, Go, Python, and Java cases, including noisy logs and counterexamples. A candidate fails when it loses required diagnostics, changes the next action, encourages an unnecessary second read, exceeds the compact budget, or misses a configured reduction threshold.

Custom gates are available through flags such as `--min-error-recall`, `--min-file-accuracy`, `--min-line-accuracy`, `--min-decision-consistency`, `--min-information-retention`, `--max-extra-read-risk`, and `--min-token-reduction`. Use `--no-gate` only for exploratory reports.
