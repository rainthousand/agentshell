import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { setupCodex } from "../src/commands/setup-codex.js";

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
  assert.equal(fs.statSync(recordPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(recordPath)).mode & 0o777, 0o700);
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
  assert.equal(result.checks.codex, true);

  result = await setupCodex("doctor", { ...fixture, runCommand: async () => ({ ok: false, status: 127 }) });
  assert.equal(result.ok, false);
  assert.equal(result.checks.codex, false);
  assert.equal("stdout" in result.codex, false);
  assert.equal("stderr" in result.codex, false);
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
  return { home, source, platform, arch };
}

function successfulRunner(calls) {
  return async (command, args, options) => {
    calls.push({ command, args, options });
    return { ok: true, status: 0, stdout: "sensitive output must not leak" };
  };
}

function hash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
