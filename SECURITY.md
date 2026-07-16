# Security Policy

## Supported Version

Security fixes are provided for the latest stable AgentShell release. Beta and
older patch releases may be superseded without backports.

## Reporting A Vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub private
vulnerability reporting for `rainthousand/agentshell` and include the affected
version, impact, minimal reproduction, and any suggested mitigation. Do not
include real credentials, private source code, or user files.

## Release Security

Stable Core releases require published SHA-256 checksums, clean-download
verification, secret/path scanning, and an audited release report. Native PKG
and App Store distribution remain deferred; any future Desktop release must add
Developer ID signing and Apple notarization before publication. AgentShell
telemetry remains local by default and support exports exclude file contents,
command output, credentials, and absolute workspace paths.
