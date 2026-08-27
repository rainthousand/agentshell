# Change-aware workflows

AgentShell's change-aware core turns Git changed files into a bounded verification plan and checks those paths against generic workspace boundaries. This module is intentionally not connected to the public CLI yet.

## Changed verification

`verifyChanged(root, options)` defaults to plan mode. It does not run formatters, builds, or tests unless `options.execute === true`.

The planner recognizes root Node, Go, Python, and Java manifests:

- Node uses configured non-mutating format or lint scripts, a configured build script, and the complete configured test script.
- Go checks changed files with `gofmt -d`. It narrows compile and test commands to changed package directories only when every mapping is reliable. Changes to Go control files use `./...`.
- Python uses configured Ruff or Black checks when present, then performs complete compilation and tests because imports and fixtures can cross directories.
- Java uses Maven or Gradle wrappers when available and performs complete compile and test tasks because package paths do not reliably identify module dependencies.

`includeDependents: true` enables conservative reverse-dependency expansion:

- Go runs `go list -json ./...` with `shell: false`, fixed timeout, byte, package, and target bounds. Discovery disables Go environment files, proxies, checksum lookups, and automatic toolchain downloads; forces `-mod=readonly`; and discards inherited `GOWORK` and `GOFLAGS` values before mapping direct, test, and transitive reverse dependents.
- Node narrows build and test steps to affected workspaces only when a root `workspaces` declaration, every member manifest, unique package names, dependency edges, and per-workspace test scripts are all reliable. A configured root non-mutating format or lint gate is retained.
- Python and Java retain complete verification because their runtime and build graphs are not inferred here.
- Any command failure, malformed or incomplete graph, path outside the workspace, ambiguous package, unsupported workspace pattern, missing test script, or graph/target/plan bound forces full verification (`./...` for Go).

The option defaults to `false`, preserving the original changed-directory behavior.

Unknown non-documentation files, truncated changed-file input, and uncertain mappings trigger full verification. A smaller plan is never selected merely because a file could not be classified.

Every executable step is represented as an argument array:

```json
{
  "kind": "test",
  "ecosystem": "go",
  "scope": "packages",
  "argv": ["go", "test", "./internal/parser"],
  "fallback": false
}
```

Execute mode passes these arrays directly to `spawn` with `shell: false`. Compact execution results omit raw stdout and stderr, retaining only exit status, duration, timeout and truncation flags, and a bounded error summary.

The response schema accepts either the bounded structured verification result (whose `ok` value reflects executed test outcomes) or AgentShell's shared failure object when changed-file discovery or planning cannot start.

## Boundary policy

`boundaryCheck(root, options)` is read-only. A policy can be supplied as an object or as a workspace-relative JSON file. No business or repository names are built into the evaluator.

Rules support workspace-relative glob and prefix matching:

```json
{
  "name": "service-scope",
  "defaultEffect": "allow",
  "rules": [
    {
      "id": "service-a",
      "effect": "allow",
      "prefixes": ["services/a"]
    },
    {
      "id": "generated",
      "effect": "deny",
      "globs": ["**/generated/**"],
      "reason": "Generated files must not be edited directly"
    }
  ]
}
```

Deny rules take precedence. When at least one allow rule exists, files outside every allow rule are violations. Without allow rules, `defaultEffect` controls unmatched files and defaults to `allow`.

Policies and output are bounded:

- at most 100 rules and 100 patterns per rule;
- at most 500 changed files are planned;
- at most 100 boundary violations and 200 file decisions are returned;
- paths outside the workspace cannot be used as policy files;
- malformed policies fail closed with structured errors.

## Intended CLI contract

The command adapters are ready for a later public CLI connection:

```text
agentshell verify changed --compact
agentshell verify changed --include-dependents --compact
agentshell verify changed --execute --compact
agentshell boundary check --policy .agentshell/boundaries.json --compact
```

This batch deliberately does not modify the CLI router, existing verification command, command registry, package scripts, or README.
