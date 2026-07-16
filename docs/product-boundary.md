# AgentShell Product Boundary

AgentShell is currently a local CLI and Codex plugin for agent-native coding workflows. The product boundary is intentionally narrow: make common codebase inspection, failing-test diagnosis, conservative repair, verification, plugin install, and evidence collection faster and cheaper for AI agents.

This document is the release-scope contract for v0.25 and the v1.0 bar. New work should either strengthen the local CLI/plugin path below or be deferred until the freeze is lifted.

## In Scope

AgentShell supports:

- Compact project entry with `agentshell start --compact`.
- Bounded search/read workflows through AgentShell JSON.
- Failing-test diagnosis for supported JavaScript and TypeScript failure shapes.
- Conservative automatic repairs only when a strategy can identify one safe target.
- Hash-checked edits, dry runs, undo guidance, and rollback commands.
- Compact verification and log retrieval for test output that would otherwise flood context.
- Codex plugin install, local plugin validation, share-package handoff, and self-diagnosis.
- Benchmark, performance, real-project candidate, and Codex plugin evidence reports.
- Schema/manual contracts for shell-callable adapters that wrap the same CLI behavior.
- A managed native macOS menu-bar Dashboard backed by local, path-free workspace snapshots.

## Out Of Scope

AgentShell does not currently support:

- General-purpose OS replacement behavior.
- Unbounded autonomous repo mutation.
- Broad natural-language task planning outside coding workflows.
- Cloud services, hosted telemetry, or remote execution.
- Package publishing, account setup, or other credential-dependent workflows.
- Large refactors, multi-file architectural rewrites, or ambiguous repairs.
- Automatic fixes for unsupported failure shapes, even when diagnosis can summarize them.
- MCP server productization. MCP remains low-priority until the local CLI/plugin path is stable with external users.
- Native Windows and Linux Dashboard applications. Those platforms may use the browser surface until post-v1.0 work is prioritized.

## Fallback To Shell

Use normal shell commands when:

- AgentShell has no command for the needed operation.
- The task needs interactive tooling, network setup, package publishing, or environment-specific debugging.
- The task needs repo-specific build, lint, typecheck, or generation commands that are not exposed through AgentShell.
- The failure pattern is unsupported or `agentshell change suggest` reports an unsupported reason.
- The agent needs exploratory one-off inspection that would be clearer with `rg`, `sed`, `git`, package-manager commands, or project-native scripts.
- Full logs are required after compact summaries and `agentshell log get --tail N` are insufficient.

After falling back, return to AgentShell for compact verification, log references, rollback-aware repairs, or product evidence when those commands fit the task again.

## v0.25 Feature Freeze

v0.25 should freeze the externally visible product shape around:

- Codex plugin first-pass flow: `start --compact -> fix/diagnose/verify`.
- Non-developer share package install and local reinstall/update path.
- Plugin self-diagnosis, local validation, smoke checks, and primary next actions.
- Real-project candidate importer/evaluator and checked-in fixture evidence.
- Performance summary across token, speed, command-count, and cold-start metrics.
- Evidence guardrails that mark placeholder run logs as incomplete.
- Product readiness checks that keep docs, schemas, scripts, and deferred MCP language aligned.

During the v0.25 freeze, avoid expanding the automatic repair surface unless the new strategy is conservative, covered by fixtures, exposed in docs, and does not change the core protocol contract. Prefer documentation, evidence, installer hardening, and clearer fallback guidance over new feature categories.

The current V1 candidate is `1.0.0+codex.20260716102207`. Git import and the
private-repository push are complete. Local release artifacts, share ZIP
creation, checksum/archive verification, and packaged lifecycle smoke are also
complete. GitHub Release `v0.25.3` is published, and clean downloaded copies of
the standalone binary and plugin ZIP passed their published checksums. No
blocking release-engineering gate remains for this version.

## v1.0 Feature Freeze

Before v1.0, require:

- Product readiness passing with no blocking failures.
- The release CI matrix and downloadable-asset verification passing.
- Clear documented fallback behavior in README and product docs.
- Stable command-scoped protocol versions or documented migrations for any breaking response changes.
- A supported install/update story for the share package and Codex plugin cache.
- No MCP dependency for the core local plugin workflow.

External-user runs are encouraged as post-release learning evidence, but there
is no minimum-user gate. Claims based only on local fixtures or AgentShell
telemetry must keep their measurement boundary explicit. MCP productization and
native Windows/Linux surfaces remain deferred and do not block v1.0 of the
macOS local CLI/plugin product.

Post-v1.0 expansion should keep the same center of gravity: the CLI remains the canonical runtime, the Codex plugin and adapters remain thin guidance layers, and MCP remains a later compatibility adapter rather than a second product surface.
