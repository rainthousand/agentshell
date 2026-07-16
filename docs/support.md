# Support diagnostics

AgentShell support bundles are deliberately small and private. They contain only
allowlisted versions, boolean installation checks, service-record presence, and
Dashboard snapshot counts. They never include source files, file contents, log
contents, command output, user paths, usage metrics, credentials, or secret
values.

Create a JSON bundle from an installed AgentShell:

```bash
agentshell support export --out agentshell-support.json
```

Create a ZIP containing `agentshell-support.json`:

```bash
agentshell support export --out agentshell-support.zip
```

Preview collection without writing a file:

```bash
agentshell support export --dry-run
```

The CLI locates its installed plugin package automatically. Release engineers
can also run `node scripts/support-bundle.js --package-dir <release-dir>` when
validating an unpacked package. The installed user's home is used only to check
known AgentShell-managed locations. It is never emitted. Support files are
created with owner-only permissions.

Before sending a bundle, users can open the JSON directly or inspect the ZIP
entry with `unzip -p agentshell-support.zip agentshell-support.json`.

For a release acceptance check, run:

```bash
node scripts/v1-clean-machine-smoke.js \
  --package-dir /path/to/agentshell-codex-plugin
```

This creates a temporary isolated home and runs install, doctor, update,
Dashboard status, and uninstall through the package's standalone CLI. LaunchAgent
management is intentionally reported as `skipped` because a smoke test must not
load a user service from a synthetic home. A dry run performs the same planning
and Dashboard contract check without creating managed installation state.
