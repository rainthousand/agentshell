import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { doctor, installOrUpdate, rollback, uninstall } from "../scripts/plugin-lifecycle.js";

test("plugin lifecycle installs, updates, diagnoses, rolls back, and uninstalls", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-lifecycle-"));
  const installed = installOrUpdate({ home });
  assert.equal(installed.ok, true);
  assert.equal(installed.action, "install");
  assert.equal(doctor({ home }).ok, false, "policy and cache are installed by the outer lifecycle");

  const marker = path.join(home, "plugins", "agentshell", "test-marker.txt");
  fs.writeFileSync(marker, "old install");
  const updated = installOrUpdate({ home });
  assert.equal(updated.ok, true);
  assert.equal(updated.action, "update");
  assert.equal(fs.existsSync(marker), false);

  const restored = rollback({ home });
  assert.equal(restored.rolledBack, true);
  assert.equal(fs.readFileSync(marker, "utf8"), "old install");

  const removed = uninstall({ home });
  assert.equal(removed.ok, true);
  assert.equal(fs.existsSync(path.join(home, "plugins", "agentshell")), false);
  const marketplace = JSON.parse(fs.readFileSync(path.join(home, ".agents", "plugins", "marketplace.json"), "utf8"));
  assert.equal(marketplace.plugins.some((plugin) => plugin.name === "agentshell"), false);
});

test("plugin lifecycle restores the previous install after a post-swap failure", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-lifecycle-failure-"));
  assert.equal(installOrUpdate({ home }).ok, true);
  const marker = path.join(home, "plugins", "agentshell", "keep.txt");
  fs.writeFileSync(marker, "keep me");
  const failed = installOrUpdate({ home, failAfterSwap: true });
  assert.equal(failed.ok, false);
  assert.equal(failed.rolledBack, true);
  assert.equal(fs.readFileSync(marker, "utf8"), "keep me");
});
