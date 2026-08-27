# Compact Semantic Quality Corpus

This offline golden corpus checks that compact responses retain enough evidence
for an agent to act without reopening the full log. It covers supported failure
shapes across JavaScript, TypeScript, Go, Python, and Java.

Run the deterministic acceptance gate with:

```bash
node scripts/compact-semantic-evaluator.js
```

The command fails when any semantic metric falls below 98%, a suggested command
is not directly executable, or a response exceeds the shared compact budget.
Fixtures contain synthetic error text only; no network, toolchain, clock, or
workspace state is consulted.
