import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolvePackageRoot } from "../src/core/package-root.js";

test("resolves an explicit package root and AGENTSHELL_PACKAGE_ROOT", () => {
  const base = fixtureRoot();
  const explicit = writePackage(path.join(base, "explicit"));
  const fromEnv = writePackage(path.join(base, "environment"));

  assert.equal(resolvePackageRoot({ packageRoot: explicit, env: {} }), explicit);
  assert.equal(resolvePackageRoot({ env: { AGENTSHELL_PACKAGE_ROOT: fromEnv } }), fromEnv);
});

test("rejects explicit directories whose manifest is missing or belongs to another plugin", () => {
  const base = fixtureRoot();
  const wrong = writePackage(path.join(base, "wrong"), "another-plugin");

  assert.throws(
    () => resolvePackageRoot({ packageRoot: wrong, env: {} }),
    /Invalid AgentShell package root/
  );
});

test("resolves a normal source tree before installed fallbacks", () => {
  const base = fixtureRoot();
  const source = writePackage(path.join(base, "source"));
  const installed = writePackage(path.join(base, "installed"));

  assert.equal(resolvePackageRoot({
    sourceRoot: source,
    executablePath: path.join(base, "bin", "node"),
    installedCandidates: [installed],
    env: {}
  }), source);
});

test("resolves a package adjacent to a standalone executable", () => {
  const base = fixtureRoot();
  const executableDir = path.join(base, "bundle");
  const adjacent = writePackage(path.join(executableDir, "agentshell"));

  assert.equal(resolvePackageRoot({
    sourceRoot: path.join(base, "missing-source"),
    executablePath: path.join(executableDir, "agentshell-cli"),
    installedCandidates: [],
    env: {}
  }), adjacent);
});

test("falls back to the newest valid installed Codex plugin cache", () => {
  const base = fixtureRoot();
  const older = writePackage(path.join(base, "cache", "0.24.0+codex.1"));
  const wrong = writePackage(path.join(base, "cache", "0.99.0"), "another-plugin");
  const newer = writePackage(path.join(base, "cache", "0.24.0+codex.2"));
  const oldTime = new Date("2026-01-01T00:00:00Z");
  const newTime = new Date("2026-02-01T00:00:00Z");
  fs.utimesSync(path.join(older, ".codex-plugin", "plugin.json"), oldTime, oldTime);
  fs.utimesSync(path.join(newer, ".codex-plugin", "plugin.json"), newTime, newTime);

  assert.equal(resolvePackageRoot({
    sourceRoot: path.join(base, "missing-source"),
    executablePath: path.join(base, "missing-bin", "agentshell"),
    installedCandidates: [older, wrong, newer],
    env: {}
  }), newer);
});

test("discovers versioned candidates beneath a Codex plugin cache", () => {
  const base = fixtureRoot();
  const codexHome = path.join(base, ".codex");
  const cache = path.join(codexHome, "plugins", "cache", "personal", "agentshell");
  const older = writePackage(path.join(cache, "0.24.0+codex.100"));
  const newer = writePackage(path.join(cache, "0.24.0+codex.200"));
  const oldTime = new Date("2026-03-01T00:00:00Z");
  const newTime = new Date("2026-04-01T00:00:00Z");
  fs.utimesSync(path.join(older, ".codex-plugin", "plugin.json"), oldTime, oldTime);
  fs.utimesSync(path.join(newer, ".codex-plugin", "plugin.json"), newTime, newTime);

  assert.equal(resolvePackageRoot({
    sourceRoot: path.join(base, "missing-source"),
    executablePath: path.join(base, "missing-bin", "agentshell"),
    codexHome,
    env: {}
  }), newer);
});

test("reports a useful error when no package candidate is valid", () => {
  const base = fixtureRoot();
  assert.throws(() => resolvePackageRoot({
    sourceRoot: path.join(base, "missing-source"),
    executablePath: path.join(base, "missing-bin", "agentshell"),
    installedCandidates: [],
    env: {}
  }), /AGENTSHELL_PACKAGE_ROOT/);
});

function fixtureRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-package-root-"));
}

function writePackage(root, name = "agentshell") {
  const manifest = path.join(root, ".codex-plugin", "plugin.json");
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, `${JSON.stringify({ name, version: "0.24.0+fixture" })}\n`);
  return root;
}
