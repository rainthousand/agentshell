# Benchmark Suite

`scripts/benchmark-suite.js` runs a small benchmark against every case in
`examples/benchmark-cases`.
It copies each case into separate temporary workspaces and compares three paths:

- `raw`: run `npm test` directly.
- `split`: run `agentshell diagnose test --compact`, `agentshell change suggest --apply --compact`, then `agentshell verify test`.
- `fix`: run `agentshell fix test --compact`.

Run it with:

```sh
npm run benchmark:suite
```

The default output is JSON. A Markdown report is also available:

```sh
node scripts/benchmark-suite.js --markdown
node scripts/benchmark-suite.js --format markdown
```

CI artifact reports can be written without changing the default stdout JSON:

```sh
node scripts/benchmark-suite.js --report artifacts/benchmark-suite.json
node scripts/benchmark-suite.js --markdown artifacts/benchmark-suite.md
node scripts/benchmark-suite.js --ci --report artifacts/benchmark-suite.json --markdown artifacts/benchmark-suite.md
```

`--report <path>` writes the full JSON report. `--markdown <path>` writes the
Markdown summary report. The bare `--markdown` flag still prints Markdown to
stdout for local reading.

CI threshold mode turns the same benchmark into a quality gate:

```sh
npm run benchmark:suite:ci
npm run benchmark:suite -- --ci
npm run benchmark:suite -- --thresholds
```

In threshold mode, the command exits non-zero when a check fails and the JSON
report includes a `thresholds` object with `ok`, `maxFixTokens`, and detailed
`checks`. The default threshold rules are:

- every case-level `ok` must be true;
- `raw` must fail;
- `split` and `fix` must pass;
- `split` and `fix` must expose rollback guidance;
- `fix` must use no more than 1 command;
- `fix` must use no more than 260 estimated tokens.

The fix token ceiling can be overridden without adding a config file:

```sh
npm run benchmark:suite -- --ci --max-fix-tokens 300
node scripts/benchmark-suite.js --thresholds --max-fix-tokens=300
```

Markdown output can also include the threshold summary:

```sh
node scripts/benchmark-suite.js --markdown --ci
node scripts/benchmark-suite.js --ci --markdown artifacts/benchmark-suite.md
```

The script prints JSON with a `cases` object keyed by case name. Each case contains
`raw`, `split`, and `fix` rows:

- `ok`: whether that path ended in a passing test state.
- `commands`: number of commands run for that path.
- `chars`: total command output characters.
- `tokens`: estimated output tokens using `ceil(chars / 4)`.
- `durationMs`: total measured command duration for that row.
- `rollbackAvailable`: whether the row output exposed rollback guidance.
- `rollbackCommand`: rollback command when available, otherwise `null`.
- `events`: per-command status, character count, token estimate, duration, and rollback metadata.

Rollback availability is parsed from compact JSON command output. `fix` rows read
`rollbackCommand` directly when present. `split` rows can derive the same rollback
command from an applied `operationId`. Raw test rows usually report
`rollbackAvailable: false` and `rollbackCommand: null`.

The top-level `ok` is true when every case reproduces the raw failure and both
AgentShell repair paths pass.

When threshold mode is enabled, `thresholds.ok` is true only when every quality
gate check passes. Failed checks include their measured `actual` value and either
the required `expected` value or a numeric `max`.

Current cases:

- `deep-equal-array-elements`: appends simple missing array elements from an expected `assert.deepEqual` array.
- `deep-equal-array-removal`: removes simple extra tail array elements from an actual `assert.deepEqual` array.
- `deep-equal-missing-property`: adds a flat missing object property from an expected `assert.deepEqual` object.
- `deep-equal-extra-property-removal`: removes one simple extra property from an actual `assert.deepEqual` object.
- `deep-equal-array-primitive-replacement`: replaces one simple primitive element in an actual `assert.deepEqual` array.
- `array-length`: pads a short returned array in a narrowly bounded assertion mismatch.
- `join-separator-literal`: repairs an empty `join('')` separator when assertion strings identify the missing separator.
- `string-case-transform`: repairs a simple case-only string mismatch.
- `import-path-typo`: repairs a local import path typo when one nearby file is the only match; the same conservative `import-path` strategy also covers unique CommonJS `require` path typos without an extension, missing extensions, extension mismatches, and directory `index` imports.
- `missing-property`: adds a missing object property required by an assertion.
- `wrong-literal`: replaces an incorrect returned string literal.
- `truthy-return`: changes a simple falsy return to satisfy `assert.ok`.
- `missing-export`: exports a uniquely declared function imported by the test.
- `typescript-diagnostic`: targets a tsc-style TypeScript diagnostic and repairs a simple primitive literal mismatch; the same conservative diagnostic path also handles simple TS2322/TS2345 concrete primitive literal replacements, missing required properties, and TS2551 property-name typos when TypeScript provides one clear suggestion.

Example shape:

```json
{
  "ok": true,
  "thresholds": {
    "ok": true,
    "mode": "ci",
    "maxFixTokens": 260,
    "checks": [
      {
        "name": "all-cases-ok",
        "ok": true,
        "expected": true,
        "actual": true
      }
    ]
  },
  "cases": {
    "wrong-literal": {
      "ok": true,
      "rows": {
        "raw": {
          "ok": false,
          "commands": 1,
          "chars": 865,
          "tokens": 217,
          "durationMs": 401,
          "rollbackAvailable": false,
          "rollbackCommand": null
        },
        "split": {
          "ok": true,
          "commands": 3,
          "chars": 2815,
          "tokens": 704,
          "durationMs": 813,
          "rollbackAvailable": true,
          "rollbackCommand": "agentshell undo op_example"
        },
        "fix": {
          "ok": true,
          "commands": 1,
          "chars": 804,
          "tokens": 201,
          "durationMs": 516,
          "rollbackAvailable": true,
          "rollbackCommand": "agentshell undo op_example"
        }
      }
    }
  }
}
```

Markdown output summarizes the same rows in a table with case, path, command
labels, token estimate, duration, rollback availability, and threshold check
summary when threshold mode is enabled.
