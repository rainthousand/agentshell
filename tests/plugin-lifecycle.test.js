import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { doctor, installOrUpdate, migrateLegacyDashboardJob, rollback, uninstall } from "../scripts/plugin-lifecycle.js";

test("plugin lifecycle installs, updates, diagnoses, rolls back, and uninstalls", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-lifecycle-"));
  const options = { home, platform: "linux" };
  const installed = installOrUpdate(options);
  assert.equal(installed.ok, true);
  assert.equal(installed.action, "install");
  assert.equal(doctor({ home }).ok, false, "policy and cache are installed by the outer lifecycle");

  const marker = path.join(home, "plugins", "agentshell", "test-marker.txt");
  fs.writeFileSync(marker, "old install");
  const updated = installOrUpdate(options);
  assert.equal(updated.ok, true);
  assert.equal(updated.action, "update");
  assert.equal(fs.existsSync(marker), false);

  const restored = rollback({ home });
  assert.equal(restored.rolledBack, true);
  assert.equal(fs.readFileSync(marker, "utf8"), "old install");

  const removed = uninstall(options);
  assert.equal(removed.ok, true);
  assert.equal(fs.existsSync(path.join(home, "plugins", "agentshell")), false);
  const marketplace = JSON.parse(fs.readFileSync(path.join(home, ".agents", "plugins", "marketplace.json"), "utf8"));
  assert.equal(marketplace.plugins.some((plugin) => plugin.name === "agentshell"), false);
});

test("plugin lifecycle restores the previous install after a post-swap failure", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-lifecycle-failure-"));
  const options = { home, platform: "linux" };
  assert.equal(installOrUpdate(options).ok, true);
  const marker = path.join(home, "plugins", "agentshell", "keep.txt");
  fs.writeFileSync(marker, "keep me");
  const failed = installOrUpdate({ ...options, failAfterSwap: true });
  assert.equal(failed.ok, false);
  assert.equal(failed.rolledBack, true);
  assert.equal(fs.readFileSync(marker, "utf8"), "keep me");
});

test("plugin lifecycle removes the exact legacy dashboard job during install, update, and uninstall", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-lifecycle-migration-"));
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    return { status: 0 };
  };
  const options = { home, platform: "darwin", uid: 501, runner, allowUserServiceMigration: true };

  for (const result of [installOrUpdate(options), installOrUpdate(options), uninstall(options)]) {
    assert.deepEqual(result.legacyDashboardMigration, {
      label: "dev.agentshell.dashboard",
      attempted: true,
      removed: true,
      status: "removed"
    });
  }
  assert.deepEqual(calls, Array.from({ length: 3 }, () => [
    ["launchctl", "print", "gui/501/dev.agentshell.dashboard"],
    ["launchctl", "remove", "dev.agentshell.dashboard"]
  ]).flat());
});

test("legacy dashboard migration is inert for non-macOS and dry runs", () => {
  const runner = () => assert.fail("launchctl must not run");

  assert.deepEqual(migrateLegacyDashboardJob({ platform: "linux", runner }), {
    label: "dev.agentshell.dashboard",
    attempted: false,
    removed: false,
    status: "skipped",
    reason: "not-macos"
  });
  assert.equal(migrateLegacyDashboardJob({ platform: "darwin", dryRun: true, runner }).status, "dry-run");
  assert.equal(migrateLegacyDashboardJob({
    home: fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-isolated-home-")),
    platform: "darwin",
    runner
  }).reason, "isolated-home");
});

test("legacy dashboard migration safely reports missing launchctl and unloaded jobs", () => {
  const missing = migrateLegacyDashboardJob({
    platform: "darwin",
    allowUserServiceMigration: true,
    runner: () => ({ status: null, error: { code: "ENOENT" } })
  });
  assert.equal(missing.status, "command-unavailable");
  assert.equal(missing.attempted, false);

  const calls = [];
  const unloaded = migrateLegacyDashboardJob({
    platform: "darwin",
    allowUserServiceMigration: true,
    uid: 501,
    runner: (command, args) => {
      calls.push([command, ...args]);
      return { status: 113 };
    }
  });
  assert.equal(unloaded.status, "not-loaded");
  assert.equal(unloaded.attempted, false);
  assert.deepEqual(calls, [["launchctl", "print", "gui/501/dev.agentshell.dashboard"]]);
});

test("legacy dashboard migration removes only an AgentShell-owned unloaded plist", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-legacy-plist-"));
  const launchAgents = path.join(home, "Library", "LaunchAgents");
  const plist = path.join(launchAgents, "dev.agentshell.dashboard.plist");
  fs.mkdirSync(launchAgents, { recursive: true });
  fs.writeFileSync(plist, "<string>dev.agentshell.dashboard</string><string>agentshell dashboard</string>");

  const result = migrateLegacyDashboardJob({
    home,
    platform: "darwin",
    allowUserServiceMigration: true,
    runner: () => ({ status: 113 })
  });
  assert.equal(result.status, "not-loaded");
  assert.equal(result.plistRemoved, true);
  assert.equal(fs.existsSync(plist), false);

  fs.writeFileSync(plist, "<string>dev.agentshell.dashboard</string><string>user-command</string>");
  const preserved = migrateLegacyDashboardJob({
    home,
    platform: "darwin",
    allowUserServiceMigration: true,
    runner: () => ({ status: 113 })
  });
  assert.equal("plistRemoved" in preserved, false);
  assert.equal(fs.existsSync(plist), true);
});

test("legacy dashboard cleanup failure is reported without failing uninstall", () => {
  let call = 0;
  const result = uninstall({
    home: fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-lifecycle-remove-failure-")),
    platform: "darwin",
    allowUserServiceMigration: true,
    runner: () => ({ status: call++ === 0 ? 0 : 5 })
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.legacyDashboardMigration, {
    label: "dev.agentshell.dashboard",
    attempted: true,
    removed: false,
    status: "remove-failed",
    exitCode: 5
  });
});
