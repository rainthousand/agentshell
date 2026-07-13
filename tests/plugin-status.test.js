import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { pluginStatus } from "../src/commands/plugin-status.js";

const SOURCE_ROOT = path.resolve(import.meta.dirname, "..");

test("plugin status resolves the CLI package independently of cwd", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-plugin-status-cwd-"));
  const arbitraryProject = path.join(base, "unrelated-project");
  const home = path.join(base, "home");
  const manifest = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, ".codex-plugin", "plugin.json"), "utf8"));
  const cacheRoot = path.join(home, ".codex", "plugins", "cache", "personal", "agentshell");
  fs.mkdirSync(arbitraryProject, { recursive: true });
  writeMarketplace(home);
  writeManifest(path.join(cacheRoot, manifest.version), manifest);

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
  writeManifest(packageRoot, manifest);
  writeManifest(path.join(cacheRoot, manifest.version), manifest);
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
