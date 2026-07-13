# Real Project Evaluation

This document sketches the first offline skeleton for evaluating AgentShell on
real projects. The runner does not download repositories and does not install
new dependencies. It reads a manifest, checks whether each local repo path
exists, runs only local commands, and separates missing projects from explicit
skips and runnable fixtures. Runnable repositories are copied to a temporary
directory for each arm, so AgentShell repair commands can edit files without
polluting the real checkout.

The checked-in manifest pins eighteen small local runnable fixtures plus neutral placeholder
entries:

- `checked-in-runnable-fixture`: a local failing-test fixture whose raw arm
  records the expected failure while the `split` and `fix` repair arms should
  make the copied project pass.
- `healthy-node-baseline`: a local healthy Node fixture with
  `skipRepairArms: true`, used as a raw-only baseline for runnable-project
  counting and command accounting.
- `import-path-typo-real-project`: a local failing-test fixture whose raw arm
  records a relative import typo while the `split` and `fix` repair arms should
  resolve the unique nearby `import-path` suggestion.
- `typescript-diagnostic-real-project`: a local TypeScript diagnostic fixture
  whose raw arm records a tsc-style missing required property error while the
  `split` and `fix` repair arms should apply the conservative
  `typescript-missing-property` suggestion.
- `typescript-property-suggestion-real-project`: a local TypeScript diagnostic
  fixture whose raw arm records a TS2551 property typo with one compiler
  suggestion while the `split` and `fix` repair arms should apply the
  conservative `typescript-property-suggestion` replacement.
- `typescript-primitive-literal-real-project`: a local TypeScript diagnostic
  fixture whose raw arm records a TS2345 primitive literal mismatch while the
  `split` and `fix` repair arms should replace the unique literal via
  `typescript-primitive-literal-mismatch`.
- `literal-replacement-real-project`: a local failing-test fixture whose raw arm
  records an incorrect returned string literal while the `split` and `fix`
  repair arms should apply the conservative `literal-replacement` suggestion.
- `deep-equal-array-elements-real-project`: a local failing-test fixture whose
  raw arm records missing expected array elements from `assert.deepEqual` while
  the `split` and `fix` repair arms should apply the conservative
  `deep-equal-array-elements` suggestion.
- `deep-equal-array-removal-real-project`: a local failing-test fixture whose
  raw arm records extra actual tail array elements from `assert.deepEqual` while
  the `split` and `fix` repair arms should apply the conservative
  `deep-equal-array-removal` suggestion.
- `deep-equal-missing-property-real-project`: a local failing-test fixture whose
  raw arm records a missing actual property from `assert.deepEqual` while the
  `split` and `fix` repair arms should apply the conservative
  `deep-equal-missing-property` suggestion.
- `deep-equal-extra-property-removal-real-project`: a local failing-test fixture
  whose raw arm records an extra actual property from `assert.deepEqual` while
  the `split` and `fix` repair arms should apply the conservative
  `deep-equal-extra-property-removal` suggestion.
- `deep-equal-array-primitive-replacement-real-project`: a local failing-test
  fixture whose raw arm records one primitive array-element mismatch from
  `assert.deepEqual` while the `split` and `fix` repair arms should apply the
  conservative `deep-equal-array-primitive-replacement` suggestion.
- `array-length-real-project`: a local failing-test fixture whose raw arm
  records a returned array length shortfall while the `split` and `fix` repair
  arms should apply the conservative `array-length` suggestion.
- `join-separator-literal-real-project`: a local failing-test fixture whose raw
  arm records an empty `join('')` separator mismatch while the `split` and `fix`
  repair arms should apply the conservative `join-separator-literal`
  suggestion.
- `string-case-transform-real-project`: a local failing-test fixture whose raw
  arm records a string case mismatch while the `split` and `fix` repair arms
  should apply the conservative `string-case-transform` suggestion.
- `truthy-return-real-project`: a local failing-test fixture whose raw arm
  records a falsy return used by `assert.ok` while the `split` and `fix`
  repair arms should apply the conservative `truthy-return` suggestion.
- `missing-named-export-real-project`: a local failing-test fixture whose raw
  arm records an imported function that is declared but not exported while the
  `split` and `fix` repair arms should apply the conservative
  `missing-named-export` suggestion.
- `typescript-literal-mismatch-real-project`: a local TypeScript diagnostic
  fixture whose raw arm records a concrete literal assignment mismatch while the
  `split` and `fix` repair arms should apply the conservative
  `typescript-literal-mismatch` suggestion.
- `sample-missing-local-project` and `sample-skipped-external-project`: neutral
  missing/skipped entries that keep the report shape honest without requiring
  network access or external checkouts.

Run the skeleton with:

```sh
npm run eval:real-projects
```

The default lookup order is:

1. `examples/real-projects.json`
2. `docs/real-project-eval.example.json`
3. a built-in sample manifest whose path is intentionally absent, used only if
   no checked-in or docs example manifest exists.

An explicit manifest can be passed with:

```sh
node scripts/real-project-eval.js --manifest path/to/manifest.json
```

## Candidate Importer

Before pinning a real project into `examples/real-projects.json`, use the
candidate importer to create an offline suitability report and manifest draft:

```sh
npm run eval:real-project-candidates -- --repo path/to/local/repo
```

Remote candidates are accepted as URLs or `owner/repo` slugs, but they are never
downloaded by this tool:

```sh
node scripts/real-project-candidates.js \
  --repo sindresorhus/is \
  --repo https://github.com/chalk/chalk \
  --report artifacts/real-project-candidates.json \
  --manifest-draft artifacts/real-projects.draft.json \
  --markdown artifacts/real-project-candidates.md
```

Candidate files can be used for a small review queue:

```json
{
  "candidates": [
    {
      "id": "chalk",
      "name": "Chalk",
      "url": "https://github.com/chalk/chalk",
      "expectedFailureClass": "import-path",
      "allowedStrategies": ["raw", "split", "fix"],
      "notes": "Register first; checkout only after it looks suitable."
    }
  ]
}
```

The checked-in sample queue is `examples/real-project-candidates.sample.json`:

```sh
node scripts/real-project-candidates.js \
  --candidates examples/real-project-candidates.sample.json \
  --report artifacts/real-project-candidates.sample.json \
  --manifest-draft artifacts/real-projects.sample.draft.json \
  --markdown artifacts/real-project-candidates.sample.md
```

The JSON report answers whether a candidate is locally available, which package
manager and test command are likely, whether a checkout is still required, and
what the initial manifest entry would look like. `--markdown <path>` writes the
same candidate queue as a human-readable summary with a candidate table,
blockers/warnings, and manifest draft reminders while leaving stdout as JSON.
The importer intentionally does not run install commands, clone repositories, or
execute tests; `real-project-eval.js` remains the runner for already-local
manifest entries.

Candidate metadata includes `packageManagerSpec` from `packageManager`,
`nodeEngine` from `engines.node`, `dependencySummary` counts for
`dependencies`, `devDependencies`, and `peerDependencies`, and
`workspaceSummary` for monorepo indicators such as `workspaces`,
`pnpm-workspace.yaml`, `lerna.json`, `turbo.json`, and `nx.json`.

Use the candidate report as a lightweight triage board before downloading or
pinning anything:

- Remote URL and `owner/repo` entries are valid registration records. They are
  scored with `checkout-required`, `not-downloaded-by-design`, `priority:
  blocked`, and a skipped manifest draft entry, so they are safe to keep in a
  review queue before any clone happens.
- Local entries graduate only after `exists: true`, `blockers: []`, and a
  non-null `testCommand`. High-priority entries are small, locally present,
  package-backed, and have obvious tests. Medium-priority entries are usable but
  need warning review, commonly for workspaces or larger dependency surfaces.
- Treat `candidateScore` as a sorting hint, not as an automatic import decision.
  Review `warnings`, `expectedFailureClass`, `allowedStrategies`, and
  `nextAction` before copying a manifest draft entry into
  `examples/real-projects.json`.
- Keep skipped remote draft entries out of `examples/real-projects.json` unless
  the repository has been imported locally and its `repoPath`, setup, test
  command, and failure class have been rechecked.

The candidate report is versioned as
`agentshell.real-project-candidates.v1` and is exposed through:

```sh
agentshell schema get real-project-candidates
```

Repeat every runnable arm to reduce one-off timing noise with:

```sh
node scripts/real-project-eval.js --runs 3
```

`--runs` defaults to `1` and accepts integers from `1` to `20`. When greater
than `1`, each arm reports aggregate fields such as `runs`, `successRuns`,
`failureRuns`, `successRate`, `averageTokens`, `averageDurationMs`, and
`runResults`.

Run the cheapest repair path first with:

```sh
node scripts/real-project-eval.js --mode fix-first
```

`--mode` defaults to `full`. In `fix-first` mode, the runner executes the `fix`
arm first; if it succeeds, raw and split are skipped for that project. If it
fails, the remaining enabled arms are backfilled so the report still contains
diagnostic evidence. This mode is intended for speed and token-cost experiments,
not for exhaustive strategy comparison.

When `fix-first` skips enabled arms, each project reports `skippedArms` entries
such as `{ "name": "raw", "reason": "fix-succeeded" }`, and the top-level
summary includes `skippedArms` counts by arm.

Run multiple projects at once with:

```sh
node scripts/real-project-eval.js --concurrency 3
```

`--concurrency` defaults to `1` and accepts integers from `1` to `16`. Project
order in the final report stays the same as the manifest order.

Run independent arms inside each project concurrently with:

```sh
node scripts/real-project-eval.js --arm-concurrency 3
```

`--arm-concurrency` defaults to `1` and accepts integers from `1` to `3`. Raw,
split, and fix arms always use isolated temporary copies, so this can reduce
wall-clock time for one or two large projects while preserving stable report
ordering. The rough process fan-out is `--concurrency * --arm-concurrency`, so
keep both values modest on laptops.

Projects that link a shared `node_modules` through `setupLinks` are
automatically downgraded to `effectiveArmConcurrency: 1`, because some tools
write cache files under `node_modules/.cache` and are not safe to share across
concurrent arms.

Write the same JSON report that is printed to stdout with:

```sh
node scripts/real-project-eval.js --report artifacts/real-project-eval.json
```

Optional compact artifacts can be enabled separately:

```sh
node scripts/real-project-eval.js \
  --report artifacts/real-project-eval.json \
  --artifacts-dir artifacts/real-project-eval \
  --runs 3
```

`--artifacts-dir` writes a `summary.json` index plus per-project/per-arm JSON
files under `projects/<project-id>/<arm>.json`. Those arm artifacts include the
same command metrics as the main report, per-run command details, and compact
stdout/stderr previews. Long streams are stored as `head` and `tail` snippets
with the original character count, so the default runner never writes huge raw
logs unless a future explicit raw-log option is added.

## Manifest Format

The manifest is JSON. Paths may be absolute or relative to the AgentShell repo
root.

```json
{
  "version": 1,
  "projects": [
    {
      "id": "local-example",
      "name": "Local Example",
      "repoPath": "examples/real-projects/healthy-node-baseline",
      "skip": false,
      "skipReason": null,
      "setupCommand": "npm install --offline",
      "setupLinks": [],
      "testCommand": "npm test",
      "skipRepairArms": false,
      "expectedFailureClass": "none",
      "allowedStrategies": ["raw"],
      "arms": {
        "raw": { "enabled": true },
        "split": { "enabled": true },
        "fix": { "enabled": true }
      },
      "metrics": ["tokens", "durationMs", "success", "safety", "generalization"]
    }
  ]
}
```

Fields:

- `id`: stable machine-readable project id.
- `name`: display name for reports.
- `repoPath`: local repository path. Missing paths are reported as `missing`.
- `skip`: optional boolean for a manifest entry that should not run yet.
- `skipReason`: optional reason reported when `skip` is true.
- `setupCommand`: optional local setup command. The first skeleton stores and can
  run it, but manifests should avoid network-dependent setup.
- `setupLinks`: optional array of deterministic symlinks created only inside
  each isolated arm copy before `setupCommand`. Each entry supports
  `{ "source", "target" }`; relative `source` paths resolve from `repoPath`, and
  `target` must stay inside the copied repo. Prefer this over `cp -R` for large
  prepared directories such as `node_modules` when measuring local benchmark
  speed.
- Candidate drafts generated from a local repo with prepared `node_modules`
  set `setupLinks` to link that directory and set manifest `setupCommand` to
  `null`, so eval runs measure tests instead of repeated dependency setup.
- `testCommand`: command that evaluates the target failure or regression. The
  raw arm runs this command and records success or failure without failing the
  whole eval.
- `mutations`: optional array of deterministic source edits applied only inside
  each isolated arm copy before setup. Each entry supports `{ "path",
  "replace", "with", "replaceAll" }`; `path` must stay inside the copied repo.
  Use this to turn a healthy pinned real project into a reproducible injected
  failure without modifying the source checkout.
- `skipRepairArms`: optional boolean. When true, only the raw arm runs. Use this
  for lightweight fixtures or repos that do not have a supported failing-test
  repair target.
- `expectedFailureClass`: failure class expected before AgentShell intervention.
- `allowedStrategies`: evaluation paths allowed for the project, such as `raw`,
  `split`, and `fix`.
- `arms`: optional per-project arm override. It may be an array such as
  `["raw", "fix"]` or an object with `raw`, `split`, and `fix` entries. Set an
  arm to `false` or `{ "enabled": false }` to skip it. The raw arm also accepts
  a custom `command`.
- `metrics`: metric names to collect or compare.

Arm behavior:

- `raw`: runs `testCommand` in an isolated copy. A non-zero exit is recorded as
  `success: false` but is allowed because many real-project evals start from a
  known failing test.
- `split`: runs `agentshell diagnose test --compact`, then
  `agentshell change suggest --apply --compact`, then `agentshell verify test`
  in an isolated copy.
- `fix`: runs `agentshell fix test --fast --compact` in an isolated copy.

Project status is intentionally stricter than raw-arm status. If no repair arm
is enabled, `raw` must pass. If one or more repair arms are enabled, every
enabled repair arm must pass; a failing `raw` arm is then treated as the
expected starting condition rather than as a project failure.

## Output Shape

The runner prints JSON:

```json
{
  "ok": true,
  "runs": 1,
  "projects": [
    {
      "id": "checked-in-runnable-fixture",
      "status": "pass",
      "availability": "runnable",
      "ok": true,
      "arms": {
        "raw": {
          "success": false,
          "tokens": 262,
          "durationMs": 226
        },
        "split": {
          "success": true,
          "tokens": 996,
          "durationMs": 543
        },
        "fix": {
          "success": true,
          "tokens": 238,
          "durationMs": 406
        }
      },
      "evaluation": {
        "tokens": 1496,
        "durationMs": 1175,
        "success": true,
        "safety": "checked",
        "generalization": "covered"
      },
      "classification": {
        "expectedFailureClass": "missing-object-property",
        "status": "pass",
        "reason": null,
        "rawFailureObserved": true,
        "repairAttempted": true,
        "repairSucceeded": true,
        "unsupportedReasons": [],
        "suggestedNextActions": []
      }
    }
  ],
  "summary": {
    "total": 11,
    "pass": 9,
    "fail": 0,
    "skipped": 1,
    "missing": 1,
    "runnable": 9,
    "arms": {
      "raw": { "total": 2, "success": 1, "tokens": 262, "durationMs": 226 },
      "split": { "total": 1, "success": 1, "tokens": 996, "durationMs": 543 },
      "fix": { "total": 1, "success": 1, "tokens": 238, "durationMs": 406 }
    },
    "unsupported": {
      "totalProjects": 0,
      "totalArms": 0,
      "reasons": {},
      "projects": []
    },
    "evaluation": {
      "safety": { "checked": 1 },
      "generalization": { "covered": 1 }
    }
  }
}
```

When `--artifacts-dir` is used, the stdout/report JSON also includes an
`artifacts` index with relative artifact file paths. Command output previews stay
out of the main report so stdout remains compact and machine-readable.

`ok` is false only when at least one existing local project fails orchestration,
such as a setup command failing in an arm. Missing and skipped projects count as
neutral so the skeleton remains runnable offline. Raw test failures are arm
measurements, not orchestration failures. Status values are:

- `missing`: `repoPath` is configured but absent locally.
- `skipped`: the manifest explicitly sets `skip: true`, omits `repoPath`, or
  omits `testCommand`.
- `pass`: enabled arms ran to completion.
- `fail`: an enabled arm could not be orchestrated, such as a setup failure.

The `evaluation` object always includes scientific evaluation fields. Runnable
projects fill `tokens`, `durationMs`, and aggregate `success` from arm command
execution. For repair projects, aggregate `success` follows the repair arms, so
raw failure reproduction does not make a repaired project fail.

`safety` is a deterministic first-pass bucket: `checked` when enabled repair
arms succeed through AgentShell's controlled edit/verify loop, `failed` when a
repair arm fails, `pending` when repair success is ambiguous, `not-applicable`
for raw-only passing baselines, and `unknown` when no reliable judgment is
available. `generalization` is `covered` when a supported repair class succeeds,
`unsupported` when AgentShell returns an `unsupportedReason`, `not-applicable`
for healthy baselines, and `unknown` otherwise. Missing and skipped projects use
`null` values for all evaluation fields.

The `classification` object records the expected failure class, raw failure
reproduction, whether repair was attempted and succeeded, extracted
`unsupportedReason` values, and suggested next actions. The top-level
`summary.failureClasses`, `summary.unsupported`, and `summary.evaluation`
objects aggregate these fields for quick product and benchmark review.

## Scientific Evaluation Method

Real repository selection should be fixed before running comparisons. Use a
small but diverse panel of projects with permissive local use, stable tests, and
known failure classes. Include JavaScript packages first because AgentShell
currently targets Node workflows, then add TypeScript and multi-package repos
once command contracts are stable.

Each project should define the same comparison arms:

- `raw`: raw agent loop using direct shell/test output.
- `split`: explicit `diagnose`, `change`, and `verify` AgentShell flow.
- `fix`: one-command `agentshell fix test --fast --compact` flow.

The main metrics are:

- `tokens`: estimated output tokens consumed by the agent-visible loop.
- `speed`: wall-clock duration per command and per completed repair.
- `success`: whether the intended test passes without unrelated breakage.
- `safety`: whether edits are scoped, reversible, and avoid unsupported changes.
- `generalization`: whether a strategy learned from examples works on unseen
  real project layouts.

For credible results, record environment details, pin repo revisions outside the
manifest, run each arm multiple times when nondeterminism is possible, and keep
the raw logs available separately from the compact JSON summaries.
