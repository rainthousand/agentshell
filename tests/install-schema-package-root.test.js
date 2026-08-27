import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { schema } from "../src/commands/schema.js";
import { resolvePackageRoot } from "../src/core/package-root.js";

test("schema get ignores a cwd schema that impersonates AgentShell", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-schema-cwd-"));
  fs.mkdirSync(path.join(cwd, ".codex-plugin"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "schemas"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "agentshell", version: "999.0.0" }));
  fs.writeFileSync(path.join(cwd, "schemas", "start.schema.json"), JSON.stringify({ ok: false, poisoned: true }));

  const result = await schema(cwd, "get", "start");

  assert.notEqual(result.poisoned, true);
  assert.equal(result.$schema, "https://json-schema.org/draft/2020-12/schema");
});

test("managed ~/plugins/agentshell wins deterministically over newer cache mtimes", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-managed-root-"));
  const managed = writePackage(path.join(home, "plugins", "agentshell"), "1.0.0");
  const cached = writePackage(path.join(home, ".codex", "plugins", "cache", "personal", "agentshell", "9.0.0"), "9.0.0");
  const future = new Date("2040-01-01T00:00:00Z");
  fs.utimesSync(path.join(cached, ".codex-plugin", "plugin.json"), future, future);

  assert.equal(resolvePackageRoot({
    homeDir: home,
    sourceRoot: path.join(home, "missing-source"),
    executablePath: path.join(home, "missing-bin", "agentshell"),
    env: {}
  }), managed);
});

test("versioned cache selection does not depend on manifest mtime", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-version-root-"));
  const cache = path.join(home, ".codex", "plugins", "cache", "personal", "agentshell");
  const olderVersion = writePackage(path.join(cache, "1.0.0+codex.9"), "1.0.0+codex.9");
  const newerVersion = writePackage(path.join(cache, "1.0.0+codex.10"), "1.0.0+codex.10");
  const future = new Date("2040-01-01T00:00:00Z");
  const past = new Date("2020-01-01T00:00:00Z");
  fs.utimesSync(path.join(olderVersion, ".codex-plugin", "plugin.json"), future, future);
  fs.utimesSync(path.join(newerVersion, ".codex-plugin", "plugin.json"), past, past);

  assert.equal(resolvePackageRoot({
    homeDir: home,
    sourceRoot: path.join(home, "missing-source"),
    executablePath: path.join(home, "missing-bin", "agentshell"),
    env: {}
  }), newerVersion);
});

function writePackage(root, version) {
  const manifest = path.join(root, ".codex-plugin", "plugin.json");
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, `${JSON.stringify({ name: "agentshell", version })}\n`);
  return root;
}
