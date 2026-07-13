import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  assert.equal(entries[0].root, path.resolve(root));
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

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
