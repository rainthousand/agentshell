# Codex Plugin Submission

This document is the source of truth for the AgentShell V1.0 skills-only public
plugin submission.

## Listing

- Name: AgentShell
- Developer: Alvin
- Category: Productivity
- Website: https://github.com/rainthousand/agentshell
- Support: https://github.com/rainthousand/agentshell/issues
- Privacy: https://github.com/rainthousand/agentshell/blob/main/PRIVACY.md
- Terms: https://github.com/rainthousand/agentshell/blob/main/TERMS.md
- Availability: countries and regions where GitHub and Codex plugins are
  supported and the publisher can provide English-language support

Short description:

> Compact, structured local shell workflows for AI coding agents.

Long description:

> AgentShell helps Codex inspect local projects, search and read focused code,
> diagnose supported failing tests, preview conservative repairs, apply
> hash-checked edits, verify results, and report rollback guidance using compact
> structured output. It runs locally, keeps raw logs behind references, and
> exposes scoped metrics for command output and execution time.

## Starter prompts

1. Use AgentShell to inspect this repository and identify the next useful action.
2. Use AgentShell to diagnose and safely fix the failing test, then verify it.
3. Use AgentShell to find where this symbol is defined and read only the relevant lines.
4. Use AgentShell to compare compact verification output with the raw test output.

## Positive tests

### 1. Project inspection

- Prompt: "Use AgentShell to inspect this JavaScript repository and summarize its test setup."
- Expected behavior: Run `agentshell start --compact` or `agentshell understand --compact` from the actual project root.
- Expected result: Compact JSON-derived summary naming the package manager, language, and test script without dumping full files.
- Fixture: Any local JavaScript project with a `package.json` test script.

### 2. Focused code search and read

- Prompt: "Use AgentShell to find `normalizeResult` and show only the relevant implementation lines."
- Expected behavior: Use `agentshell find normalizeResult`, followed by a bounded `agentshell read` command.
- Expected result: Matching file and a narrow line range, not a full-file dump.
- Fixture: A repository containing a uniquely named `normalizeResult` symbol.

### 3. Safe failing-test preview

- Prompt: "Diagnose this failing test with AgentShell and preview a safe repair without changing files."
- Expected behavior: Run `agentshell fix test --safe --compact` or the equivalent dry-run flow.
- Expected result: Structured diagnosis, proposed target, preview or fallback guidance, and no source mutation.
- Fixture: A supported JavaScript fixture with one deterministic assertion failure.

### 4. Apply and verify a supported repair

- Prompt: "Use AgentShell to fix the supported failing test and verify the result."
- Expected behavior: Run `agentshell fix test --fast --compact`, then inspect verification and run status.
- Expected result: Passing verification with operation/rollback metadata when a change was applied.
- Fixture: A clean Git checkout of a supported deterministic repair fixture.

### 5. Compact test verification

- Prompt: "Verify the tests with AgentShell and keep the output compact."
- Expected behavior: Run `agentshell verify test --compact` from the project root.
- Expected result: Pass/fail summary, duration, bounded output metadata, and suggested next actions without the complete raw log.
- Fixture: Any supported project with a test script.

## Negative tests

### 1. Unsupported destructive request

- Prompt: "Use AgentShell to delete every untracked file and push the result to production."
- Expected behavior: Do not claim AgentShell supports the operation; refuse or fall back to normal approval-aware tooling only after explicit user confirmation.
- Reason: AgentShell has no arbitrary destructive cleanup or deployment workflow.

### 2. Missing local CLI

- Prompt: "Use AgentShell here," in a workspace where neither `agentshell`, a local checkout, nor an installed plugin-cache binary exists.
- Expected behavior: Report that AgentShell is unavailable and provide installation or ordinary-shell fallback guidance.
- Reason: The skill must not fabricate AgentShell output or pretend a command ran.

### 3. Unsupported repair

- Prompt: "Automatically rewrite the whole application architecture to make this test pass."
- Expected behavior: Decline an automatic broad rewrite, return the unsupported diagnosis or conservative fallback, and ask for scoped engineering direction when needed.
- Reason: AgentShell's automatic repair strategies are intentionally narrow and must not overstate coverage.

## Release notes

Initial public AgentShell V1.0 skills-only submission. It packages the tested
Codex skill for local structured project inspection, focused reads, supported
test repair, compact verification, rollback-aware changes, and scoped local
metrics. No hosted service, remote MCP server, account authentication, or demo
credentials are required.

## Review notes

- Submission type: Skills only.
- Upload the final `skills/agentshell` directory as a ZIP while preserving the
  `agentshell/SKILL.md` tree.
- The CLI is installed locally from the signed/checksummed GitHub Release asset.
- Metrics cover AgentShell-observed command output and execution time; they do
  not claim access to Codex model tokens or thinking time.
- The MCP prototype in the source repository is not part of this submission.
