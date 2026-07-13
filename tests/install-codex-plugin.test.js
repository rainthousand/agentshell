import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("plugin install local excludes generated artifacts and preserves executable bins", () => {
  const home = mkdtempSync(join(tmpdir(), "agentshell-install-home-"));
  const result = spawnSync("node", ["scripts/install-codex-plugin.js"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const installedPath = join(home, "plugins", "agentshell");
  assert.equal(output.pluginTarget, installedPath);
  assert.equal(existsSync(installedPath), true);
  assert.equal(existsSync(join(installedPath, "artifacts")), false);
  assert.equal(existsSync(join(installedPath, ".git")), false);
  assert.equal(existsSync(join(installedPath, ".agentshell")), false);
  assert.equal(existsSync(join(installedPath, "node_modules")), false);
  assertExecutable(join(installedPath, "bin", "agentshell"));
  assertExecutable(join(installedPath, "bin", "agentshell-mcp"));

  const marketplace = JSON.parse(readFileSync(join(home, ".agents", "plugins", "marketplace.json"), "utf8"));
  assert.equal(marketplace.plugins[0].name, "agentshell");
  assert.equal(marketplace.plugins[0].source.path, "./plugins/agentshell");
});

function assertExecutable(file) {
  assert.notEqual(statSync(file).mode & 0o111, 0, `${file} is not executable`);
}
