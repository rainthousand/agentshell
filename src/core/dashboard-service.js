import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const DASHBOARD_SERVICE_LABEL = "com.agentshell.dashboard";

export async function installDashboardService(paths, options = {}) {
  const service = servicePaths(paths, options);
  if (!service.enabled) return skipped(service);
  const content = renderPlist(service);
  const record = serviceRecord(service, content);
  const existing = managedState(service, options.record);
  if (existing.exists && !existing.managed) {
    return { ok: false, status: "preserved-modified", ...publicPaths(service) };
  }
  if (options.dryRun) return { ok: true, status: "would-install", record, ...publicPaths(service) };

  const previous = readBuffer(service.plist);
  fs.mkdirSync(path.dirname(service.stdout), { recursive: true, mode: 0o700 });
  writeAtomic(service.plist, content);
  const bootout = await run(options, "launchctl", ["bootout", service.target]);
  if (bootout.ok) await delay(options.bootoutSettleMs ?? 250);
  const bootstrap = await run(options, "launchctl", ["bootstrap", service.domain, service.plist]);
  if (!bootstrap.ok) {
    restoreFile(service.plist, previous);
    const restored = previous !== null
      ? await run(options, "launchctl", ["bootstrap", service.domain, service.plist])
      : null;
    return {
      ok: false,
      status: bootstrap.unavailable ? "command-unavailable" : "bootstrap-failed",
      launchctlStatus: bootstrap.status,
      rollbackRestored: restored?.ok === true,
      ...publicPaths(service)
    };
  }
  const inspected = await run(options, "launchctl", ["print", service.target]);
  if (!inspected.ok) {
    await run(options, "launchctl", ["bootout", service.target]);
    restoreFile(service.plist, previous);
    if (previous !== null) await run(options, "launchctl", ["bootstrap", service.domain, service.plist]);
    return { ok: false, status: "load-verification-failed", launchctlStatus: inspected.status, ...publicPaths(service) };
  }
  return {
    ok: true,
    status: "running",
    record,
    ...publicPaths(service)
  };
}

export async function removeDashboardService(paths, record, options = {}) {
  const service = servicePaths(paths, options);
  if (!service.enabled) return skipped(service);
  const state = managedState(service, record);
  const stopped = options.dryRun ? { ok: true } : await stopLoadedService(service, options);
  if (!stopped.ok) {
    return { ok: false, status: "bootout-failed", ...publicPaths(service) };
  }
  if (!state.managed) {
    return {
      ok: true,
      status: state.exists ? "preserved-modified" : "not-managed",
      ...publicPaths(service)
    };
  }
  if (options.dryRun) return { ok: true, status: "would-remove", ...publicPaths(service) };
  fs.rmSync(service.plist, { force: true });
  return { ok: true, status: "removed", ...publicPaths(service) };
}

export async function inspectDashboardService(paths, record, options = {}) {
  const service = servicePaths(paths, options);
  if (!service.enabled) return skipped(service);
  const state = managedState(service, record);
  const loaded = await run(options, "launchctl", ["print", service.target]);
  return {
    ok: state.managed && loaded.ok,
    status: state.managed ? (loaded.ok ? "running" : "not-running") : state.exists ? "modified" : "missing",
    managed: state.managed,
    loaded: loaded.ok,
    ...publicPaths(service)
  };
}

export function renderDashboardServicePlist(paths, options = {}) {
  return renderPlist(servicePaths(paths, { ...options, enabled: true }));
}

function servicePaths(paths, options) {
  const enabled = options.enabled === true && (options.platform || process.platform) === "darwin";
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const home = path.resolve(paths.home);
  const label = options.label || DASHBOARD_SERVICE_LABEL;
  return {
    enabled,
    label,
    domain: `gui/${uid}`,
    target: `gui/${uid}/${label}`,
    plist: path.join(home, "Library", "LaunchAgents", `${label}.plist`),
    cli: path.resolve(paths.installedCli),
    packageRoot: path.resolve(paths.pluginTarget),
    workingDirectory: path.resolve(paths.pluginTarget),
    stdout: path.join(home, ".agentshell", "dashboard-launch.log"),
    stderr: path.join(home, ".agentshell", "dashboard-error.log")
  };
}

function renderPlist(service) {
  const args = [service.cli, "dashboard", "--menubar", "--daemon"];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>", `  <string>${xml(service.label)}</string>`,
    "  <key>ProgramArguments</key>", "  <array>",
    ...args.map((arg) => `    <string>${xml(arg)}</string>`),
    "  </array>",
    "  <key>WorkingDirectory</key>", `  <string>${xml(service.workingDirectory)}</string>`,
    "  <key>EnvironmentVariables</key>", "  <dict>",
    "    <key>AGENTSHELL_PACKAGE_ROOT</key>", `    <string>${xml(service.packageRoot)}</string>`,
    "    <key>AGENTSHELL_DASHBOARD_GLOBAL_SERVICE</key>", "    <string>1</string>",
    "  </dict>",
    "  <key>RunAtLoad</key>", "  <true/>",
    "  <key>KeepAlive</key>", "  <dict>",
    "    <key>SuccessfulExit</key>", "    <false/>",
    "  </dict>",
    "  <key>ThrottleInterval</key>", "  <integer>5</integer>",
    "  <key>ProcessType</key>", "  <string>Interactive</string>",
    "  <key>StandardOutPath</key>", `  <string>${xml(service.stdout)}</string>`,
    "  <key>StandardErrorPath</key>", `  <string>${xml(service.stderr)}</string>`,
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
}

function serviceRecord(service, content) {
  return { label: service.label, path: service.plist, sha256: hash(content) };
}

function managedState(service, record) {
  const exists = isFile(service.plist);
  const trusted = record?.label === service.label
    && typeof record?.path === "string"
    && path.resolve(record.path) === service.plist
    && typeof record?.sha256 === "string";
  const matches = Boolean(exists && trusted && hash(fs.readFileSync(service.plist)) === record.sha256);
  return { exists, managed: matches };
}

async function run(options, command, args) {
  const runner = options.runCommand || defaultRunner;
  try {
    const result = await runner(command, args, { cwd: options.cwd });
    const status = Number.isInteger(result?.status) ? result.status : result?.ok === true ? 0 : null;
    return {
      ok: result?.ok === true || status === 0,
      status,
      unavailable: result?.error?.code === "ENOENT",
      stderr: typeof result?.stderr === "string" ? result.stderr.trim() : ""
    };
  } catch (error) {
    return { ok: false, status: null, unavailable: error?.code === "ENOENT" };
  }
}

async function stopLoadedService(service, options) {
  const bootout = await run(options, "launchctl", ["bootout", service.target]);
  if (bootout.ok) return { ok: true };
  const inspected = await run(options, "launchctl", ["print", service.target]);
  return { ok: !inspected.ok };
}

function defaultRunner(command, args, options) {
  return spawnSync(command, args, { cwd: options.cwd, encoding: "utf8" });
}

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o644 });
  fs.renameSync(temporary, file);
}

function restoreFile(file, content) {
  if (content === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, content);
}

function readBuffer(file) {
  try { return fs.readFileSync(file); } catch { return null; }
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function publicPaths(service) {
  return { label: service.label, plist: service.plist };
}

function skipped(service) {
  return { ok: true, status: "skipped", reason: "not-managed-in-this-context", ...publicPaths(service) };
}
