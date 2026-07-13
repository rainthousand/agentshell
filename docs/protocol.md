# AgentShell Protocol

AgentShell commands return JSON.

Protocol stability details live in [protocol-versioning.md](protocol-versioning.md).

Use schemas to inspect stable contracts:

```bash
agentshell schema list
agentshell schema get start
agentshell schema get understand
agentshell schema get doctor
agentshell schema get plugin-status
agentshell schema get plugin-validate
agentshell schema get plugin-release-local
agentshell schema get plugin-smoke
agentshell schema get manual
agentshell schema get verify
agentshell schema get diagnose
agentshell schema get read
agentshell schema get change
agentshell schema get change-fill
agentshell schema get change-suggest
agentshell schema get fix
agentshell schema get run
agentshell schema get run-next
agentshell schema get run-clear
agentshell schema get benchmark
agentshell schema get benchmark-suite
agentshell schema get strategy-intake
agentshell schema get product-readiness
agentshell schema get codex-plugin-trial
agentshell schema get codex-plugin-trial-template
agentshell schema get codex-plugin-trial-plan
agentshell schema get codex-plugin-trial-suite
agentshell schema get cold-start-benchmark
agentshell schema get real-project-eval
agentshell schema get real-project-candidates
agentshell schema get metrics
```

Common response rules:

- Most success responses include `"ok": true`.
- Failure responses include `"ok": false` and an `error` object.
- Versioned success responses include a command-scoped `protocolVersion` string when that command has entered the rollout.
- `agentshell schema get <name>` is the success-envelope exception: it returns the JSON Schema document directly and adds a top-level command response `protocolVersion`.
- Long logs are referenced by `logRef` and fetched with `agentshell log get <logRef> --tail N`.
- File edits use `expectedHash` from `agentshell read`.
- `agentshell start --compact` and its alias `agentshell entry --compact` combine doctor, compact understand, and run-next summaries into one slim `agentshell.start.v1` response for first-pass agent entry. Compact summary omits `workspace.root`; plain `agentshell start` keeps the full embedded payloads for debugging.
- `agentshell plugin status --compact` returns `status`, install summary, plugin version, cache path, `nextAction`, and suggested next actions without full check or path details.
- `agentshell plugin validate --compact` returns `agentshell.plugin-validate.v1` with source/plugin-cache validation mode, plugin metadata, aggregate check summary, optional plugin-status summary, `nextAction`, and suggested next actions. Add `--source-only` for pre-install release checks that must not require the new version to already exist in the Codex plugin cache.
- `npm run plugin:release-local -- --compact` returns `agentshell.plugin-release-local.v1` with release `status`, `durationMs`, plugin metadata, summary counts, `failedStep`, and compact per-step status.
- `npm run plugin:smoke` returns `agentshell.plugin-smoke.v1` with installed path, summary counts, and closed per-check results.
- `npm run benchmark:cold-start` returns `agentshell.cold-start-benchmark.v1` with external wall-time measurements and optional internal command profile summaries for supported profiled commands.
- `npm run product:readiness` returns `agentshell.product-readiness.v1` with blocking and warning checks for external local trial readiness.
- `npm run codex:plugin:trial` returns `agentshell.codex-plugin-trial.v1` with raw-baseline versus AgentShell-plugin scoring, token and duration metrics, purpose, and recommendation fields.
- `npm run codex:plugin:collect -- --input run-log.json` also returns `agentshell.codex-plugin-trial.v1`, but starts from a real Codex new-thread command transcript instead of the synthetic comparison manifest.
- `npm run codex:plugin:template` returns `agentshell.codex-plugin-trial-template.v1` with a fillable JSON run-log template and Markdown capture form for real Codex new-thread evidence collection.
- `npm run codex:plugin:plan` returns `agentshell.codex-plugin-trial-plan.v1` with several run-log templates, a suite manifest draft, a Markdown execution plan, and next actions for real Codex new-thread evidence collection.
- `npm run codex:plugin:suite -- --manifest suite.json` returns `agentshell.codex-plugin-trial-suite.v1` with strong/usable/weak counts, strong rate, average score, average token cost, average duration, per-fixture summaries, and individual scored real Codex run records.
- `npm run strategy:intake -- --input samples.json` returns `agentshell.strategy-intake.v1` with sample readiness, priority, blocker, and evidence summaries for strategy expansion.
- Diagnosis, template-filled changes, and verification attach to a `runId`; inspect the shortest next action with `agentshell run next`, clear stale active state with `agentshell run clear`, or inspect task state with `agentshell run status --compact`.

## Versioning

- v0.22 starts explicit response protocol versioning on the main one-command repair path.
- `agentshell fix test` success responses include `"protocolVersion": "agentshell.fix.v1"`.
- `agentshell verify test` verification-result responses include `"protocolVersion": "agentshell.verify.v1"`.
- `agentshell diagnose test` success responses include `"protocolVersion": "agentshell.diagnose.v1"` and embed compact verification data with `"protocolVersion": "agentshell.verify.v1"`.
- `agentshell start`, `agentshell entry`, and their `--compact` forms all use `agentshell.start.v1`; compact responses set `"compact": true` and omit the embedded `doctor`, `understand`, and `next` payloads.
- `agentshell understand`, `agentshell doctor`, `agentshell plugin status`, `agentshell plugin validate`, `agentshell find`, `agentshell read`, `agentshell run status`, `agentshell run next`, `agentshell run clear`, `agentshell benchmark test`, and `agentshell metrics` success responses include command-scoped protocol versions. Metrics uses `agentshell.metrics.v2` to separate measured, estimated, and unavailable values and expose the local Dashboard summary; the other command contracts retain their existing v1 versions.
- `scripts/plugin-release-local.js` reports include `"protocolVersion": "agentshell.plugin-release-local.v1"` for both full and compact JSON output.
- `scripts/plugin-smoke.js` JSON reports include `"protocolVersion": "agentshell.plugin-smoke.v1"`.
- `scripts/cold-start-benchmark.js` JSON reports include `"protocolVersion": "agentshell.cold-start-benchmark.v1"`.
- `scripts/product-readiness.js` JSON reports include `"protocolVersion": "agentshell.product-readiness.v1"`.
- `scripts/codex-plugin-trial.js` JSON reports include `"protocolVersion": "agentshell.codex-plugin-trial.v1"`.
- `scripts/codex-plugin-trial-collect.js` JSON reports include `"protocolVersion": "agentshell.codex-plugin-trial.v1"` for real Codex new-thread transcript collection.
- `scripts/codex-plugin-trial-template.js` JSON reports include `"protocolVersion": "agentshell.codex-plugin-trial-template.v1"`.
- `scripts/codex-plugin-trial-plan.js` JSON reports include `"protocolVersion": "agentshell.codex-plugin-trial-plan.v1"`.
- `scripts/codex-plugin-trial-suite.js` JSON reports include `"protocolVersion": "agentshell.codex-plugin-trial-suite.v1"`.
- `scripts/strategy-intake.js` JSON reports include `"protocolVersion": "agentshell.strategy-intake.v1"`.
- `agentshell manual`, `agentshell history`, `agentshell log get`, `agentshell schema list`, and `agentshell schema get` success responses include command-scoped protocol versions: `agentshell.manual.v1`, `agentshell.history.v1`, `agentshell.log.v1`, `agentshell.schema-list.v1`, and `agentshell.schema-get.v1`.
- `agentshell manual` defaults to a compact router with `compact: true`, `firstPass`, `primaryCommands`, `topics`, and `full`. Use `agentshell manual --full` for the complete `commandMap`, or `agentshell manual --topic <repair|plugin|benchmark|profile|onboarding|log-triage|reference>` for focused workflow payloads.
- `fix.policy` is stable when present and is limited to `"fast"` or `"safe"`.
- `run`, `benchmark`, and `metrics` schemas intentionally close known response objects with `additionalProperties: false`; the metrics command-name map remains map-shaped because command labels are runtime data, but map keys are constrained to non-empty strings and values use closed stat objects.
- `benchmark-suite` covers the JSON report written by `scripts/benchmark-suite.js --report <path>` and printed by the script in default JSON mode. Its `cases` object remains map-shaped because benchmark case ids are runtime fixture ids; keys are constrained to lowercase kebab-case identifiers and values use closed case-report objects. Markdown reports are a presentation artifact for the same rows, not a separate JSON protocol.
- `real-project-eval` covers the JSON report printed by `scripts/real-project-eval.js`. Known report objects are closed; arm summary and artifact maps are limited to the `raw`, `split`, and `fix` arm names. Reports include project-level `classification`, failure-class summaries, unsupported-reason summaries, and deterministic first-pass `safety`/`generalization` buckets for evaluation review.
- `agentshell understand --compact` keeps `agentshell.understand.v1` and returns only first-pass decision fields: workspace name, stack, scripts, compact git state, and `nextAction`. Plain `agentshell understand` keeps the existing full summary shape.
- Future protocol-version additions should be additive first: add the field to a command schema, keep existing fields stable, then document any deprecated fields before removal.
- Error responses keep the shared `ok: false` and `error` shape while protocol versioning is rolled out command by command.

## Compatibility And Deprecation

The compatibility policy is command-scoped. Additive response fields, new schema
names, new error codes, and new `unsupportedReason` values are compatible within
an existing `protocolVersion` when clients can ignore unknown values. Removing a
field, renaming a field, changing a field's type or meaning, changing `ok`
semantics, or replacing the shared hard-failure shape requires a new
command-scoped version such as `agentshell.fix.v2`.

Deprecated fields should be emitted together with their replacements for at
least one minor release, marked in JSON Schema with `"deprecated": true`, and
removed only in a new command protocol version. Adapter packages and the future
MCP layer must treat `agentshell schema list` and `agentshell schema get <name>`
as the source of truth, branch on `protocolVersion`, `error.code`, and
`unsupportedReason`, and ignore unknown fields by default.

See [protocol-versioning.md](protocol-versioning.md) for the full compatibility,
deprecation, protocol bump, adapter, and MCP policy.

## Errors

Failure responses use this shared shape:

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "Human-readable summary",
    "details": {},
    "suggestedNextActions": []
  }
}
```

Current shared error codes and unsupported-result guidance are maintained in [protocol-versioning.md](protocol-versioning.md).
