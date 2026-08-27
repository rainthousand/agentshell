import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { pluginValidate } from "../src/commands/plugin-validate.js";
import { DEFAULT_PLUGIN_CONTENT_PATHS } from "../src/core/plugin-content-hash.js";

const SOURCE_ROOT = path.resolve(import.meta.dirname, "..");

test("plugin validate exposes matching source and installed content evidence", async () => {
  const fixture = installSourceFixture();

  const output = await pluginValidate(SOURCE_ROOT, {
    home: fixture.home,
    marketplace: fixture.marketplace,
    cacheRoot: fixture.cacheRoot,
    compact: true
  });

  assert.equal(output.pluginStatus.ok, true);
  assert.equal(output.pluginStatus.integrity.matches, true);
  assert.equal(output.pluginStatus.activation.ok, true);
  assert.match(output.pluginStatus.integrity.source.hash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(output.pluginStatus.integrity.source.hash, output.pluginStatus.integrity.installed.hash);
});

test("plugin validate blocks same-version installed content drift", async () => {
  const fixture = installSourceFixture();
  fs.appendFileSync(path.join(fixture.cachePath, "skills", "agentshell", "SKILL.md"), "\nstale installed content\n");

  const output = await pluginValidate(SOURCE_ROOT, {
    home: fixture.home,
    marketplace: fixture.marketplace,
    cacheRoot: fixture.cacheRoot,
    compact: true
  });

  assert.equal(output.ok, false);
  assert.equal(output.pluginStatus.integrity.matches, false);
  assert(output.suggestedNextActions.some((action) => action.includes("plugin:cachebust")));
});

function installSourceFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-plugin-validate-integrity-"));
  const manifest = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, ".codex-plugin", "plugin.json"), "utf8"));
  const cacheRoot = path.join(home, ".codex", "plugins", "cache", "personal", "agentshell");
  const cachePath = path.join(cacheRoot, manifest.version);
  const marketplace = path.join(home, ".agents", "plugins", "marketplace.json");
  copyPluginContent(SOURCE_ROOT, cachePath);
  fs.mkdirSync(path.dirname(marketplace), { recursive: true });
  fs.writeFileSync(marketplace, `${JSON.stringify({
    name: "personal",
    plugins: [{
      name: "agentshell",
      source: { source: "local", path: "./plugins/agentshell" },
      policy: { installation: "AVAILABLE" }
    }]
  })}\n`);
  return { home, marketplace, cacheRoot, cachePath };
}

function copyPluginContent(source, target) {
  for (const relativePath of DEFAULT_PLUGIN_CONTENT_PATHS) {
    const from = path.join(source, relativePath);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(path.join(target, relativePath)), { recursive: true });
    fs.cpSync(from, path.join(target, relativePath), { recursive: true, preserveTimestamps: true });
  }
}
