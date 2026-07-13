# Repository Import Plan

This checkout should be imported as a tracked project when the user is ready to
preserve AgentShell source, tests, schemas, examples, docs, adapter templates,
and plugin metadata in the parent repository. The project is functionally ready
for review, but import should be an explicit user-approved action because the
entire `agentshell/` tree is currently untracked from the parent repository.

## Decision

Import `agentshell/` as a normal tracked project after user confirmation, not as
part of routine feature work.

Recommended timing:

- Import before relying on this checkout as the canonical AgentShell source.
- Import before publishing another plugin build that should be reproducible from
  parent-repository history.
- Import after the current untracked source tree has been reviewed as one
  intentional project addition.
- Do not import opportunistically during unrelated code, docs, benchmark, or
  smoke-test tasks.

Current decision for this task: prepare the plan and leave execution waiting for
user confirmation.

## Import Boundary

Track source and project assets needed to build, test, document, and package
AgentShell:

- `.codex-plugin/plugin.json`
- `.gitignore`
- `AGENTS.md`
- `README.md`
- `TODO.md`
- `bin/`
- `docs/`
- `examples/`
- `package.json`
- `schemas/`
- `scripts/`
- `skills/`
- `src/`
- `tests/`

Keep runtime and dependency state untracked:

- `.agentshell/`
- `node_modules/`
- generated benchmark, evaluation, or smoke-test artifacts unless a specific
  task asks to promote one as a checked-in fixture

The local `.gitignore` already excludes `.agentshell/` and `node_modules/`.
Before staging the import, verify that the parent repository still does not show
runtime files under `agentshell/.agentshell/`.

## Pre-Import Checks

Run these checks from `agentshell/` before staging:

```bash
git status --short --untracked-files=all
npm test
npm run plugin:validate
npm run plugin:smoke
npm run benchmark:suite:ci
npm run eval:real-projects
```

If dependency installation is needed, run it before the checks and confirm that
`node_modules/` remains ignored.

For real-project candidate review, do not import or download repositories just
to make the initial queue concrete. Register candidates first with
`examples/real-project-candidates.sample.json` or another candidate file:

```bash
node scripts/real-project-candidates.js \
  --candidates examples/real-project-candidates.sample.json \
  --report artifacts/real-project-candidates.sample.json \
  --manifest-draft artifacts/real-projects.sample.draft.json \
  --markdown artifacts/real-project-candidates.sample.md
```

Remote URL and `owner/repo` candidates are intentionally reported as blocked
with `checkout-required` and remain skipped in the generated manifest draft.
Use their `candidateScore`, `priority`, `blockers`, `warnings`, and
`nextAction` fields to decide what deserves a later local checkout. Only merge
draft entries into `examples/real-projects.json` after the repository exists
locally, has a deterministic `testCommand`, and has reviewed setup commands,
setup links, expected failure class, and allowed strategies.

Review these points before importing:

- The untracked file list should contain only intentional project files plus
  ignored runtime/dependency state.
- `.agentshell/` should stay absent from `git status --short
  --untracked-files=all`.
- No generated report under an artifacts directory should be included unless it
  is deliberately promoted and documented.
- README, protocol docs, schemas, tests, and release notes should describe the
  same supported commands and strategies.
- Plugin smoke should continue to prove the installed payload excludes
  `.agentshell`, `.git`, and `node_modules`.

## Staging And Commit Plan

Use one explicit import commit for the initial tracked project addition:

```bash
git add agentshell
git status --short
git commit -m "Import AgentShell project"
```

Commit boundary:

- Include the complete AgentShell source tree and project docs in one import
  commit so later feature changes can be reviewed as normal deltas.
- Exclude parent-repository cleanup, unrelated docs, generated reports, runtime
  logs, local caches, and dependency folders.
- Do not mix the import with feature implementation, release publication, or
  plugin installation changes.
- If follow-up fixes are discovered during import review, commit the import
  first only if the tree is already coherent; otherwise fix inside
  `agentshell/`, rerun checks, and then import.

## Why This Task Does Not Stage Or Commit

This task only defines the engineering decision and executable import plan. It
does not run `git add` or `git commit` because importing `agentshell/` changes
the parent repository's tracked surface area by many files. That should happen
only after the user confirms the import boundary and timing.
