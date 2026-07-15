import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { setupCodex } from "../src/commands/setup-codex.js";

const PATH_BLOCK_START = "# >>> AgentShell managed PATH >>>";
const POLICY_START = "<!-- agentshell-policy:start -->";
const POLICY_END = "<!-- agentshell-policy:end -->";

test("setupCodex migrates a managed v0.24 install and later removes only managed content", async () => {
  const fixture = makeMigrationFixture();
  const runCommand = async () => ({ ok: true, status: 0 });

  const firstUpdate = await setupCodex("update", { ...fixture, runCommand });
  assert.equal(firstUpdate.ok, true);
  assert.equal(firstUpdate.plugin.status, "update");
  assert.equal(firstUpdate.commandPath.status, "profile-updated");

  const installedManifest = readJson(path.join(fixture.home, "plugins", "agentshell", ".codex-plugin", "plugin.json"));
  assert.equal(installedManifest.version, "0.25.0");
  assert.equal(fs.existsSync(path.join(fixture.home, "plugins", "agentshell", "v0.24-only.txt")), false);
  assert.equal(fs.readFileSync(fixture.installedCli, "utf8"), "v0.25-native-cli");

  let agents = fs.readFileSync(fixture.agentsFile, "utf8");
  assert.match(agents, /user instruction before/);
  assert.match(agents, /user instruction after/);
  assert.match(agents, /AgentShell Default Policy/);
  assert.doesNotMatch(agents, /v0\.24 policy/);

  const secondUpdate = await setupCodex("update", { ...fixture, runCommand });
  assert.equal(secondUpdate.ok, true);
  assert.equal(secondUpdate.commandPath.status, "profile-configured");
  const configuredProfile = fs.readFileSync(fixture.profile, "utf8");
  assert.equal(configuredProfile.match(new RegExp(PATH_BLOCK_START, "g"))?.length, 1);
  assert.match(configuredProfile, /export EDITOR=vim/);
  assert.match(configuredProfile, /export PROJECT_HOME=\$HOME\/src/);

  const removed = await setupCodex("uninstall", { ...fixture, runCommand });
  assert.equal(removed.ok, true);
  assert.equal(removed.nativeCli.status, "removed");
  assert.equal(removed.commandPath.status, "removed");
  assert.equal(fs.existsSync(fixture.installedCli), false);
  assert.equal(fs.existsSync(path.join(fixture.home, "plugins", "agentshell")), false);
  assert.equal(fs.existsSync(path.join(fixture.home, ".agentshell", "standalone-install.json")), false);
  assert.equal(fs.readFileSync(fixture.profile, "utf8"), "export EDITOR=vim\nexport PROJECT_HOME=$HOME/src");

  agents = fs.readFileSync(fixture.agentsFile, "utf8");
  assert.match(agents, /user instruction before/);
  assert.match(agents, /user instruction after/);
  assert.doesNotMatch(agents, /agentshell-policy/);

  const marketplace = readJson(path.join(fixture.home, ".agents", "plugins", "marketplace.json"));
  assert.deepEqual(marketplace.plugins.map((plugin) => plugin.name), ["user-plugin"]);
});

function makeMigrationFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-v024-migration-"));
  const source = path.join(root, "source");
  const home = path.join(root, "home");
  const platform = "darwin";
  const arch = "arm64";
  const installedPlugin = path.join(home, "plugins", "agentshell");
  const installedCli = path.join(home, ".local", "bin", "agentshell");
  const agentsFile = path.join(home, ".codex", "AGENTS.md");
  const profile = path.join(home, ".zprofile");

  writePlugin(source, "0.25.0");
  fs.writeFileSync(path.join(source, "bin", `agentshell-${platform}-${arch}`), "v0.25-native-cli", { mode: 0o755 });
  writePlugin(installedPlugin, "0.24.0");
  fs.writeFileSync(path.join(installedPlugin, "v0.24-only.txt"), "legacy");

  fs.mkdirSync(path.dirname(installedCli), { recursive: true });
  fs.writeFileSync(installedCli, "v0.24-native-cli", { mode: 0o755 });
  writeJson(path.join(home, ".agentshell", "standalone-install.json"), {
    protocolVersion: "agentshell.setup-codex.v1",
    path: installedCli,
    sha256: sha256(installedCli)
  });

  fs.mkdirSync(path.dirname(agentsFile), { recursive: true });
  fs.writeFileSync(agentsFile, [
    "user instruction before",
    "",
    POLICY_START,
    "# v0.24 policy",
    POLICY_END,
    "",
    "user instruction after",
    ""
  ].join("\n"));
  fs.writeFileSync(profile, "export EDITOR=vim\nexport PROJECT_HOME=$HOME/src");
  writeJson(path.join(home, ".agents", "plugins", "marketplace.json"), {
    name: "personal",
    plugins: [
      { name: "user-plugin", source: { source: "local", path: "./plugins/user-plugin" } },
      { name: "agentshell", source: { source: "local", path: "./plugins/agentshell" } }
    ]
  });

  return { home, source, platform, arch, installedCli, agentsFile, profile, env: { SHELL: "/bin/zsh", PATH: "/usr/bin" } };
}

function writePlugin(directory, version) {
  fs.mkdirSync(path.join(directory, ".codex-plugin"), { recursive: true });
  fs.mkdirSync(path.join(directory, "bin"), { recursive: true });
  fs.writeFileSync(path.join(directory, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "agentshell", version }));
  fs.writeFileSync(path.join(directory, "bin", "agentshell"), "#!/bin/sh\n", { mode: 0o755 });
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
