# AgentShell Privacy Policy

Effective date: July 16, 2026

AgentShell is a local command-line tool and Codex skill published by Alvin. It
processes project files and command output on the user's computer to provide
structured project inspection, test diagnosis, verification, and local metrics.

## Data handling

AgentShell does not operate a hosted service and does not transmit project
files, command output, usage metrics, or credentials to the developer. Normal
operation stores only local state needed for logs, rollback, metrics, plugin
health, and the optional menu-bar dashboard.

Users choose whether to export support or trial evidence. These exports are
created locally and are never uploaded automatically. Support bundles use an
allowlist and exclude source files, file contents, command output, user paths,
usage metrics, credentials, and secret values.

AgentShell may invoke tools already installed on the user's computer, including
the project's test command and Git. Those tools remain subject to their own
configuration and privacy practices. Installing AgentShell from GitHub also
involves GitHub's services and policies.

## Retention and deletion

Local AgentShell state remains on the user's computer until it is removed by
the user. The supported uninstall flow removes AgentShell-managed installation
and service files. Project-local state can be deleted by removing the
`.agentshell` directory in that project.

## Contact

For privacy questions or reports, open a private security report through
[GitHub Security Advisories](https://github.com/rainthousand/agentshell/security/advisories/new)
or use the public [issue tracker](https://github.com/rainthousand/agentshell/issues).

Material changes to this policy will be recorded in the repository history and
release notes.
