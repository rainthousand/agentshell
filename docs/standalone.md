# AgentShell Standalone

AgentShell can be compiled into a single executable for Apple silicon Macs. The current standalone target is deliberately narrow: macOS on arm64.

## End-user requirements

An end user needs:

- macOS on an Apple silicon Mac
- Codex for the plugin workflow
- the matching AgentShell plugin package and `agentshell-darwin-arm64` executable

The compiled AgentShell executable does not require Node.js, npm, or Bun at runtime. The plugin installer can place it on `PATH`; users should not need a JavaScript development environment to run AgentShell commands.

Tagged releases publish the executable, its SHA-256 checksum, the Codex plugin ZIP, the ZIP checksum, and the release audit report as GitHub Release Assets. The compiled executable is intentionally not tracked in Git; source checkouts build it locally or download it from the matching release.

## Maintainer build

Maintainers need the pinned release toolchain: Node.js `20.20.2`, Bun `1.2.20`, `codesign`, and network access to the pinned `postject` injector. Real standalone and native release builds fail before producing artifacts when either runtime version differs. The builder uses Node SEA rather than a Bun-native executable so the resulting Mach-O can be signed and executed reliably on current macOS. From the repository root:

```bash
npm run build:standalone
```

The default artifact is:

```text
bin/agentshell-darwin-arm64
```

This path is ignored by Git. The tag-triggered Release workflow rebuilds it with the pinned toolchain, verifies its signature, checksum, smoke checks, and package lifecycle, then uploads the audited result to the GitHub Release.

Choose another output path or inspect the build without compiling:

```bash
npm run build:standalone -- --out artifacts/standalone/agentshell
npm run build:standalone -- --dry-run
```

After bundling, SEA injection, and ad-hoc signing, the builder runs the binary from a temporary non-source directory and checks `--version`, `schema list`, and `plugin status --compact`. It emits `agentshell.standalone-build.v1` JSON containing the target, artifact size, SHA-256 digest, smoke results, builder versions, a strict toolchain attestation, and `runtimeDependency: false`. Release packaging verifies that attestation and checks that its binary SHA-256 matches the build report.

Set `AGENTSHELL_TEST_STANDALONE=1` to include the real signed SEA build in the test suite. Ordinary tests use the dry-run path so repository validation remains deterministic when build tools are unavailable. `--dry-run` and `AGENTSHELL_SKIP_NATIVE_RELEASE_BUILD=1` report the detected toolchain as informational and do not require Bun; they cannot be mistaken for a native release build because the report marks enforcement explicitly.

## Scope

The standalone executable removes Node/npm from AgentShell's end-user runtime. This Beta artifact is ad-hoc signed; Developer ID signing and notarization remain release requirements before public distribution. Intel macOS, Linux, and Windows are not yet claimed as supported targets.
