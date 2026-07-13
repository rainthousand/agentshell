# AgentShell Protocol Versioning

This document stabilizes the AgentShell JSON response protocol without requiring an all-at-once implementation change.

## Goals

- Keep existing command output backwards compatible by default.
- Make command-specific success contracts explicit with `protocolVersion`.
- Keep all failure responses on the shared `ok: false` and `error` shape.
- Distinguish hard command failures from supported commands that cannot safely produce an automatic result.
- Give adapters and future MCP servers one compatibility policy to follow.

## Rollout Plan

### Phase 0: Shared Vocabulary

`schemas/common.schema.json` owns shared definitions for:

- `protocolVersion`: command-scoped strings such as `agentshell.fix.v1`.
- `errorCode`: the current canonical error-code enum.
- `unsupportedReason`: machine-readable reasons for safe no-op or no-suggestion outcomes.
- `unsupportedResult`: an optional reusable shape for future command outputs that complete successfully but cannot provide the requested automated result.

### Phase 1: Fix Path

`agentshell fix test` is the first versioned success response and uses:

```json
{
  "ok": true,
  "protocolVersion": "agentshell.fix.v1"
}
```

The version names the command family and response generation, not the package version. Patch releases can keep `agentshell.fix.v1` as long as changes are additive and existing fields keep their meaning.

### Phase 2: Additive Command Adoption

`agentshell verify test` and `agentshell diagnose test` now use:

```json
{
  "protocolVersion": "agentshell.verify.v1"
}
```

and:

```json
{
  "ok": true,
  "protocolVersion": "agentshell.diagnose.v1"
}
```

`verify` reports test outcomes, so `ok: false` can still be a versioned verification-result response when the test command ran and failed. Hard command failures continue to use the shared unversioned `error` shape.

`diagnose.verification` embeds compact verify data and preserves `agentshell.verify.v1` so clients can recognize the nested contract independently of the diagnosis contract.

Primary non-mutating runtime commands also emit command-scoped versions on success:

| Command | Success `protocolVersion` |
| --- | --- |
| `agentshell start` / `agentshell entry` / `agentshell start --compact` / `agentshell entry --compact` | `agentshell.start.v1` |
| `agentshell understand` | `agentshell.understand.v1` |
| `agentshell plugin status` | `agentshell.plugin-status.v1` |
| `agentshell plugin validate` | `agentshell.plugin-validate.v1` |
| `agentshell find` | `agentshell.find.v1` |
| `agentshell read` | `agentshell.read.v1` |
| `agentshell run status` | `agentshell.run-status.v1` |
| `agentshell run next` | `agentshell.run-next.v1` |
| `agentshell run clear` | `agentshell.run-clear.v1` |
| `agentshell benchmark test` | `agentshell.benchmark.v1` |
| `agentshell metrics` | `agentshell.metrics.v2` |
| `agentshell manual` | `agentshell.manual.v1` |
| `agentshell history` | `agentshell.history.v1` |
| `agentshell log get` | `agentshell.log.v1` |
| `agentshell schema list` | `agentshell.schema-list.v1` |
| `agentshell schema get` | `agentshell.schema-get.v1` |

Their hard failures continue to use the shared unversioned `ok: false` error shape.

`agentshell manual` uses `agentshell.manual.v1` for both the compact default
router and `--full`; integrations that require the complete command map should
call `agentshell manual --full`.

The local plugin release script also emits a stable report protocol:

| Script | Report `protocolVersion` |
| --- | --- |
| `scripts/plugin-release-local.js` | `agentshell.plugin-release-local.v1` |
| `scripts/plugin-smoke.js` | `agentshell.plugin-smoke.v1` |
| `scripts/cold-start-benchmark.js` | `agentshell.cold-start-benchmark.v1` |

`agentshell schema get <name>` still returns the JSON Schema document directly
for compatibility with existing callers. Its command response version is added
as a top-level JSON Schema extension keyword, while the schema's own documented
response versions remain in their existing nested locations.

When another command needs a stable integration contract:

1. Add `protocolVersion` to that command's success schema.
2. Document the exact version string in `docs/protocol.md`.
3. Keep pre-existing fields stable.
4. Add new fields as optional or clearly documented required fields in a new version.

`metrics.byCommand` remains a dynamic object because command names are runtime
data, not schema-authored field names. Its keys are constrained to non-empty
strings and its values are closed command-stat objects. `benchmark-suite.cases`
is also a dynamic report map because benchmark case ids come from fixture names;
its keys are constrained to lowercase kebab-case identifiers.

Script-level JSON reports can still have stable schema names before they receive
command-scoped `protocolVersion` fields. Current report schemas include
`benchmark-suite` for `scripts/benchmark-suite.js` JSON output and
`real-project-eval` for `scripts/real-project-eval.js` output.
`scripts/plugin-release-local.js` has a versioned script-report contract,
`agentshell.plugin-release-local.v1`, because agents use it as a local plugin
release control plane.
`scripts/plugin-smoke.js` has a versioned script-report contract,
`agentshell.plugin-smoke.v1`, because release and installed-plugin verification
needs a stable machine-readable gate before Codex cache updates are trusted.
`scripts/cold-start-benchmark.js` has a versioned script-report contract,
`agentshell.cold-start-benchmark.v1`, because performance decisions should be
based on comparable wall-time and profile evidence rather than assumptions about
the implementation language.

Schema-only tightening should preserve runtime output. When a response object is
already emitted with a known fixed shape, prefer `additionalProperties: false`;
keep `additionalProperties` schemas for intentional maps such as metrics grouped
by command name or benchmark cases grouped by fixture id. When the key space is
known, such as real-project-eval arm names, close the object to those keys.

### Phase 3: Deprecation Before Removal

Field removal or semantic changes require a new command-scoped version, for example `agentshell.fix.v2`.

Before removal:

- Keep the old field for at least one minor release.
- Document the replacement and removal target.
- Prefer emitting both old and new fields during migration.

## Compatibility Policy

AgentShell treats JSON command output as an integration protocol for agents,
adapters, benchmark scripts, and future host bridges. Compatibility is judged
per command contract, not only per npm package version.

Compatible changes within an existing `protocolVersion`:

- Add an optional field to a response object.
- Add a new enum value only when clients are already instructed to treat unknown
  values as "unsupported" or "unknown" instead of crashing.
- Add a new error code to the shared error-code table.
- Add a new `unsupportedReason` value when the existing fallback behavior is
  still valid.
- Tighten a schema to match output that the CLI already emits.
- Add a new schema name to `agentshell schema list`.

Breaking changes that require a new command-scoped `protocolVersion`:

- Remove a field, make an optional field required, or rename a field.
- Change the type, unit, path semantics, or meaning of an existing field.
- Change `ok` semantics for a command response.
- Change a stable enum so an existing value has a different meaning.
- Move data to a different nesting location without also emitting the old field
  during the deprecation window.
- Replace the shared `ok: false` error shape for hard command failures.

Clients should ignore unknown fields by default, branch on stable fields such as
`protocolVersion`, `ok`, `error.code`, `status`, and `unsupportedReason`, and
avoid relying on text in human-readable `message` fields.

## Field Lifecycle

New fields should start as optional unless a new `protocolVersion` is being
introduced. If a field is expected to become required later, document that plan
next to the field before clients are expected to depend on it.

Deprecated fields remain valid during the deprecation window. The preferred
runtime behavior is:

1. Emit the deprecated field and the replacement field together.
2. Keep both fields consistent.
3. Document the replacement, first deprecated release, and earliest removal
   release.
4. Remove the deprecated field only in a new command-scoped protocol version.

JSON Schemas should mark deprecated fields with the standard JSON Schema
annotation:

```json
{
  "oldField": {
    "type": "string",
    "deprecated": true,
    "description": "Deprecated since v0.24; use newField. Earliest removal: agentshell.example.v2."
  }
}
```

When a whole schema is retained only for migration, mark the schema description
as deprecated and keep `agentshell schema get <name>` available until the named
removal release.

## Protocol Version Bumps

Use command-scoped versions such as `agentshell.fix.v1`, not package versions.
A package release can contain several command protocol versions at once.

When a breaking response change is necessary:

1. Add a new version string, for example `agentshell.fix.v2`.
2. Add or update the command schema so clients can validate the new response.
3. Document the migration in `docs/protocol.md` and this file.
4. Keep old fields in the old version during the deprecation window when the
   command can still produce them.
5. Update adapter instructions and release notes before changing generated
   adapter templates.

The CLI should not silently change the meaning of an existing
`protocolVersion`. If a command has not entered the rollout and has no
`protocolVersion`, treat schema changes as best-effort stability until the
command receives a command-scoped version.

## Adapter And MCP Compatibility

Adapters must consume the CLI and schemas as the source of truth. Generated
Claude Code, Cursor/Windsurf, and generic `AGENTS.md` instructions should:

- Prefer `agentshell schema get <name>` over copied response examples when
  validating command output.
- Check `protocolVersion` for versioned responses before assuming field
  presence.
- Ignore unknown fields and preserve unknown enum values in summaries instead of
  treating them as hard failures.
- Use `error.code` and `unsupportedReason` for branching; use `message` only for
  display.
- Keep adapter package updates additive unless a new command protocol version is
  documented.

MCP remains deferred, but any future MCP server should be a compatibility layer
over the same CLI protocol rather than a separate contract. MCP tools should
preserve command-scoped `protocolVersion` fields in their results, expose schema
names that match `agentshell schema list`, and map transport-level failures
separately from AgentShell command failures. If MCP needs a different envelope,
the AgentShell command payload should remain nested without changing its field
semantics.

## Error Response Contract

Failures remain unversioned while the rollout proceeds. They always use:

```json
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable summary",
    "details": {},
    "suggestedNextActions": []
  }
}
```

Clients should branch on `error.code`, not `error.message`.

## Error Codes

| Code | Meaning | Typical recovery |
| --- | --- | --- |
| `DENIED_PATH` | Requested path is inside a denied workspace segment such as `.git`, `node_modules`, or `.agentshell`. | Pick a project file outside denied paths. |
| `FILE_NOT_FOUND` | Input or target file does not exist. | Re-check the path or regenerate the referenced template. |
| `FILE_OUTSIDE_WORKSPACE` | Requested path resolves outside the workspace root. | Use a workspace-relative path. |
| `FIX_SUGGESTION_UNAVAILABLE` | Diagnosis ran, but `fix test` could not produce a safe automatic suggestion. | Inspect the nested suggestion error or fill the generated template manually. |
| `HASH_MISMATCH` | Target file changed after the hash was captured. | Re-read the file and rebuild the change or template fill. |
| `INVALID_ARGUMENT` | CLI arguments are missing or unsupported. | Re-run with the documented command form. |
| `INVALID_CHANGE` | Change JSON is malformed or missing required edit data. | Validate the change file against the schema. |
| `INVALID_FILL` | Fill JSON is malformed or incompatible with the template. | Regenerate or correct the fill payload. |
| `INVALID_RANGE` | Requested or supplied line range is malformed or invalid for the file. | Re-read the file and choose a valid range. |
| `LOG_NOT_FOUND` | Requested stored log reference does not exist. | Use a current `logRef` from verification or diagnosis output. |
| `NO_CHANGE_SUGGESTION` | No active diagnosis with a change template exists. | Run `agentshell diagnose test --compact`. |
| `NOT_A_FILE` | Target path exists but is not a regular file. | Choose a file path. |
| `OPERATION_NOT_FOUND` | No matching change operation exists for undo. | Inspect history and choose an undoable operation id. |
| `OPERATION_NOT_UNDOABLE` | The requested operation cannot be undone. | Restore manually or choose a different operation. |
| `PACKAGE_NOT_FOUND` | No `package.json` was found for a package-script command. | Run from a Node workspace or add `package.json`. |
| `QUERY_NOT_FOUND` | `read --around` could not find the query. | Use `agentshell find` or a different query. |
| `RANGE_TOO_LARGE` | Requested read range exceeds the command limit. | Read a smaller range. |
| `SCHEMA_NOT_FOUND` | Requested schema name is unknown. | Use `agentshell schema list`. |
| `SCRIPT_NOT_FOUND` | Requested package script is absent. | Add the script or choose a supported script type. |
| `SNAPSHOT_NOT_FOUND` | Undo snapshot for a changed file is missing. | Restore manually from source control or another backup. |
| `SUGGESTION_UNAVAILABLE` | `change suggest` could not compute a safe replacement. | Fill the generated template manually. |
| `TEMPLATE_NOT_FOUND` | Referenced change template file does not exist. | Regenerate diagnosis or pass an existing template. |
| `UNKNOWN_COMMAND` | CLI command is not recognized. | Use `agentshell --help` or `agentshell manual`. |
| `UNEXPECTED_ERROR` | Unhandled runtime error. | Inspect the message and retry after fixing the underlying issue. |

## Unsupported Results

Some commands can complete successfully while declining automation. These are not infrastructure failures and should not be modeled as process crashes.

Use `unsupportedReason` when the command understood the request but intentionally did not produce an automated result. The initial shared reasons are:

| Reason | Use when |
| --- | --- |
| `no-active-diagnosis` | A suggestion command needs diagnosis state but none exists. |
| `no-change-template` | Diagnosis exists but has no template to fill or suggest from. |
| `unsupported-pattern` | The code or test failure shape is outside current suggestion strategies. |
| `low-confidence` | A candidate exists but confidence is too low for automatic output. |
| `ambiguous-target` | Multiple plausible targets exist and the command cannot choose safely. |
| `unsafe-change` | The candidate edit appears risky even if it might be mechanically possible. |
| `missing-context` | Required file, log, hash, or run context is unavailable. |

Recommended future shape:

```json
{
  "ok": true,
  "supported": false,
  "unsupportedReason": "unsupported-pattern",
  "message": "No safe replacement suggestion available",
  "suggestedNextActions": []
}
```

Existing failure codes such as `SUGGESTION_UNAVAILABLE`, `NO_CHANGE_SUGGESTION`, and `FIX_SUGGESTION_UNAVAILABLE` remain valid. The `unsupportedReason` field is a forward-compatible refinement for success or nested result payloads where clients need to tell "not supported yet" apart from invalid input, missing files, or runtime errors.
