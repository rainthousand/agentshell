import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { doctor, installOrUpdate, uninstall } from "../../scripts/plugin-lifecycle.js";
import { installAgentPolicy } from "../../scripts/install-agent-policy.js";

export const SETUP_CODEX_PROTOCOL_VERSION = "agentshell.setup-codex.v1";

const ACTIONS = new Set(["install", "update", "uninstall", "doctor"]);
const DEFAULT_SOURCE = path.resolve(import.meta.dirname, "..", "..");

export async function setupCodex(action, options = {}) {
  if (!ACTIONS.has(action)) {
    return report(false, action, options, {
      error: { code: "INVALID_ACTION", message: "Action must be install, update, uninstall, or doctor." }
    });
  }

  const paths = setupPaths(options);
  const context = { ...options, paths };
  try {
    if (action === "doctor") return await diagnose(context);
    if (action === "uninstall") return await remove(context);
    return await install(action, context);
  } catch (error) {
    return report(false, action, options, {
      error: { code: "SETUP_FAILED", message: error instanceof Error ? error.message : String(error) }
    });
  }
}

async function install(action, context) {
  const { paths, dryRun = false } = context;
  if (!isFile(paths.sourceCli)) {
    return report(false, action, context, {
      error: {
        code: "NATIVE_CLI_MISSING",
        message: `Prebuilt AgentShell CLI is missing for ${paths.platform}-${paths.arch}.`
      },
      nativeCli: { ok: false, status: "missing", source: paths.sourceCli }
    });
  }

  const lifecycle = installOrUpdate({ home: paths.home, source: paths.source, dryRun });
  if (!lifecycle.ok) {
    return report(false, action, context, {
      plugin: compactLifecycle(lifecycle),
      error: { code: "PLUGIN_INSTALL_FAILED", message: lifecycle.error || "Plugin installation failed." }
    });
  }

  if (dryRun) {
    const policy = installAgentPolicy(paths.policy, { dryRun: true });
    return report(true, action, context, {
      plugin: compactLifecycle(lifecycle),
      codex: { ok: true, status: "would-add" },
      policy: compactPolicy(policy),
      nativeCli: { ok: true, status: "would-install", path: paths.installedCli },
      validation: { ok: true, status: "would-validate" }
    });
  }

  const codex = await execute(context, "codex", ["plugin", "add", "agentshell@personal"]);
  if (!codex.ok) {
    return report(false, action, context, {
      plugin: compactLifecycle(lifecycle),
      codex,
      error: { code: "CODEX_PLUGIN_ADD_FAILED", message: "Codex could not activate the AgentShell plugin." }
    });
  }

  const policy = installAgentPolicy(paths.policy);
  const previous = snapshotManagedCli(paths);
  try {
    installNativeCli(paths);
    const validation = await execute(context, paths.installedCli, ["--version"]);
    if (!validation.ok) {
      restoreManagedCli(paths, previous);
      return report(false, action, context, {
        plugin: compactLifecycle(lifecycle),
        codex,
        policy: compactPolicy(policy),
        nativeCli: { ok: false, status: "validation-failed", path: paths.installedCli },
        validation,
        error: { code: "NATIVE_CLI_INVALID", message: "Installed AgentShell CLI failed its version check." }
      });
    }

    const hash = sha256(paths.installedCli);
    writeRecord(paths, { protocolVersion: SETUP_CODEX_PROTOCOL_VERSION, path: paths.installedCli, sha256: hash });
    return report(true, action, context, {
      plugin: compactLifecycle(lifecycle),
      codex,
      policy: compactPolicy(policy),
      nativeCli: { ok: true, status: "installed", path: paths.installedCli, sha256: hash },
      validation
    });
  } catch (error) {
    restoreManagedCli(paths, previous);
    throw error;
  }
}

async function remove(context) {
  const { paths, dryRun = false } = context;
  const record = readRecord(paths.record);
  const managed = managedCliState(paths, record);
  const lifecycle = uninstall({ home: paths.home, source: paths.source, dryRun });

  let status = "not-managed";
  if (managed.matches) {
    status = dryRun ? "would-remove" : "removed";
    if (!dryRun) fs.rmSync(paths.installedCli, { force: true });
  } else if (managed.exists && record) {
    status = "preserved-modified";
  }

  if (!dryRun && status !== "preserved-modified") fs.rmSync(paths.record, { force: true });
  return report(lifecycle.ok, "uninstall", context, {
    plugin: compactLifecycle(lifecycle),
    nativeCli: { ok: true, status, path: paths.installedCli }
  });
}

async function diagnose(context) {
  const { paths } = context;
  const lifecycle = doctor({ home: paths.home, source: paths.source });
  const record = readRecord(paths.record);
  const native = managedCliState(paths, record);
  const codex = await execute(context, "codex", ["--version"]);
  const checks = {
    plugin: Boolean(lifecycle.checks?.pluginFiles && lifecycle.checks?.marketplaceEntry),
    policy: Boolean(lifecycle.checks?.policy),
    nativeCli: native.matches && executable(paths.installedCli),
    codex: codex.ok
  };
  return report(Object.values(checks).every(Boolean), "doctor", context, {
    checks,
    plugin: compactLifecycle(lifecycle),
    nativeCli: {
      ok: checks.nativeCli,
      status: checks.nativeCli ? "ready" : native.exists ? "modified-or-unmanaged" : "missing",
      path: paths.installedCli
    },
    codex
  });
}

function setupPaths(options) {
  const home = path.resolve(options.home || os.homedir());
  const source = path.resolve(options.source || DEFAULT_SOURCE);
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  return {
    home,
    source,
    platform,
    arch,
    sourceCli: path.join(source, "bin", `agentshell-${platform}-${arch}`),
    installedCli: path.join(home, ".local", "bin", "agentshell"),
    policy: path.join(home, ".codex", "AGENTS.md"),
    record: path.join(home, ".agentshell", "standalone-install.json")
  };
}

async function execute(context, command, args) {
  const runner = context.runCommand || defaultRunCommand;
  try {
    const result = await runner(command, args, { cwd: context.paths.source });
    const status = Number.isInteger(result?.status) ? result.status : result?.ok === true ? 0 : null;
    return { ok: result?.ok === true || status === 0, status };
  } catch {
    return { ok: false, status: null };
  }
}

function defaultRunCommand(command, args, options) {
  const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8", stdio: "ignore" });
  return { ok: result.status === 0, status: result.status };
}

function installNativeCli(paths) {
  fs.mkdirSync(path.dirname(paths.installedCli), { recursive: true, mode: 0o755 });
  const temporary = `${paths.installedCli}.${process.pid}.tmp`;
  try {
    fs.copyFileSync(paths.sourceCli, temporary);
    fs.chmodSync(temporary, 0o755);
    fs.renameSync(temporary, paths.installedCli);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function snapshotManagedCli(paths) {
  if (!isFile(paths.installedCli)) return null;
  return { content: fs.readFileSync(paths.installedCli), mode: fs.statSync(paths.installedCli).mode };
}

function restoreManagedCli(paths, snapshot) {
  if (!snapshot) {
    fs.rmSync(paths.installedCli, { force: true });
    return;
  }
  fs.writeFileSync(paths.installedCli, snapshot.content, { mode: snapshot.mode });
}

function writeRecord(paths, value) {
  fs.mkdirSync(path.dirname(paths.record), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(paths.record), 0o700);
  const temporary = `${paths.record}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, paths.record);
}

function managedCliState(paths, record) {
  const exists = isFile(paths.installedCli);
  const safeRecord = record?.path === paths.installedCli && typeof record?.sha256 === "string";
  return { exists, matches: Boolean(exists && safeRecord && sha256(paths.installedCli) === record.sha256) };
}

function readRecord(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function executable(file) {
  try {
    return fs.statSync(file).isFile() && (fs.statSync(file).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function compactLifecycle(value) {
  return { ok: Boolean(value?.ok), status: value?.action || "unknown", version: value?.version || null };
}

function compactPolicy(value) {
  return { ok: Boolean(value?.ok), status: value?.status || "unknown" };
}

function report(ok, action, options, details) {
  return {
    ok,
    protocolVersion: SETUP_CODEX_PROTOCOL_VERSION,
    action,
    dryRun: Boolean(options.dryRun),
    ...details
  };
}
