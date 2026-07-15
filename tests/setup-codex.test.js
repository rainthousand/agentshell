import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { setupCodex } from "../src/commands/setup-codex.js";
import { registerWorkspace } from "../src/core/workspace-registry.js";

test("setupCodex installs plugin, policy, and native CLI without node or npm", async () => {
  const fixture = makeFixture();
  const calls = [];
  const runCommand = successfulRunner(calls);

  const result = await setupCodex("install", { ...fixture, runCommand });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.setup-codex.v1");
  assert.deepEqual(calls.map(({ command, args }) => [command, ...args]), [
    ["codex", "plugin", "add", "agentshell@personal"],
    [path.join(fixture.home, ".local", "bin", "agentshell"), "--version"]
  ]);
  assert.equal(calls.some(({ command }) => command === "node" || command === "npm"), false);

  const installed = path.join(fixture.home, ".local", "bin", "agentshell");
  assert.equal(fs.readFileSync(installed, "utf8"), "native-cli");
  assert.notEqual(fs.statSync(installed).mode & 0o111, 0);
  assert.match(fs.readFileSync(path.join(fixture.home, ".codex", "AGENTS.md"), "utf8"), /AgentShell Default Policy/);
  assert.equal(fs.existsSync(path.join(fixture.home, "plugins", "agentshell", ".codex-plugin", "plugin.json")), true);

  const recordPath = path.join(fixture.home, ".agentshell", "standalone-install.json");
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  assert.equal(record.path, installed);
  assert.equal(record.sha256, hash(installed));
  assert.equal(record.pathProfile.path, path.join(fixture.home, ".zprofile"));
  assert.equal(result.commandPath.status, "profile-updated");
  assert.equal(result.commandPath.fallbackCommand, installed);
  assert.equal(result.plugin.legacyDashboardMigration.reason, "isolated-home");
  assert.equal(fs.statSync(recordPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(recordPath)).mode & 0o777, 0o700);
});

test("setupCodex seeds dashboard snapshots from accessible registered workspaces", async () => {
  const fixture = makeFixture();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-setup-snapshot-"));
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "setup-snapshot" }));
  registerWorkspace(project, { homeDir: fixture.home });

  const result = await setupCodex("install", { ...fixture, runCommand: successfulRunner([]) });

  assert.equal(result.ok, true);
  assert.deepEqual(result.dashboardSnapshots, {
    ok: true,
    status: "refreshed",
    refreshed: 1,
    skipped: 0
  });
  const snapshots = path.join(fixture.home, ".agentshell", "dashboard-snapshots");
  assert.equal(fs.readdirSync(snapshots).filter((file) => file.endsWith(".json")).length, 1);
});

test("setupCodex dry run makes no changes or subprocess calls", async () => {
  const fixture = makeFixture();
  const calls = [];

  const result = await setupCodex("update", { ...fixture, dryRun: true, runCommand: successfulRunner(calls) });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.nativeCli.status, "would-install");
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(path.join(fixture.home, ".local", "bin", "agentshell")), false);
  assert.equal(fs.existsSync(path.join(fixture.home, ".codex", "AGENTS.md")), false);
  assert.equal(fs.existsSync(path.join(fixture.home, "plugins")), false);
  assert.equal(fs.existsSync(path.join(fixture.home, ".zprofile")), false);
});

test("setupCodex rejects a package without a matching prebuilt CLI", async () => {
  const fixture = makeFixture();
  fs.rmSync(path.join(fixture.source, "bin", `agentshell-${fixture.platform}-${fixture.arch}`));

  const result = await setupCodex("install", fixture);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "NATIVE_CLI_MISSING");
  assert.equal(fs.existsSync(path.join(fixture.home, "plugins")), false);
});

test("setupCodex restores an existing CLI when version validation fails", async () => {
  const fixture = makeFixture();
  const installed = path.join(fixture.home, ".local", "bin", "agentshell");
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, "existing-cli", { mode: 0o755 });
  const runCommand = async (command, args) => ({ ok: command === "codex" && args[0] === "plugin", status: command === "codex" ? 0 : 1 });

  const result = await setupCodex("install", { ...fixture, runCommand });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "NATIVE_CLI_INVALID");
  assert.equal(fs.readFileSync(installed, "utf8"), "existing-cli");
  assert.equal(fs.existsSync(path.join(fixture.home, ".agentshell", "standalone-install.json")), false);
});

test("setupCodex uninstall removes only a CLI matching its managed hash", async () => {
  const fixture = makeFixture();
  const runner = successfulRunner([]);
  assert.equal((await setupCodex("install", { ...fixture, runCommand: runner })).ok, true);
  const installed = path.join(fixture.home, ".local", "bin", "agentshell");

  const removed = await setupCodex("uninstall", { ...fixture, runCommand: runner });
  assert.equal(removed.ok, true);
  assert.equal(removed.nativeCli.status, "removed");
  assert.equal(fs.existsSync(installed), false);
  assert.equal(fs.existsSync(path.join(fixture.home, "plugins", "agentshell")), false);
  assert.equal(fs.existsSync(path.join(fixture.home, ".zprofile")), false);

  assert.equal((await setupCodex("install", { ...fixture, runCommand: runner })).ok, true);
  fs.writeFileSync(installed, "user replacement", { mode: 0o755 });
  const preserved = await setupCodex("uninstall", { ...fixture, runCommand: runner });
  assert.equal(preserved.nativeCli.status, "preserved-modified");
  assert.equal(fs.readFileSync(installed, "utf8"), "user replacement");
});

test("setupCodex doctor reports plugin, policy, native CLI, and Codex checks", async () => {
  const fixture = makeFixture();
  const runner = successfulRunner([]);
  await setupCodex("install", { ...fixture, runCommand: runner });

  let result = await setupCodex("doctor", { ...fixture, runCommand: runner });
  assert.equal(result.checks.plugin, true);
  assert.equal(result.checks.policy, true);
  assert.equal(result.checks.nativeCli, true);
  assert.equal(result.checks.commandPath, true);
  assert.equal(result.checks.codex, true);

  result = await setupCodex("doctor", { ...fixture, runCommand: async () => ({ ok: false, status: 127 }) });
  assert.equal(result.ok, false);
  assert.equal(result.checks.codex, false);
  assert.equal("stdout" in result.codex, false);
  assert.equal("stderr" in result.codex, false);
});

test("setupCodex keeps PATH profile changes idempotent and preserves user content on uninstall", async () => {
  const fixture = makeFixture();
  const profile = path.join(fixture.home, ".zprofile");
  fs.mkdirSync(fixture.home, { recursive: true });
  fs.writeFileSync(profile, "export EDITOR=vim");
  const runner = successfulRunner([]);

  assert.equal((await setupCodex("install", { ...fixture, runCommand: runner })).commandPath.status, "profile-updated");
  assert.equal((await setupCodex("update", { ...fixture, runCommand: runner })).commandPath.status, "profile-configured");
  const configured = fs.readFileSync(profile, "utf8");
  assert.equal(configured.match(/>>> AgentShell managed PATH >>>/g)?.length, 1);

  const removed = await setupCodex("uninstall", { ...fixture, runCommand: runner });
  assert.equal(removed.commandPath.status, "removed");
  assert.equal(fs.readFileSync(profile, "utf8"), "export EDITOR=vim");
});

test("setupCodex preserves a PATH block modified by the user", async () => {
  const fixture = makeFixture();
  const runner = successfulRunner([]);
  await setupCodex("install", { ...fixture, runCommand: runner });
  const profile = path.join(fixture.home, ".zprofile");
  fs.writeFileSync(profile, fs.readFileSync(profile, "utf8").replace("$HOME/.local/bin", "$HOME/bin"));

  const result = await setupCodex("uninstall", { ...fixture, runCommand: runner });

  assert.equal(result.commandPath.status, "preserved-modified");
  assert.match(fs.readFileSync(profile, "utf8"), /\$HOME\/bin/);
});

test("setupCodex reports PATH visibility without changing a profile", async () => {
  const fixture = makeFixture();
  const bin = path.join(fixture.home, ".local", "bin");

  const result = await setupCodex("install", {
    ...fixture,
    env: { SHELL: "/bin/zsh", PATH: `/usr/bin${path.delimiter}${bin}` },
    runCommand: successfulRunner([])
  });

  assert.equal(result.commandPath.status, "visible");
  assert.equal(result.commandPath.visible, true);
  assert.equal(fs.existsSync(path.join(fixture.home, ".zprofile")), false);
});

test("setupCodex gives unsupported shells an absolute fallback command", async () => {
  const fixture = makeFixture();

  const result = await setupCodex("install", {
    ...fixture,
    env: { SHELL: "/usr/local/bin/fish", PATH: "/usr/bin" },
    runCommand: successfulRunner([])
  });

  assert.equal(result.ok, true);
  assert.equal(result.commandPath.ok, false);
  assert.equal(result.commandPath.status, "fallback-required");
  assert.equal(result.commandPath.fallbackCommand, path.join(fixture.home, ".local", "bin", "agentshell"));
  assert.equal(fs.existsSync(path.join(fixture.home, ".zprofile")), false);
});

test("setupCodex recognizes an existing unmanaged AgentShell PATH block without claiming ownership", async () => {
  const fixture = makeFixture();
  const profile = path.join(fixture.home, ".zprofile");
  fs.mkdirSync(fixture.home, { recursive: true });
  fs.writeFileSync(profile, [
    "# >>> AgentShell managed PATH >>>",
    'case ":$PATH:" in',
    '  *":$HOME/.local/bin:"*) ;;',
    '  *) export PATH="$HOME/.local/bin:$PATH" ;;',
    "esac",
    "# <<< AgentShell managed PATH <<<",
    ""
  ].join("\n"));

  const result = await setupCodex("install", { ...fixture, runCommand: successfulRunner([]) });
  assert.equal(result.commandPath.status, "profile-configured-unmanaged");
  const record = JSON.parse(fs.readFileSync(path.join(fixture.home, ".agentshell", "standalone-install.json"), "utf8"));
  assert.equal("pathProfile" in record, false);

  const removed = await setupCodex("uninstall", { ...fixture, runCommand: successfulRunner([]) });
  assert.equal(removed.commandPath.status, "not-managed");
  assert.match(fs.readFileSync(profile, "utf8"), /AgentShell managed PATH/);
});

test("setupCodex manages the macOS Dashboard service across install, doctor, update, and uninstall", async () => {
  const fixture = makeFixture();
  const calls = [];
  const options = {
    ...fixture,
    uid: 501,
    allowUserServiceManagement: true,
    runCommand: successfulRunner(calls)
  };

  const installed = await setupCodex("install", options);
  const plist = path.join(fixture.home, "Library", "LaunchAgents", "com.agentshell.dashboard.plist");
  assert.equal(installed.ok, true);
  assert.equal(installed.dashboardService.status, "running");
  assert.equal(fs.existsSync(plist), true);
  assert.deepEqual(launchctlCalls(calls), [
    ["bootout", "gui/501/com.agentshell.dashboard"],
    ["bootstrap", "gui/501", plist],
    ["print", "gui/501/com.agentshell.dashboard"]
  ]);
  const record = JSON.parse(fs.readFileSync(path.join(fixture.home, ".agentshell", "standalone-install.json"), "utf8"));
  assert.equal(record.dashboardService.path, plist);

  calls.length = 0;
  const healthy = await setupCodex("doctor", options);
  assert.equal(healthy.ok, true);
  assert.equal(healthy.checks.dashboardService, true);
  assert.deepEqual(launchctlCalls(calls), [["print", "gui/501/com.agentshell.dashboard"]]);

  calls.length = 0;
  const updated = await setupCodex("update", options);
  assert.equal(updated.dashboardService.status, "running");
  assert.deepEqual(launchctlCalls(calls), [
    ["bootout", "gui/501/com.agentshell.dashboard"],
    ["bootstrap", "gui/501", plist],
    ["print", "gui/501/com.agentshell.dashboard"]
  ]);

  calls.length = 0;
  const removed = await setupCodex("uninstall", options);
  assert.equal(removed.dashboardService.status, "removed");
  assert.equal(fs.existsSync(plist), false);
  assert.deepEqual(launchctlCalls(calls), [["bootout", "gui/501/com.agentshell.dashboard"]]);
});

test("setupCodex reports and rolls back a Dashboard service bootstrap failure", async () => {
  const fixture = makeFixture();
  const result = await setupCodex("install", {
    ...fixture,
    uid: 501,
    allowUserServiceManagement: true,
    runCommand: async (command, args) => ({
      ok: !(command === "launchctl" && args[0] === "bootstrap"),
      status: command === "launchctl" && args[0] === "bootstrap" ? 5 : 0
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "DASHBOARD_SERVICE_FAILED");
  assert.equal(result.dashboardService.status, "bootstrap-failed");
  assert.equal(fs.existsSync(path.join(fixture.home, ".local", "bin", "agentshell")), false);
  assert.equal(fs.existsSync(path.join(fixture.home, ".agentshell", "standalone-install.json")), false);
});

test("setupCodex preserves installation state when Dashboard service bootout fails", async () => {
  const fixture = makeFixture();
  const base = { ...fixture, uid: 501, allowUserServiceManagement: true };
  assert.equal((await setupCodex("install", { ...base, runCommand: successfulRunner([]) })).ok, true);
  const installedCli = path.join(fixture.home, ".local", "bin", "agentshell");
  const record = path.join(fixture.home, ".agentshell", "standalone-install.json");

  const result = await setupCodex("uninstall", {
    ...base,
    runCommand: async (command, args) => ({
      ok: command !== "launchctl" || args[0] === "print",
      status: command === "launchctl" && args[0] !== "print" ? 5 : 0
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "DASHBOARD_SERVICE_STOP_FAILED");
  assert.equal(fs.existsSync(installedCli), true);
  assert.equal(fs.existsSync(record), true);
  assert.equal(fs.existsSync(path.join(fixture.home, "plugins", "agentshell")), true);
});

test("setupCodex returns a compact error for unsupported actions", async () => {
  const result = await setupCodex("rollback", {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_ACTION");
});

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-setup-codex-"));
  const source = path.join(root, "source");
  const home = path.join(root, "home");
  const platform = "darwin";
  const arch = "arm64";
  fs.mkdirSync(path.join(source, ".codex-plugin"), { recursive: true });
  fs.mkdirSync(path.join(source, "bin"), { recursive: true });
  fs.writeFileSync(path.join(source, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "agentshell", version: "1.0.0" }));
  fs.writeFileSync(path.join(source, "bin", "agentshell"), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(source, "bin", `agentshell-${platform}-${arch}`), "native-cli", { mode: 0o755 });
  return { home, source, platform, arch, env: { SHELL: "/bin/zsh", PATH: "/usr/bin" } };
}

function successfulRunner(calls) {
  return async (command, args, options) => {
    calls.push({ command, args, options });
    return { ok: true, status: 0, stdout: "sensitive output must not leak" };
  };
}

function launchctlCalls(calls) {
  return calls.filter(({ command }) => command === "launchctl").map(({ args }) => args);
}

function hash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
