# Core Workflow

Use this reference for project entry, health, change impact, and dependency shape.

## Entry

- `agentshell start --compact` or `agentshell entry --compact`: cheapest combined doctor, compact understanding, and next-action summary. Use the full form only when embedded details are necessary.
- `agentshell doctor`: runtime, project manifest, test command, state, git readiness, and toolchain checks.
- `agentshell understand --compact`: first-pass project inspection.
- `agentshell manual`: compact command router. Prefer a focused `--topic`; reserve `--full` for gaps.
- `agentshell manual --topic onboarding`: focused first-checkout flow.
- `agentshell manual --topic repair`: focused failing-test workflow.
- `agentshell manual --topic log-triage`: summary-first noisy-log workflow.
- All focused topics: `agentshell manual --topic repair|plugin|benchmark|profile|onboarding|log-triage|reference`.
- Use `agentshell runtime start` to enable the optional local metadata cache; inspect it with `agentshell runtime status --compact` and stop it with `agentshell runtime stop`.
- Use `agentshell coverage candidates --limit 10` to rank privacy-safe unsupported command families before adding new profiles.
- Use `agentshell workspace guard --root <repo-a> --root <repo-b> --compact` before coordinated multi-repository edits. Use `agentshell workspace audit --root <repo-a> --root <repo-b> --compact` to summarize branch and dirty/risk state across those repositories, and `agentshell compare-search <query> --root <repo-a> --root <repo-b> --compact` for aligned cross-repository evidence.
- `agentshell manual --full`: complete command map only when focused topics are insufficient.

In Codex, retain the project working directory and prefer the newest installed plugin-cache `bin/agentshell`, so a stale standalone on `PATH` cannot shadow the active plugin. In a checkout use `./bin/agentshell` or `node src/cli.js`; use the PATH command when no plugin cache is installed.

## Project Shape And Health

- `agentshell project health --compact`: test command, config, dependency, git, and CI signals without running tests.
- `agentshell tree --compact`: bounded source, test, docs, scripts, and entry-file tree while ignoring generated folders.
- `agentshell config list --compact`: common package, language, build, lint, Go, Make, Docker, CI, Codex, and AgentShell configuration.
- `agentshell package scripts --compact` and `agentshell package script <name> --compact`: inspect script categories and risk before execution.
- `agentshell package deps --compact`: bounded Node, Go, Python, and Java dependency and lockfile summary.
- `agentshell test list --compact` and `agentshell test command --compact`: discover tests and choose a likely command without executing it.

## Change And Git Context

- `agentshell files changed --compact`: changed-file categories and risk.
- `agentshell changed impact --compact`: impact and recommended validation commands.
- `agentshell verify changed --include-dependents --compact`: build a conservative plan that includes reliable Go or Node reverse dependents; review the plan before adding `--execute`.
- `agentshell file info <path> --compact`: hash, language, size, git metadata, generated/binary status, and symbol summary.
- `agentshell git status --compact`: working-tree state and generated or lockfile risk.
- `agentshell git diff --compact [--staged]`: diff stats, hunk locations, risk, and a `diffRef` for deferred raw retrieval.
- `agentshell git log --compact --limit N`: bounded history without patches.
- `agentshell git branch --compact`: current branch, upstream, ahead/behind, and redacted remote metadata.

After inspection, follow `suggestedNextActions` and use `agentshell run next` when only the shortest next step is needed.
