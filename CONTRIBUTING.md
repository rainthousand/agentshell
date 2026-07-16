# Contributing To AgentShell

AgentShell V1 keeps a deliberately narrow product contract. Changes should make
the local CLI and Codex plugin faster, cheaper, safer, or easier to operate
without expanding scope casually.

## Before Opening A Pull Request

1. Run `agentshell start --compact` from the repository root.
2. Add focused tests for behavioral changes.
3. Run `agentshell verify test --compact`.
4. Run `npm run plugin:validate:source` for plugin-facing changes.
5. Run `npm run product:readiness -- --heavy --dry-run --compact` for release,
   installer, protocol, or documentation changes.

Keep protocol changes backward compatible or document and test the version
transition. Do not commit credentials, absolute user paths, runtime state,
`node_modules`, release artifacts, or standalone binaries.

Use GitHub private vulnerability reporting for security issues instead of a
public issue.
