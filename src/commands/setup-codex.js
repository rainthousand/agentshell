import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  doctor,
  installOrUpdate,
  refreshCache,
  rollback as rollbackPlugin,
  uninstall
} from "../../scripts/plugin-lifecycle.js";
import { installAgentPolicy } from "../../scripts/install-agent-policy.js";
import {
  inspectDashboardService,
  installDashboardService,
  removeDashboardService
} from "../core/dashboard-service.js";
import { readRegisteredWorkspaces } from "../core/workspace-registry.js";
import { writeDashboardSnapshot } from "../core/dashboard-snapshot.js";
import {
  acquireReleasePackage,
  DEFAULT_RELEASE_CHANNEL,
  DEFAULT_RELEASE_REPOSITORY,
  normalizeReleaseChannel,
  ReleaseChannelError
} from "../core/release-channel.js";
import { metrics } from "./metrics.js";

export const SETUP_CODEX_PROTOCOL_VERSION = "agentshell.setup-codex.v1";

const ACTIONS = new Set(["install", "update", "uninstall", "doctor", "rollback"]);
const PATH_BLOCK = [
  "# >>> AgentShell managed PATH >>>",
  'case ":$PATH:" in',
  '  *":$HOME/.local/bin:"*) ;;',
  '  *) export PATH="$HOME/.local/bin:$PATH" ;;',
  "esac",
  "# <<< AgentShell managed PATH <<<"
].join("\n");
const PATH_BLOCK_SHA256 = sha256Content(PATH_BLOCK);

export async function setupCodex(action, options = {}) {
  if (!ACTIONS.has(action)) {
    return report(false, action, options, {
      error: { code: "INVALID_ACTION", message: "Action must be install, update, uninstall, doctor, or rollback." }
    });
  }

  let channel;
  const requestedChannel = options.channel !== undefined
    ? options.channel
    : DEFAULT_RELEASE_CHANNEL;
  try {
    channel = normalizeReleaseChannel(requestedChannel);
  } catch (error) {
    return report(false, action, { ...options, channel: requestedChannel }, {
      release: {
        ok: false,
        status: "invalid-channel",
        channel: requestedChannel || null,
        source: "none",
        checksumVerified: false,
        dataUploaded: false
      },
      error: releaseError(error)
    });
  }

  let prepared = null;
  try {
    const sourceMode = resolveSourceMode(action, options);
    let source = options.source || process.cwd();
    let release = sourceMode === "local"
      ? localReleaseStatus(source, channel)
      : plannedReleaseStatus(channel, options.repository);

    if ((action === "install" || action === "update") && sourceMode === "remote" && !options.dryRun) {
      const acquire = options.acquireRelease || acquireReleasePackage;
      prepared = await acquire({
        channel,
        repository: options.repository || DEFAULT_RELEASE_REPOSITORY,
        fetchImpl: options.fetchImpl,
        githubToken: options.githubToken,
        apiBase: options.apiBase,
        temporaryDirectory: options.temporaryDirectory,
        extractArchive: options.extractArchive,
        runCommand: options.releaseRunCommand
      });
      source = prepared.source;
      release = prepared.status;
    }

    const paths = setupPaths({ ...options, source });
    const context = { ...options, source, sourceMode, channel, release, paths };
    if (action === "doctor") return await diagnose(context);
    if (action === "rollback") return await restorePrevious(context);
    if (action === "uninstall") return await remove(context);
    return await install(action, context);
  } catch (error) {
    const details = {
      error: error instanceof ReleaseChannelError
        ? releaseError(error)
        : { code: "SETUP_FAILED", message: error instanceof Error ? error.message : String(error) }
    };
    if (error instanceof ReleaseChannelError) {
      details.release = { ...plannedReleaseStatus(channel, options.repository), ok: false, status: "failed" };
    }
    return report(false, action, { ...options, channel }, details);
  } finally {
    prepared?.cleanup?.();
  }
}

async function install(action, context) {
  const { paths, dryRun = false } = context;
  if (!dryRun && !isFile(paths.sourceCli)) {
    return report(false, action, context, {
      error: {
        code: "NATIVE_CLI_MISSING",
        message: `Prebuilt AgentShell CLI is missing for ${paths.platform}-${paths.arch}.`
      },
      nativeCli: { ok: false, status: "missing", source: paths.sourceCli }
    });
  }

  if (!dryRun) invalidateSetupRollback(paths);
  const rollbackSnapshot = dryRun ? null : createSetupRollback(paths, action);

  const lifecycle = installOrUpdate({
    home: paths.home,
    source: paths.source,
    dryRun,
    allowUserServiceMigration: context.home === undefined
  });
  if (!lifecycle.ok) {
    discardSetupRollback(rollbackSnapshot);
    return report(false, action, context, {
      plugin: compactLifecycle(lifecycle),
      error: { code: "PLUGIN_INSTALL_FAILED", message: lifecycle.error || "Plugin installation failed." }
    });
  }

  if (dryRun) {
    const policy = installAgentPolicy(paths.policy, { dryRun: true });
    const commandPath = configureCommandPath(paths, context, readRecord(paths.record), true);
    const dashboardService = await installDashboardService(paths, {
      ...dashboardServiceOptions(context, true),
      record: readRecord(paths.record)?.dashboardService
    });
    return report(true, action, context, {
      plugin: compactLifecycle(lifecycle),
      codex: { ok: true, status: "would-add" },
      policy: compactPolicy(policy),
      nativeCli: { ok: true, status: "would-install", path: paths.installedCli },
      commandPath: compactCommandPath(commandPath),
      dashboardService: compactDashboardService(dashboardService),
      validation: { ok: true, status: "would-validate" }
    });
  }

  const cache = refreshCache({ home: paths.home });
  const codex = await execute(context, "codex", ["plugin", "add", "agentshell@personal"]);
  if (!codex.ok) {
    const recovery = await rollbackAndReactivate(context);
    const rolledBack = recovery.plugin;
    discardSetupRollback(rollbackSnapshot);
    return report(false, action, context, {
      plugin: compactLifecycle(rolledBack),
      codex,
      cache,
      rollback: {
        ok: recovery.ok,
        status: rolledBack.rolledBack ? recovery.activation.ok ? "restored" : "restored-cache-pending" : "not-available"
      },
      error: { code: "CODEX_PLUGIN_ADD_FAILED", message: "Codex could not activate the AgentShell plugin." }
    });
  }

  const previousPolicy = snapshotFile(paths.policy);
  const policy = installAgentPolicy(paths.policy);
  const previous = snapshotManagedCli(paths);
  const previousRecord = readRecord(paths.record);
  let commandPath = null;
  let dashboardService = null;
  try {
    installNativeCli(paths);
    const validation = await execute(context, paths.installedCli, ["--version"]);
    if (!validation.ok) {
      restoreManagedCli(paths, previous);
      restoreFileSnapshot(paths.policy, previousPolicy);
      const recovery = await rollbackAndReactivate(context);
      const rolledBack = recovery.plugin;
      discardSetupRollback(rollbackSnapshot);
      return report(false, action, context, {
        plugin: compactLifecycle(rolledBack),
        codex,
        policy: compactPolicy(policy),
        nativeCli: { ok: false, status: "validation-failed", path: paths.installedCli },
        validation,
        rollback: { ok: recovery.ok, status: rolledBack.rolledBack ? recovery.activation.ok ? "restored" : "restored-cache-pending" : "not-available" },
        error: { code: "NATIVE_CLI_INVALID", message: "Installed AgentShell CLI failed its version check." }
      });
    }

    const hash = sha256(paths.installedCli);
    commandPath = configureCommandPath(paths, context, previousRecord, false);
    dashboardService = await installDashboardService(paths, {
      ...dashboardServiceOptions(context, false),
      record: previousRecord?.dashboardService
    });
    if (!dashboardService.ok) {
      rollbackCommandPath(commandPath);
      restoreManagedCli(paths, previous);
      restoreFileSnapshot(paths.policy, previousPolicy);
      const recovery = await rollbackAndReactivate(context);
      const rolledBack = recovery.plugin;
      discardSetupRollback(rollbackSnapshot);
      return report(false, action, context, {
        plugin: compactLifecycle(rolledBack),
        codex,
        policy: compactPolicy(policy),
        nativeCli: { ok: false, status: "rolled-back", path: paths.installedCli },
        commandPath: compactCommandPath(commandPath),
        dashboardService: compactDashboardService(dashboardService),
        validation,
        rollback: { ok: recovery.ok, status: rolledBack.rolledBack ? recovery.activation.ok ? "restored" : "restored-cache-pending" : "not-available" },
        error: { code: "DASHBOARD_SERVICE_FAILED", message: "The managed macOS Dashboard service could not be installed safely." }
      });
    }
    const dashboardSnapshots = await refreshDashboardSnapshots(paths);
    writeRecord(paths, {
      protocolVersion: SETUP_CODEX_PROTOCOL_VERSION,
      path: paths.installedCli,
      sha256: hash,
      ...(commandPath.record ? { pathProfile: commandPath.record } : {}),
      ...(dashboardService.record ? { dashboardService: dashboardService.record } : {}),
      channel: context.channel,
      release: context.release
    });
    const setupRollback = commitSetupRollback(paths, rollbackSnapshot);
    return report(true, action, context, {
      plugin: compactLifecycle(lifecycle),
      codex,
      policy: compactPolicy(policy),
      nativeCli: { ok: true, status: "installed", path: paths.installedCli, sha256: hash },
      commandPath: compactCommandPath(commandPath),
      dashboardService: compactDashboardService(dashboardService),
      dashboardSnapshots,
      validation,
      cache,
      rollback: setupRollback
    });
  } catch (error) {
    if (dashboardService?.record) {
      await removeDashboardService(paths, dashboardService.record, dashboardServiceOptions(context, false));
    }
    rollbackCommandPath(commandPath);
    restoreManagedCli(paths, previous);
    restoreFileSnapshot(paths.policy, previousPolicy);
    await rollbackAndReactivate(context);
    discardSetupRollback(rollbackSnapshot);
    throw error;
  }
}

async function rollbackAndReactivate(context) {
  const plugin = rollbackPlugin({ home: context.paths.home, source: context.paths.source });
  if (!plugin.rolledBack || !fs.existsSync(context.paths.pluginTarget)) {
    return { ok: Boolean(plugin.ok), plugin, activation: { ok: true, status: null, skipped: true } };
  }
  const activation = await execute(context, "codex", ["plugin", "add", "agentshell@personal"]);
  return { ok: Boolean(plugin.ok && activation.ok), plugin, activation };
}

async function refreshDashboardSnapshots(paths) {
  const workspaces = readRegisteredWorkspaces({ homeDir: paths.home });
  let refreshed = 0;
  let skipped = 0;
  for (const workspace of workspaces) {
    try {
      const report = await metrics(workspace.root, { compact: true, scope: "workspace" });
      writeDashboardSnapshot(workspace.root, report, { home: paths.home });
      refreshed += 1;
    } catch {
      skipped += 1;
    }
  }
  return { ok: true, status: workspaces.length > 0 ? "refreshed" : "empty", refreshed, skipped };
}

async function remove(context) {
  const { paths, dryRun = false } = context;
  const record = readRecord(paths.record);
  const managed = managedCliState(paths, record);
  const dashboardService = await removeDashboardService(
    paths,
    record?.dashboardService,
    dashboardServiceOptions(context, dryRun)
  );
  if (!dashboardService.ok) {
    return report(false, "uninstall", context, {
      nativeCli: { ok: true, status: "preserved", path: paths.installedCli },
      dashboardService: compactDashboardService(dashboardService),
      error: { code: "DASHBOARD_SERVICE_STOP_FAILED", message: "The managed Dashboard service is still loaded; installation state was preserved." }
    });
  }
  const lifecycle = uninstall({
    home: paths.home,
    source: paths.source,
    dryRun,
    allowUserServiceMigration: context.home === undefined
  });
  const commandPath = removeManagedCommandPath(paths, record, dryRun);

  let status = "not-managed";
  if (managed.matches) {
    status = dryRun ? "would-remove" : "removed";
    if (!dryRun) fs.rmSync(paths.installedCli, { force: true });
  } else if (managed.exists && record) {
    status = "preserved-modified";
  }

  if (!dryRun && status !== "preserved-modified") fs.rmSync(paths.record, { force: true });
  if (!dryRun && lifecycle.ok) invalidateSetupRollback(paths);
  return report(lifecycle.ok, "uninstall", context, {
    plugin: compactLifecycle(lifecycle),
    nativeCli: { ok: true, status, path: paths.installedCli },
    commandPath: compactCommandPath(commandPath),
    dashboardService: compactDashboardService(dashboardService)
  });
}

async function diagnose(context) {
  const { paths } = context;
  const lifecycle = doctor({ home: paths.home, source: paths.source });
  const record = readRecord(paths.record);
  const native = managedCliState(paths, record);
  const codex = await execute(context, "codex", ["--version"]);
  const cliExecution = native.matches && executable(paths.installedCli)
    ? await execute(context, paths.installedCli, ["--version"])
    : { ok: false, status: null };
  const commandPath = inspectCommandPath(paths, context, record);
  const dashboardService = await inspectDashboardService(
    paths,
    record?.dashboardService,
    dashboardServiceOptions(context, false)
  );
  const checks = {
    plugin: Boolean(lifecycle.checks?.pluginFiles && lifecycle.checks?.marketplaceEntry),
    policy: Boolean(lifecycle.checks?.policy),
    nativeCli: native.matches && executable(paths.installedCli),
    cliExecution: cliExecution.ok,
    commandPath: commandPath.ok,
    codex: codex.ok,
    releaseIntegrity: record?.release?.source !== "github-release" || record.release.checksumVerified === true,
    ...(dashboardService.status === "skipped" ? {} : { dashboardService: dashboardService.ok })
  };
  return report(Object.values(checks).every(Boolean), "doctor", context, {
    checks,
    plugin: compactLifecycle(lifecycle),
    nativeCli: {
      ok: checks.nativeCli,
      status: checks.nativeCli ? "ready" : native.exists ? "modified-or-unmanaged" : "missing",
      path: paths.installedCli
    },
    commandPath: compactCommandPath(commandPath),
    dashboardService: compactDashboardService(dashboardService),
    codex,
    cliExecution,
    release: record?.release || context.release,
    channel: record?.channel || context.channel,
    integrity: {
      installedSha256: native.exists ? sha256(paths.installedCli) : null,
      recordedSha256: record?.sha256 || null,
      matches: native.matches,
      releaseChecksumVerified: record?.release?.source === "github-release"
        ? record.release.checksumVerified === true
        : null
    },
    rollback: inspectSetupRollback(paths)
  });
}

async function restorePrevious(context) {
  const { paths, dryRun = false } = context;
  const transaction = readRecord(paths.setupRollback);
  if (!transaction) {
    return report(true, "rollback", context, {
      rollback: { ok: true, status: "not-available", available: false },
      error: null
    });
  }
  try {
    validateSetupRollback(paths, transaction);
  } catch (error) {
    return report(false, "rollback", context, {
      rollback: { ok: false, status: "invalid", available: false },
      error: { code: "ROLLBACK_TRANSACTION_INVALID", message: error instanceof Error ? error.message : String(error) }
    });
  }
  if (dryRun) {
    return report(true, "rollback", context, {
      rollback: { ok: true, status: "would-restore", available: true, fromAction: transaction.action }
    });
  }

  const currentRecord = readRecord(paths.record);
  const dashboardRemoved = await removeDashboardService(
    paths,
    currentRecord?.dashboardService,
    dashboardServiceOptions(context, false)
  );
  if (!dashboardRemoved.ok) {
    return report(false, "rollback", context, {
      rollback: { ok: false, status: "blocked", available: true },
      dashboardService: compactDashboardService(dashboardRemoved),
      error: { code: "ROLLBACK_SERVICE_STOP_FAILED", message: "The current Dashboard service could not be stopped safely." }
    });
  }

  const plugin = rollbackPlugin({ home: paths.home, source: paths.source });
  if (!plugin.ok) {
    return report(false, "rollback", context, {
      rollback: { ok: false, status: "plugin-restore-failed", available: true },
      plugin: compactLifecycle(plugin),
      error: { code: "ROLLBACK_PLUGIN_FAILED", message: plugin.error || "The previous plugin could not be restored." }
    });
  }

  try {
    restoreSetupFiles(paths, transaction);
    const restoredRecord = readRecord(paths.record);
    const previousCliExisted = transaction.files?.installedCli?.exists === true;
    const codex = previousCliExisted
      ? await execute(context, "codex", ["plugin", "add", "agentshell@personal"])
      : { ok: true, status: null, skipped: true };
    const validation = previousCliExisted
      ? await execute(context, paths.installedCli, ["--version"])
      : { ok: !isFile(paths.installedCli), status: null, skipped: true };
    const dashboardService = restoredRecord?.dashboardService
      ? await installDashboardService(paths, {
        ...dashboardServiceOptions(context, false),
        record: restoredRecord.dashboardService
      })
      : { ok: true, status: "not-managed" };
    const healthy = plugin.ok && codex.ok && validation.ok && dashboardService.ok;
    if (healthy) {
      fs.rmSync(transaction.directory, { recursive: true, force: true });
      fs.rmSync(paths.setupRollback, { force: true });
    }
    return report(healthy, "rollback", context, {
      plugin: compactLifecycle(plugin),
      codex,
      validation,
      dashboardService: compactDashboardService(dashboardService),
      rollback: {
        ok: healthy,
        status: healthy ? "restored" : "restored-needs-attention",
        available: !healthy,
        fromAction: transaction.action,
        ...(!healthy ? {
          recovery: {
            transaction: paths.setupRollback,
            backupDirectory: transaction.directory
          }
        } : {})
      },
      release: restoredRecord?.release || context.release,
      channel: restoredRecord?.channel || context.channel,
      ...(healthy ? {} : {
        error: {
          code: "ROLLBACK_HEALTH_CHECK_FAILED",
          message: `Previous files were restored, but one or more health checks failed. Recovery files remain at ${transaction.directory}.`
        }
      })
    });
  } catch (error) {
    return report(false, "rollback", context, {
      rollback: { ok: false, status: "restore-failed", available: true },
      error: { code: "ROLLBACK_RESTORE_FAILED", message: error instanceof Error ? error.message : String(error) }
    });
  }
}

function setupPaths(options) {
  const home = path.resolve(options.home || os.homedir());
  const source = path.resolve(options.source || process.cwd());
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  return {
    home,
    source,
    platform,
    arch,
    sourceCli: path.join(source, "bin", `agentshell-${platform}-${arch}`),
    installedCli: path.join(home, ".local", "bin", "agentshell"),
    pluginTarget: path.join(home, "plugins", "agentshell"),
    policy: path.join(home, ".codex", "AGENTS.md"),
    record: path.join(home, ".agentshell", "standalone-install.json"),
    setupBackups: path.join(home, ".agentshell", "setup-backups"),
    setupRollback: path.join(home, ".agentshell", "setup-rollback.json")
  };
}

function createSetupRollback(paths, action) {
  const directory = path.join(paths.setupBackups, `setup-${Date.now()}-${process.pid}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const previousRecord = readRecord(paths.record);
  const candidates = {
    installedCli: paths.installedCli,
    policy: paths.policy,
    record: paths.record,
    zprofile: path.join(paths.home, ".zprofile"),
    bashProfile: path.join(paths.home, ".bash_profile"),
    profile: path.join(paths.home, ".profile"),
    dashboardPlist: previousRecord?.dashboardService?.path === managedDashboardPlist(paths)
      ? managedDashboardPlist(paths)
      : null
  };
  const files = {};
  for (const [name, file] of Object.entries(candidates)) {
    if (!file) continue;
    files[name] = snapshotSetupFile(file, directory, name);
  }
  return {
    protocolVersion: SETUP_CODEX_PROTOCOL_VERSION,
    action,
    createdAt: new Date().toISOString(),
    directory,
    files
  };
}

function snapshotSetupFile(file, directory, name) {
  if (!isFile(file)) return { path: file, exists: false };
  const backup = path.join(directory, name);
  fs.copyFileSync(file, backup);
  const mode = fs.statSync(file).mode;
  fs.chmodSync(backup, mode);
  return { path: file, exists: true, backup, mode };
}

function commitSetupRollback(paths, transaction) {
  if (!transaction) return { ok: true, status: "not-created", available: false };
  const previous = readRecord(paths.setupRollback);
  writeRecord({ record: paths.setupRollback }, transaction);
  if (safeSetupBackupDirectory(paths, previous?.directory) && previous.directory !== transaction.directory) {
    fs.rmSync(previous.directory, { recursive: true, force: true });
  }
  return { ok: true, status: "available", available: true, fromAction: transaction.action };
}

function inspectSetupRollback(paths) {
  const transaction = readRecord(paths.setupRollback);
  let available = false;
  try {
    validateSetupRollback(paths, transaction);
    available = true;
  } catch {
    available = false;
  }
  return {
    ok: true,
    status: available ? "available" : "not-available",
    available,
    ...(available ? { fromAction: transaction.action, createdAt: transaction.createdAt } : {})
  };
}

function discardSetupRollback(transaction) {
  if (transaction?.directory) fs.rmSync(transaction.directory, { recursive: true, force: true });
}

function invalidateSetupRollback(paths) {
  const previous = readRecord(paths.setupRollback);
  if (safeSetupBackupDirectory(paths, previous?.directory)) {
    fs.rmSync(previous.directory, { recursive: true, force: true });
  }
  fs.rmSync(paths.setupRollback, { force: true });
}

function restoreSetupFiles(paths, transaction) {
  validateSetupRollback(paths, transaction);
  for (const entry of Object.values(transaction.files || {})) {
    if (!entry?.path) continue;
    if (!entry.exists) {
      fs.rmSync(entry.path, { force: true });
      continue;
    }
    if (!entry.backup || !isFile(entry.backup)) throw new Error(`Rollback backup is missing for ${entry.path}.`);
    fs.mkdirSync(path.dirname(entry.path), { recursive: true });
    const temporary = `${entry.path}.${process.pid}.rollback.tmp`;
    fs.copyFileSync(entry.backup, temporary);
    if (entry.mode) fs.chmodSync(temporary, entry.mode);
    fs.renameSync(temporary, entry.path);
  }
}

function validateSetupRollback(paths, transaction) {
  if (!transaction || !safeSetupBackupDirectory(paths, transaction.directory) || !fs.statSync(transaction.directory).isDirectory()) {
    throw new Error("The setup rollback snapshot is missing or unmanaged.");
  }
  const allowed = new Set([
    paths.installedCli,
    paths.policy,
    paths.record,
    path.join(paths.home, ".zprofile"),
    path.join(paths.home, ".bash_profile"),
    path.join(paths.home, ".profile"),
    managedDashboardPlist(paths)
  ].map((file) => path.resolve(file)));
  for (const entry of Object.values(transaction.files || {})) {
    if (!entry?.path || !allowed.has(path.resolve(entry.path))) throw new Error("The setup rollback snapshot references an unmanaged file.");
    if (entry.exists && (!entry.backup || !safeChild(transaction.directory, entry.backup) || !isFile(entry.backup))) {
      throw new Error(`Rollback backup is missing for ${entry.path}.`);
    }
  }
}

function safeSetupBackupDirectory(paths, directory) {
  return Boolean(directory && safeChild(paths.setupBackups, directory));
}

function managedDashboardPlist(paths) {
  return path.join(paths.home, "Library", "LaunchAgents", "com.agentshell.dashboard.plist");
}

function safeChild(parent, candidate) {
  const root = `${path.resolve(parent)}${path.sep}`;
  return path.resolve(candidate).startsWith(root);
}

function dashboardServiceOptions(context, dryRun) {
  return {
    enabled: context.home === undefined || context.allowUserServiceManagement === true,
    platform: context.paths.platform,
    uid: context.uid,
    dryRun,
    runCommand: context.runCommand,
    cwd: context.paths.source
  };
}

function configureCommandPath(paths, context, record, dryRun) {
  const current = inspectCommandPath(paths, context, record);
  if (current.visible || current.configured) return current;

  const profile = preferredShellProfile(paths, context);
  if (!profile) return current;
  if (!safeProfile(profile)) {
    return { ...current, status: "fallback-required", profile, reason: "profile-not-regular-file" };
  }

  const content = readText(profile);
  if (content.includes(PATH_BLOCK)) {
    return { ...current, ok: true, status: "profile-configured-unmanaged", profile, configured: true };
  }

  const leadingNewline = content.length > 0 && !content.endsWith("\n");
  const inserted = `${leadingNewline ? "\n" : ""}${PATH_BLOCK}\n`;
  const pathRecord = {
    path: profile,
    blockSha256: PATH_BLOCK_SHA256,
    leadingNewline,
    createdProfile: !fs.existsSync(profile)
  };
  if (dryRun) {
    return { ...current, ok: true, status: "would-configure", profile, configured: true, record: pathRecord };
  }

  fs.mkdirSync(path.dirname(profile), { recursive: true });
  fs.appendFileSync(profile, inserted, { encoding: "utf8", mode: 0o644 });
  return {
    ...current,
    ok: true,
    status: "profile-updated",
    profile,
    configured: true,
    record: pathRecord,
    rollback: { profile, content }
  };
}

function inspectCommandPath(paths, context, record) {
  const visible = pathEntries(context.env?.PATH ?? process.env.PATH).includes(path.resolve(path.dirname(paths.installedCli)));
  const managed = managedProfileState(paths, record);
  return {
    ok: visible || managed.matches,
    status: visible ? "visible" : managed.matches ? "profile-configured" : "fallback-required",
    visible,
    configured: managed.matches,
    profile: managed.profile,
    directory: path.dirname(paths.installedCli),
    fallbackCommand: paths.installedCli,
    record: managed.matches ? record.pathProfile : null
  };
}

function removeManagedCommandPath(paths, record, dryRun) {
  const managed = managedProfileState(paths, record);
  const base = {
    ok: true,
    visible: false,
    configured: false,
    profile: managed.profile,
    directory: path.dirname(paths.installedCli),
    fallbackCommand: paths.installedCli
  };
  if (!record?.pathProfile) return { ...base, status: "not-managed" };
  if (!managed.trusted) return { ...base, status: "preserved-untrusted" };
  if (!managed.exists) return { ...base, status: "already-absent" };
  if (!managed.matches) return { ...base, status: "preserved-modified" };
  if (dryRun) return { ...base, status: "would-remove", configured: true };

  const content = readText(managed.profile);
  const leading = record.pathProfile.leadingNewline ? "\n" : "";
  const insertion = `${leading}${PATH_BLOCK}\n`;
  const next = content.replace(insertion, "");
  if (record.pathProfile.createdProfile && next.length === 0) fs.rmSync(managed.profile, { force: true });
  else fs.writeFileSync(managed.profile, next, "utf8");
  return { ...base, status: "removed" };
}

function rollbackCommandPath(commandPath) {
  if (!commandPath?.rollback) return;
  const { profile, content } = commandPath.rollback;
  if (content.length === 0) fs.rmSync(profile, { force: true });
  else fs.writeFileSync(profile, content, "utf8");
}

function managedProfileState(paths, record) {
  const profile = record?.pathProfile?.path;
  const trusted = typeof profile === "string"
    && allowedProfiles(paths).includes(path.resolve(profile))
    && record.pathProfile.blockSha256 === PATH_BLOCK_SHA256;
  const exists = Boolean(trusted && isFile(profile));
  if (!exists) return { trusted, exists, matches: false, profile: trusted ? profile : null };
  const leading = record.pathProfile.leadingNewline ? "\n" : "";
  return {
    trusted,
    exists,
    matches: readText(profile).includes(`${leading}${PATH_BLOCK}\n`),
    profile
  };
}

function preferredShellProfile(paths, context) {
  const shell = path.basename(context.shell || context.env?.SHELL || process.env.SHELL || "");
  if (shell === "zsh") return path.join(paths.home, ".zprofile");
  if (shell === "bash") return path.join(paths.home, ".bash_profile");
  if (shell === "sh") return path.join(paths.home, ".profile");
  return null;
}

function allowedProfiles(paths) {
  return [".zprofile", ".bash_profile", ".profile"].map((name) => path.join(paths.home, name));
}

function safeProfile(file) {
  try {
    return fs.lstatSync(file).isFile();
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

function pathEntries(value) {
  return String(value || "").split(path.delimiter).filter(Boolean).map((entry) => path.resolve(entry));
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
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

function snapshotFile(file) {
  if (!isFile(file)) return null;
  return { content: fs.readFileSync(file), mode: fs.statSync(file).mode };
}

function restoreFileSnapshot(file, snapshot) {
  if (!snapshot) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, snapshot.content, { mode: snapshot.mode });
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

function sha256Content(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
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
  return {
    ok: Boolean(value?.ok),
    status: value?.action || "unknown",
    version: value?.version || null,
    ...(value?.legacyDashboardMigration ? { legacyDashboardMigration: value.legacyDashboardMigration } : {})
  };
}

function compactPolicy(value) {
  return { ok: Boolean(value?.ok), status: value?.status || "unknown" };
}

function compactCommandPath(value) {
  return {
    ok: Boolean(value?.ok),
    status: value?.status || "unknown",
    visible: Boolean(value?.visible),
    configured: Boolean(value?.configured),
    directory: value?.directory || null,
    profile: value?.profile || null,
    fallbackCommand: value?.fallbackCommand || null,
    ...(value?.reason ? { reason: value.reason } : {})
  };
}

function compactDashboardService(value) {
  return {
    ok: Boolean(value?.ok),
    status: value?.status || "unknown",
    label: value?.label || null,
    plist: value?.plist || null,
    ...(Number.isInteger(value?.launchctlStatus) ? { launchctlStatus: value.launchctlStatus } : {}),
    ...(value?.reason ? { reason: value.reason } : {})
  };
}

function report(ok, action, options, details) {
  return {
    ok,
    protocolVersion: SETUP_CODEX_PROTOCOL_VERSION,
    action,
    dryRun: Boolean(options.dryRun),
    channel: Object.hasOwn(options, "channel") ? options.channel : DEFAULT_RELEASE_CHANNEL,
    release: details.release || options.release || localReleaseStatus(options.source || process.cwd(), options.channel),
    privacy: { dataUploaded: false, telemetry: "disabled" },
    ...details
  };
}

function resolveSourceMode(action, options) {
  if (action !== "install" && action !== "update") return "installed";
  if (options.sourceMode === "local" || options.sourceMode === "remote") return options.sourceMode;
  return options.source ? "local" : "remote";
}

function localReleaseStatus(source, channel = DEFAULT_RELEASE_CHANNEL) {
  return {
    ok: true,
    status: "local-source",
    channel: channel || DEFAULT_RELEASE_CHANNEL,
    source: "local",
    path: path.resolve(source || process.cwd()),
    checksumVerified: false,
    dataUploaded: false
  };
}

function plannedReleaseStatus(channel, repository = DEFAULT_RELEASE_REPOSITORY) {
  return {
    ok: true,
    status: "would-resolve",
    channel,
    source: "github-release",
    repository: repository || DEFAULT_RELEASE_REPOSITORY,
    checksumVerified: false,
    dataUploaded: false
  };
}

function releaseError(error) {
  return {
    code: error?.code || "SETUP_FAILED",
    message: error instanceof Error ? error.message : String(error),
    ...(error?.details && Object.keys(error.details).length > 0 ? { details: error.details } : {})
  };
}
