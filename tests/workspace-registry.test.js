import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  readRegisteredWorkspaces,
  registerWorkspace,
  registryPath
} from "../src/core/workspace-registry.js";

test("registerWorkspace creates a private atomic registry with a stable id", () => {
  const homeDir = temporaryDirectory("agentshell-registry-home-");
  const root = temporaryDirectory("agentshell-registry-project-");

  const first = registerWorkspace(root, { homeDir });
  const second = registerWorkspace(path.join(root, "."), { homeDir });
  const entries = readRegisteredWorkspaces({ homeDir });
  const file = registryPath({ homeDir });

  assert.equal(entries.length, 1);
  assert.equal(first.id, second.id);
  assert.match(first.id, /^ws_[a-f0-9]{16}$/);
  assert.equal(entries[0].root, fs.realpathSync(root));
  assert.equal(entries[0].name, path.basename(root));
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp")),
    []
  );
});

test("registerWorkspace deduplicates resolved roots and refreshes lastSeenAt", async () => {
  const homeDir = temporaryDirectory("agentshell-registry-home-");
  const root = temporaryDirectory("agentshell-registry-project-");
  const first = registerWorkspace(root, { homeDir });

  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = registerWorkspace(path.join(root, "nested", ".."), { homeDir });
  const entries = readRegisteredWorkspaces({ homeDir });

  assert.equal(entries.length, 1);
  assert.equal(second.id, first.id);
  assert.ok(Date.parse(second.lastSeenAt) >= Date.parse(first.lastSeenAt));
  assert.equal(entries[0].lastSeenAt, second.lastSeenAt);
});

test("readRegisteredWorkspaces recovers from corrupt JSON", () => {
  const homeDir = temporaryDirectory("agentshell-registry-home-");
  const file = registryPath({ homeDir });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{not-json");

  assert.deepEqual(readRegisteredWorkspaces({ homeDir }), []);
  assert.doesNotThrow(() => registerWorkspace(temporaryDirectory("agentshell-registry-project-"), { homeDir }));
  assert.equal(readRegisteredWorkspaces({ homeDir }).length, 1);
});

test("readRegisteredWorkspaces prunes malformed and duplicate entries", () => {
  const homeDir = temporaryDirectory("agentshell-registry-home-");
  const root = temporaryDirectory("agentshell-registry-project-");
  const valid = registerWorkspace(root, { homeDir });
  const file = registryPath({ homeDir });
  fs.writeFileSync(file, `${JSON.stringify({
    version: 1,
    workspaces: [
      valid,
      { ...valid, id: "wrong" },
      { root: "relative", lastSeenAt: valid.lastSeenAt },
      { root: path.resolve(root, "other"), lastSeenAt: "invalid" },
      null
    ]
  })}\n`);

  const entries = readRegisteredWorkspaces({ homeDir, includeMissing: true });
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));

  assert.deepEqual(entries, [valid]);
  assert.deepEqual(persisted.workspaces, [valid]);
});

test("missing workspaces are hidden by default and retained on request", () => {
  const homeDir = temporaryDirectory("agentshell-registry-home-");
  const parent = temporaryDirectory("agentshell-registry-parent-");
  const root = path.join(parent, "removed-project");
  fs.mkdirSync(root);
  const registered = registerWorkspace(root, { homeDir });
  fs.rmSync(root, { recursive: true });

  assert.deepEqual(readRegisteredWorkspaces({ homeDir }), []);
  assert.deepEqual(readRegisteredWorkspaces({ homeDir, includeMissing: true }), [registered]);
});

test("managed plugin roots are never registered as user workspaces", () => {
  const homeDir = temporaryDirectory("agentshell-registry-home-");
  const managedRoot = path.join(homeDir, "plugins", "agentshell");
  const cacheRoot = path.join(homeDir, ".codex", "plugins", "cache", "personal", "agentshell", "1.0.0");
  fs.mkdirSync(managedRoot, { recursive: true });
  fs.mkdirSync(cacheRoot, { recursive: true });

  assert.equal(registerWorkspace(managedRoot, { homeDir }).ignored, true);
  assert.equal(registerWorkspace(cacheRoot, { homeDir }).ignored, true);
  assert.deepEqual(readRegisteredWorkspaces({ homeDir }), []);
  assert.equal(fs.existsSync(registryPath({ homeDir })), false);
});

test("registerWorkspace canonicalizes symlink aliases to one real workspace", () => {
  const homeDir = temporaryDirectory("agentshell-registry-home-");
  const root = temporaryDirectory("agentshell-registry-project-");
  const aliasParent = temporaryDirectory("agentshell-registry-alias-");
  const alias = path.join(aliasParent, "project");
  fs.symlinkSync(root, alias);

  const direct = registerWorkspace(root, { homeDir });
  const linked = registerWorkspace(alias, { homeDir });
  const entries = readRegisteredWorkspaces({ homeDir });

  assert.equal(direct.id, linked.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].root, fs.realpathSync(root));
});

test("concurrent processes do not lose workspace registrations", async () => {
  const homeDir = temporaryDirectory("agentshell-registry-home-");
  const roots = Array.from({ length: 16 }, () => temporaryDirectory("agentshell-registry-project-"));
  const moduleUrl = new URL("../src/core/workspace-registry.js", import.meta.url).href;
  const source = `import { registerWorkspace } from ${JSON.stringify(moduleUrl)}; registerWorkspace(process.argv[1], { homeDir: process.argv[2] });`;

  await Promise.all(roots.map((root) => runNode(source, [root, homeDir])));
  const entries = readRegisteredWorkspaces({ homeDir });

  assert.equal(entries.length, roots.length);
  assert.deepEqual(new Set(entries.map((entry) => entry.root)), new Set(roots.map((root) => fs.realpathSync(root))));
  assert.equal(fs.existsSync(`${registryPath({ homeDir })}.lock`), false);
});

function runNode(source, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source, ...args], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
  });
}

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
