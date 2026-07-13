# AgentShell Standalone

AgentShell can be compiled into a single executable for Apple silicon Macs. The current standalone target is deliberately narrow: macOS on arm64.

## End-user requirements

An end user needs:

- macOS on an Apple silicon Mac
- Codex for the plugin workflow
- the matching AgentShell plugin package and `agentshell-darwin-arm64` executable

The compiled AgentShell executable does not require Node.js, npm, or Bun at runtime. The plugin installer can place it on `PATH`; users should not need a JavaScript development environment to run AgentShell commands.

## Maintainer build

Maintainers need Node.js, Bun for bundling, `codesign`, and network access to the pinned `postject` injector. The builder uses Node SEA rather than a Bun-native executable so the resulting Mach-O can be signed and executed reliably on current macOS. From the repository root:

```bash
npm run build:standalone
```

The default artifact is:

```text
bin/agentshell-darwin-arm64
```

Choose another output path or inspect the build without compiling:

```bash
npm run build:standalone -- --out artifacts/standalone/agentshell
npm run build:standalone -- --dry-run
```

After bundling, SEA injection, and ad-hoc signing, the builder runs the binary from a temporary non-source directory and checks `--version`, `schema list`, and `plugin status --compact`. It emits `agentshell.standalone-build.v1` JSON containing the target, artifact size, SHA-256 digest, smoke results, builder versions, and `runtimeDependency: false`.

Set `AGENTSHELL_TEST_STANDALONE=1` to include the real signed SEA build in the test suite. Ordinary tests use the dry-run path so repository validation remains deterministic when build tools are unavailable.

## Scope

The standalone executable removes Node/npm from AgentShell's end-user runtime. This Beta artifact is ad-hoc signed; Developer ID signing and notarization remain release requirements before public distribution. Intel macOS, Linux, and Windows are not yet claimed as supported targets.
