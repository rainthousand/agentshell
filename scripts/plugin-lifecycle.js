#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PLUGIN_NAME = "agentshell";
const LEGACY_DASHBOARD_LABEL = "dev.agentshell.dashboard";
const IGNORED = new Set([".git", ".agentshell", "artifacts", "node_modules", ".DS_Store"]);

export function installOrUpdate(options = {}) {
  const paths = lifecyclePaths(options);
  const action = fs.existsSync(paths.target) ? "update" : "install";
  const legacyDashboardMigration = migrateLegacyDashboardJob(options);
  if (options.dryRun) {
    return report(true, action, paths, {
      dryRun: true,
      rollbackAvailable: fs.existsSync(paths.target),
      legacyDashboardMigration
    });
  }

  fs.mkdirSync(paths.backups, { recursive: true });
  fs.rmSync(paths.staging, { recursive: true, force: true });
  copyDir(paths.source, paths.staging);
  validateStaging(paths.staging);

  const backup = fs.existsSync(paths.target) ? path.join(paths.backups, `plugin-${timestamp()}`) : null;
  const marketplaceBefore = fs.existsSync(paths.marketplace) ? fs.readFileSync(paths.marketplace) : null;
  try {
    if (backup) {
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.renameSync(paths.target, backup);
    }
    fs.mkdirSync(path.dirname(paths.target), { recursive: true });
    fs.renameSync(paths.staging, paths.target);
    if (options.failAfterSwap) throw new Error("simulated post-swap failure");
    upsertMarketplace(paths.marketplace, marketplaceEntry());
    writeJsonAtomic(paths.transaction, {
      action,
      backup,
      marketplaceBackup: saveMarketplaceBackup(paths, marketplaceBefore),
      createdAt: new Date().toISOString()
    });
    pruneBackups(paths.backups, 3);
    return report(true, action, paths, { backup, rollbackAvailable: Boolean(backup), legacyDashboardMigration });
  } catch (error) {
    fs.rmSync(paths.staging, { recursive: true, force: true });
    fs.rmSync(paths.target, { recursive: true, force: true });
    if (backup && fs.existsSync(backup)) fs.renameSync(backup, paths.target);
    restoreFile(paths.marketplace, marketplaceBefore);
    return report(false, action, paths, { rolledBack: true, error: error.message, legacyDashboardMigration });
  }
}

export function rollback(options = {}) {
  const paths = lifecyclePaths(options);
  const transaction = readJson(paths.transaction);
  if (!transaction) return report(true, "rollback", paths, { rolledBack: false, reason: "no-transaction" });
  fs.rmSync(paths.target, { recursive: true, force: true });
  if (transaction.backup && fs.existsSync(transaction.backup)) fs.renameSync(transaction.backup, paths.target);
  const marketplaceBefore = transaction.marketplaceBackup && fs.existsSync(transaction.marketplaceBackup)
    ? fs.readFileSync(transaction.marketplaceBackup)
    : null;
  restoreFile(paths.marketplace, marketplaceBefore);
  fs.rmSync(paths.cacheRoot, { recursive: true, force: true });
  fs.rmSync(paths.transaction, { force: true });
  return report(true, "rollback", paths, { rolledBack: true });
}

export function uninstall(options = {}) {
  const paths = lifecyclePaths(options);
  const installed = fs.existsSync(paths.target);
  const legacyDashboardMigration = migrateLegacyDashboardJob(options);
  if (options.dryRun) {
    return report(true, "uninstall", paths, { dryRun: true, installed, legacyDashboardMigration });
  }
  fs.rmSync(paths.target, { recursive: true, force: true });
  fs.rmSync(paths.cacheRoot, { recursive: true, force: true });
  removeMarketplaceEntry(paths.marketplace);
  removePolicyBlock(paths.policy);
  return report(true, "uninstall", paths, { installed, removedPolicy: true, legacyDashboardMigration });
}

export function migrateLegacyDashboardJob(options = {}) {
  const base = {
    label: LEGACY_DASHBOARD_LABEL,
    attempted: false,
    removed: false
  };
  const platform = options.platform || process.platform;
  if (platform !== "darwin") return { ...base, status: "skipped", reason: "not-macos" };
  if (options.dryRun) return { ...base, status: "dry-run" };
  if (options.home !== undefined && options.allowUserServiceMigration !== true) {
    return { ...base, status: "skipped", reason: "isolated-home" };
  }

  const legacyPlist = path.join(path.resolve(options.home || os.homedir()), "Library", "LaunchAgents", `${LEGACY_DASHBOARD_LABEL}.plist`);
  const plistRemoved = removeOwnedLegacyDashboardPlist(legacyPlist, options.dryRun);

  const runner = options.runner || defaultRunner;
  const inspected = runLaunchctl(runner, ["print", `gui/${resolveUid(options)}/${LEGACY_DASHBOARD_LABEL}`]);
  if (inspected.unavailable) return { ...base, status: "command-unavailable" };
  if (inspected.status !== 0) return { ...base, status: "not-loaded", ...(plistRemoved ? { plistRemoved: true } : {}) };

  const removed = runLaunchctl(runner, ["remove", LEGACY_DASHBOARD_LABEL]);
  if (removed.unavailable) return { ...base, attempted: true, status: "command-unavailable" };
  return {
    ...base,
    attempted: true,
    removed: removed.status === 0,
    status: removed.status === 0 ? "removed" : "remove-failed",
    ...(removed.status === 0 ? {} : { exitCode: removed.status }),
    ...(plistRemoved ? { plistRemoved: true } : {})
  };
}

function removeOwnedLegacyDashboardPlist(file, dryRun) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const values = [...text.matchAll(/<string>([^<]+)<\/string>/gu)].map((match) => match[1]);
    const ownedCommand = values.some((value) => value !== LEGACY_DASHBOARD_LABEL && /agentshell|dashboard/i.test(value));
    if (!values.includes(LEGACY_DASHBOARD_LABEL) || !ownedCommand) return false;
    if (!dryRun) fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function doctor(options = {}) {
  const paths = lifecyclePaths(options);
  const manifest = readJson(path.join(paths.target, ".codex-plugin", "plugin.json"));
  const marketplace = readJson(paths.marketplace);
  const entry = marketplace?.plugins?.find((plugin) => plugin.name === PLUGIN_NAME);
  const checks = {
    pluginFiles: Boolean(manifest?.name === PLUGIN_NAME),
    marketplaceEntry: Boolean(entry?.source?.path === `./plugins/${PLUGIN_NAME}`),
    executable: executable(path.join(paths.target, "bin", "agentshell")),
    policy: fs.existsSync(paths.policy) && fs.readFileSync(paths.policy, "utf8").includes("<!-- agentshell-policy:start -->")
  };
  return report(Object.values(checks).every(Boolean), "doctor", paths, { checks, version: manifest?.version || null });
}

function lifecyclePaths(options) {
  const home = path.resolve(options.home || os.homedir());
  const source = path.resolve(options.source || process.cwd());
  return {
    home,
    source,
    target: path.join(home, "plugins", PLUGIN_NAME),
    staging: path.join(home, "plugins", `.${PLUGIN_NAME}.staging-${process.pid}`),
    marketplace: path.join(home, ".agents", "plugins", "marketplace.json"),
    cacheRoot: path.join(home, ".codex", "plugins", "cache", "personal", PLUGIN_NAME),
    policy: path.join(home, ".codex", "AGENTS.md"),
    backups: path.join(home, ".agentshell", "backups"),
    transaction: path.join(home, ".agentshell", "last-install.json")
  };
}

function saveMarketplaceBackup(paths, content) {
  if (content === null) return null;
  const file = path.join(paths.backups, `marketplace-${timestamp()}.json`);
  fs.writeFileSync(file, content);
  return file;
}

function marketplaceEntry() {
  return {
    name: PLUGIN_NAME,
    source: { source: "local", path: `./plugins/${PLUGIN_NAME}` },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Productivity"
  };
}

function upsertMarketplace(file, entry) {
  const marketplace = readJson(file) || { name: "personal", interface: { displayName: "Personal" }, plugins: [] };
  if (!marketplace.interface) marketplace.interface = { displayName: "Personal" };
  if (!Array.isArray(marketplace.plugins)) marketplace.plugins = [];
  marketplace.plugins = marketplace.plugins.filter((plugin) => plugin.name !== entry.name);
  marketplace.plugins.push(entry);
  writeJsonAtomic(file, marketplace);
}

function removeMarketplaceEntry(file) {
  const marketplace = readJson(file);
  if (!marketplace || !Array.isArray(marketplace.plugins)) return;
  marketplace.plugins = marketplace.plugins.filter((plugin) => plugin.name !== PLUGIN_NAME);
  writeJsonAtomic(file, marketplace);
}

function removePolicyBlock(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  const next = text.replace(/\n?<!-- agentshell-policy:start -->[\s\S]*?<!-- agentshell-policy:end -->\n?/u, "\n").replace(/^\s+|\s+$/gu, "");
  if (next) fs.writeFileSync(file, `${next}\n`);
  else fs.rmSync(file, { force: true });
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else if (entry.isFile()) {
      fs.copyFileSync(source, target);
      fs.chmodSync(target, fs.statSync(source).mode);
    }
  }
}

function validateStaging(staging) {
  const manifest = readJson(path.join(staging, ".codex-plugin", "plugin.json"));
  if (manifest?.name !== PLUGIN_NAME || !manifest.version) throw new Error("staged plugin manifest is invalid");
  if (!executable(path.join(staging, "bin", "agentshell"))) throw new Error("staged agentshell binary is not executable");
}

function pruneBackups(dir, keep) {
  const entries = fs.readdirSync(dir).filter((name) => name.startsWith("plugin-")).sort().reverse();
  for (const name of entries.slice(keep)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
}

function restoreFile(file, content) {
  if (content === null) fs.rmSync(file, { force: true });
  else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function executable(file) {
  try { return fs.statSync(file).isFile() && (fs.statSync(file).mode & 0o111) !== 0; } catch { return false; }
}

function resolveUid(options) {
  if (options.uid !== undefined) return options.uid;
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

function runLaunchctl(runner, args) {
  try {
    const result = runner("launchctl", args, { encoding: "utf8" }) || {};
    return {
      status: Number.isInteger(result.status) ? result.status : null,
      unavailable: result.error?.code === "ENOENT"
    };
  } catch (error) {
    return { status: null, unavailable: error?.code === "ENOENT" };
  }
}

function defaultRunner(command, args, options) {
  return spawnSync(command, args, options);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "");
}

function report(ok, action, paths, extra) {
  return {
    ok,
    protocolVersion: "agentshell.plugin-lifecycle.v1",
    action,
    pluginTarget: paths.target,
    marketplacePath: paths.marketplace,
    cacheRoot: paths.cacheRoot,
    ...extra
  };
}

function parseArgs(argv) {
  const action = argv[0] || "doctor";
  if (!["install", "update", "uninstall", "doctor", "rollback"].includes(action)) throw new Error(`Unknown lifecycle action: ${action}`);
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--home" || arg === "--source") {
      if (!argv[index + 1]) throw new Error(`${arg} requires a path`);
      options[arg.slice(2)] = argv[++index];
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { action, options };
}

if (path.basename(process.argv[1] || "") === "plugin-lifecycle.js") {
  try {
    const { action, options } = parseArgs(process.argv.slice(2));
    const result = action === "uninstall"
      ? uninstall(options)
      : action === "doctor"
        ? doctor(options)
        : action === "rollback"
          ? rollback(options)
          : installOrUpdate(options);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, protocolVersion: "agentshell.plugin-lifecycle.v1", error: error.message }, null, 2));
    process.exitCode = 1;
  }
}
