import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DASHBOARD_SERVICE_LABEL,
  inspectDashboardService,
  installDashboardService,
  removeDashboardService
} from "../src/core/dashboard-service.js";

test("macOS install atomically writes the plist and starts the dashboard in order", async (t) => {
  const paths = fixturePaths(t);
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push([command, ...args]);
    assert.equal(fs.existsSync(plistPath(paths)), true);
    assert.deepEqual(
      fs.readdirSync(path.dirname(plistPath(paths))).filter((name) => name.endsWith(".tmp")),
      []
    );
    return { status: 0 };
  };

  const result = await installDashboardService(paths, macOptions({ runCommand }));

  assert.equal(result.ok, true);
  assert.equal(result.status, "running");
  assert.deepEqual(calls, [
    ["launchctl", "bootout", `gui/501/${DASHBOARD_SERVICE_LABEL}`],
    ["launchctl", "bootstrap", "gui/501", plistPath(paths)],
    ["launchctl", "print", `gui/501/${DASHBOARD_SERVICE_LABEL}`]
  ]);

  const plist = fs.readFileSync(plistPath(paths), "utf8");
  assert.match(plist, new RegExp(`<string>${DASHBOARD_SERVICE_LABEL}</string>`));
  assert.match(plist, new RegExp(`<string>${escapeRegExp(path.resolve(paths.installedCli))}</string>`));
  assert.match(plist, /<key>AGENTSHELL_PACKAGE_ROOT<\/key>\s*<string>[^<]+<\/string>/);
  assert.match(plist, new RegExp(`<string>${escapeRegExp(path.resolve(paths.pluginTarget))}</string>`));
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.equal(result.record.label, DASHBOARD_SERVICE_LABEL);
  assert.equal(result.record.path, plistPath(paths));
  assert.equal(result.record.sha256, sha256(plist));
});

test("doctor inspects the launchd target with print", async (t) => {
  const paths = fixturePaths(t);
  const installed = await installDashboardService(paths, macOptions({ runCommand: successfulCommand }));
  const calls = [];

  const result = await inspectDashboardService(paths, installed.record, macOptions({
    runCommand: async (command, args) => {
      calls.push([command, ...args]);
      return { status: 0 };
    }
  }));

  assert.equal(result.ok, true);
  assert.equal(result.status, "running");
  assert.equal(result.managed, true);
  assert.equal(result.loaded, true);
  assert.deepEqual(calls, [["launchctl", "print", `gui/501/${DASHBOARD_SERVICE_LABEL}`]]);
});

test("uninstall removes only a plist matching the managed hash", async (t) => {
  const paths = fixturePaths(t);
  const installed = await installDashboardService(paths, macOptions({ runCommand: successfulCommand }));
  const calls = [];

  const result = await removeDashboardService(paths, installed.record, macOptions({
    runCommand: async (command, args) => {
      calls.push([command, ...args]);
      return { status: 0 };
    }
  }));

  assert.equal(result.status, "removed");
  assert.equal(fs.existsSync(plistPath(paths)), false);
  assert.deepEqual(calls, [["launchctl", "bootout", `gui/501/${DASHBOARD_SERVICE_LABEL}`]]);
});

test("uninstall stops the known label but preserves a user-modified plist", async (t) => {
  const paths = fixturePaths(t);
  const installed = await installDashboardService(paths, macOptions({ runCommand: successfulCommand }));
  fs.appendFileSync(plistPath(paths), "<!-- user setting -->\n");
  let commandCount = 0;

  const result = await removeDashboardService(paths, installed.record, macOptions({
    runCommand: async () => {
      commandCount += 1;
      return { status: 0 };
    }
  }));

  assert.equal(result.ok, true);
  assert.equal(result.status, "preserved-modified");
  assert.equal(commandCount, 1);
  assert.match(fs.readFileSync(plistPath(paths), "utf8"), /user setting/);
});

test("update preserves a user-modified plist without stopping its service", async (t) => {
  const paths = fixturePaths(t);
  const installed = await installDashboardService(paths, macOptions({ runCommand: successfulCommand }));
  fs.appendFileSync(plistPath(paths), "<!-- user setting -->\n");
  let commandCount = 0;

  const result = await installDashboardService(paths, macOptions({
    record: installed.record,
    runCommand: async () => {
      commandCount += 1;
      return { status: 0 };
    }
  }));

  assert.equal(result.ok, false);
  assert.equal(result.status, "preserved-modified");
  assert.equal(commandCount, 0);
  assert.match(fs.readFileSync(plistPath(paths), "utf8"), /user setting/);
});

test("uninstall preserves all files when launchctl cannot stop a loaded service", async (t) => {
  const paths = fixturePaths(t);
  const installed = await installDashboardService(paths, macOptions({ runCommand: successfulCommand }));
  const calls = [];
  const result = await removeDashboardService(paths, installed.record, macOptions({
    runCommand: async (command, args) => {
      calls.push([command, ...args]);
      return { status: args[0] === "print" ? 0 : 5 };
    }
  }));

  assert.equal(result.ok, false);
  assert.equal(result.status, "bootout-failed");
  assert.equal(fs.existsSync(plistPath(paths)), true);
  assert.deepEqual(calls, [
    ["launchctl", "bootout", `gui/501/${DASHBOARD_SERVICE_LABEL}`],
    ["launchctl", "print", `gui/501/${DASHBOARD_SERVICE_LABEL}`]
  ]);
});

test("service management skips disabled and non-macOS contexts", async (t) => {
  const paths = fixturePaths(t);
  let commandCount = 0;
  const runCommand = async () => {
    commandCount += 1;
    return { status: 0 };
  };

  const disabled = await installDashboardService(paths, { platform: "darwin", enabled: false, runCommand });
  const nonMac = await installDashboardService(paths, { platform: "linux", enabled: true, runCommand });

  assert.equal(disabled.status, "skipped");
  assert.equal(nonMac.status, "skipped");
  assert.equal(commandCount, 0);
  assert.equal(fs.existsSync(plistPath(paths)), false);
});

test("bootstrap failure restores the previous managed plist", async (t) => {
  const paths = fixturePaths(t);
  const plist = plistPath(paths);
  const previous = "previous user-approved plist\n";
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, previous);
  const record = { label: DASHBOARD_SERVICE_LABEL, path: plist, sha256: sha256(previous) };
  const calls = [];

  const result = await installDashboardService(paths, macOptions({
    record,
    runCommand: async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "bootstrap" && calls.length === 2) return { status: 5 };
      return { status: 0 };
    }
  }));

  assert.equal(result.ok, false);
  assert.equal(result.status, "bootstrap-failed");
  assert.equal(fs.readFileSync(plist, "utf8"), previous);
  assert.deepEqual(calls, [
    ["launchctl", "bootout", `gui/501/${DASHBOARD_SERVICE_LABEL}`],
    ["launchctl", "bootstrap", "gui/501", plist],
    ["launchctl", "bootstrap", "gui/501", plist]
  ]);
});

function fixturePaths(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-dashboard-service-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    home: path.join(root, "home"),
    installedCli: path.join(root, "installed", "bin", "agentshell"),
    pluginTarget: path.join(root, "plugin")
  };
}

function plistPath(paths) {
  return path.join(paths.home, "Library", "LaunchAgents", `${DASHBOARD_SERVICE_LABEL}.plist`);
}

function macOptions(options = {}) {
  return { platform: "darwin", enabled: true, uid: 501, bootoutSettleMs: 0, ...options };
}

async function successfulCommand() {
  return { status: 0 };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
