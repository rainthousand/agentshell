import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { pluginStatus } from "../src/commands/plugin-status.js";
import { DEFAULT_PLUGIN_CONTENT_PATHS, pluginContentHash } from "../src/core/plugin-content-hash.js";

const SOURCE_ROOT = path.resolve(import.meta.dirname, "..");

test("plugin status resolves the CLI package independently of cwd", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-plugin-status-cwd-"));
  const arbitraryProject = path.join(base, "unrelated-project");
  const home = path.join(base, "home");
  const manifest = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, ".codex-plugin", "plugin.json"), "utf8"));
  const cacheRoot = path.join(home, ".codex", "plugins", "cache", "personal", "agentshell");
  fs.mkdirSync(arbitraryProject, { recursive: true });
  writeMarketplace(home);
  copyPluginContent(SOURCE_ROOT, path.join(cacheRoot, manifest.version));

  const result = spawnSync("node", [
    path.join(SOURCE_ROOT, "src", "cli.js"),
    "plugin",
    "status",
    "--compact",
    "--home",
    home,
    "--cache-root",
    cacheRoot
  ], {
    cwd: arbitraryProject,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.plugin.version, manifest.version);
  assert.equal(output.cachePath, path.join(cacheRoot, manifest.version));
});

test("plugin status preserves explicit package and install path overrides", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-plugin-status-overrides-"));
  const packageRoot = path.join(base, "installed-cache", "0.24.0+fixture");
  const home = path.join(base, "custom-home");
  const marketplace = path.join(base, "custom-marketplace.json");
  const cacheRoot = path.join(base, "custom-cache");
  const manifest = fixtureManifest("0.24.0+fixture");
  writeCompletePluginFixture(packageRoot, manifest);
  copyPluginContent(packageRoot, path.join(cacheRoot, manifest.version));
  writeMarketplaceFile(marketplace);

  const output = pluginStatus(path.join(base, "unrelated-project"), {
    compact: false,
    packageRoot,
    home,
    marketplace,
    cacheRoot
  });

  assert.equal(output.ok, true);
  assert.equal(output.paths.root, packageRoot);
  assert.equal(output.paths.marketplace, marketplace);
  assert.equal(output.paths.cacheRoot, cacheRoot);
  assert.equal(output.paths.cachePath, path.join(cacheRoot, manifest.version));
  assert.equal(output.integrity.matches, true);
  assert.equal(output.activation.ok, true);
});

test("plugin content hash is deterministic across roots and detects same-version drift", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-plugin-hash-"));
  const source = path.join(base, "source");
  const installed = path.join(base, "installed");
  const manifest = fixtureManifest("1.0.0+same-version");
  writeCompletePluginFixture(source, manifest);
  copyPluginContent(source, installed);

  const sourceHash = pluginContentHash(source);
  const installedHash = pluginContentHash(installed);
  assert.equal(sourceHash.hash, installedHash.hash);
  assert.deepEqual(sourceHash.missingPaths, installedHash.missingPaths);

  fs.appendFileSync(path.join(installed, "skills", "agentshell", "SKILL.md"), "drift\n");
  assert.notEqual(pluginContentHash(source).hash, pluginContentHash(installed).hash);
});

test("plugin status blocks same-version source and installed content drift", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-plugin-drift-"));
  const source = path.join(base, "source");
  const home = path.join(base, "home");
  const cacheRoot = path.join(home, ".codex", "plugins", "cache", "personal", "agentshell");
  const manifest = fixtureManifest("1.0.0+same-version");
  writeCompletePluginFixture(source, manifest);
  copyPluginContent(source, path.join(cacheRoot, manifest.version));
  writeMarketplace(home);
  fs.appendFileSync(path.join(cacheRoot, manifest.version, "skills", "agentshell", "SKILL.md"), "drift\n");

  const output = pluginStatus(source, { packageRoot: source, home, cacheRoot });

  assert.equal(output.ok, false);
  assert.equal(output.integrity.matches, false);
  assert.equal(output.plugin.version, manifest.version);
  assert(output.checks.some((check) => check.name === "codex plugin cache content matches source content" && !check.ok));
});

function fixtureManifest(version) {
  return {
    name: "agentshell",
    version,
    author: { name: "Alvin" },
    interface: { developerName: "AgentShell Labs" }
  };
}

function writeManifest(root, manifest) {
  const file = path.join(root, ".codex-plugin", "plugin.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

function writeCompletePluginFixture(root, manifest) {
  writeManifest(root, manifest);
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills", "agentshell"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"agentshell","type":"module"}\n');
  fs.writeFileSync(path.join(root, "src", "cli.js"), "// fixture cli\n");
  fs.writeFileSync(path.join(root, "skills", "agentshell", "SKILL.md"), [
    "agentshell start --compact",
    "agentshell verify test --compact",
    "agentshell grep <query> --compact",
    ""
  ].join("\n"));
  for (const name of ["agentshell", "agentshell-mcp"]) {
    const file = path.join(root, "bin", name);
    fs.writeFileSync(file, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ok:true,protocolVersion:"agentshell.manual.v1"}));\n');
    fs.chmodSync(file, 0o755);
  }
}

function copyPluginContent(source, target) {
  for (const relativePath of DEFAULT_PLUGIN_CONTENT_PATHS) {
    const from = path.join(source, relativePath);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(path.join(target, relativePath)), { recursive: true });
    fs.cpSync(from, path.join(target, relativePath), { recursive: true, preserveTimestamps: true });
  }
}

function writeMarketplace(home) {
  writeMarketplaceFile(path.join(home, ".agents", "plugins", "marketplace.json"));
}

function writeMarketplaceFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    name: "personal",
    plugins: [{
      name: "agentshell",
      source: { source: "local", path: "./plugins/agentshell" },
      policy: { installation: "AVAILABLE" }
    }]
  }, null, 2)}\n`);
}
