#!/usr/bin/env node
import path from "node:path";

import { doctor, installOrUpdate, refreshCache, rollback } from "./plugin-lifecycle.js";
import {
  acquireReleasePackage,
  DEFAULT_RELEASE_CHANNEL,
  normalizeReleaseChannel,
  ReleaseChannelError
} from "../src/core/release-channel.js";

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    protocolVersion: "agentshell.codex-plugin-install.v1",
    error: { code: error.code || "INVALID_ARGUMENT", message: error.message },
    privacy: { dataUploaded: false, telemetry: "disabled" }
  }, null, 2));
  process.exit(1);
}

let prepared = null;
try {
  if ((options.action === "install" || options.action === "update") && options.remote && !options.dryRun) {
    prepared = await acquireReleasePackage({ channel: options.channel });
  }
  const source = options.source || prepared?.source || path.resolve(import.meta.dirname, "..");
  const lifecycleOptions = { source, home: options.home, dryRun: options.dryRun };
  const result = options.action === "doctor"
    ? doctor(lifecycleOptions)
    : options.action === "rollback"
      ? rollback(lifecycleOptions)
      : installOrUpdate(lifecycleOptions);
  const cache = (options.action === "install" || options.action === "update") && result.ok
    ? refreshCache(lifecycleOptions)
    : null;
  const release = prepared?.status || {
    ok: true,
    status: options.remote ? "would-resolve" : "local-source",
    channel: options.channel,
    source: options.remote ? "github-release" : "local",
    ...(options.remote ? {} : { path: source }),
    checksumVerified: false,
    dataUploaded: false
  };
  console.log(JSON.stringify({
    ...result,
    protocolVersion: "agentshell.codex-plugin-install.v1",
    channel: options.channel,
    requestedAction: options.action,
    ...(cache ? { cache } : {}),
    release,
    dryRun: options.dryRun,
    privacy: { dataUploaded: false, telemetry: "disabled" }
  }, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    protocolVersion: "agentshell.codex-plugin-install.v1",
    channel: options.channel,
    release: {
      ok: false,
      status: "failed",
      channel: options.channel,
      source: "github-release",
      checksumVerified: false,
      dataUploaded: false
    },
    error: {
      code: error instanceof ReleaseChannelError ? error.code : "PLUGIN_INSTALL_FAILED",
      message: error instanceof Error ? error.message : String(error),
      ...(error?.details && Object.keys(error.details).length > 0 ? { details: error.details } : {})
    },
    privacy: { dataUploaded: false, telemetry: "disabled" }
  }, null, 2));
  process.exitCode = 1;
} finally {
  prepared?.cleanup?.();
}

function parseArgs(argv) {
  const parsed = {
    action: "update",
    channel: DEFAULT_RELEASE_CHANNEL,
    source: null,
    remote: false,
    dryRun: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["install", "update", "doctor", "rollback"].includes(arg) && index === 0) parsed.action = arg;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--channel") {
      parsed.channel = normalizeReleaseChannel(requiredValue(argv, ++index, "--channel"));
      parsed.remote = true;
    } else if (arg === "--source") {
      parsed.source = path.resolve(requiredValue(argv, ++index, "--source"));
    } else if (arg === "--home") {
      parsed.home = path.resolve(requiredValue(argv, ++index, "--home"));
    } else throw new ReleaseChannelError("INVALID_ARGUMENT", `Unknown argument: ${arg}`);
  }
  if (parsed.action === "doctor" || parsed.action === "rollback") parsed.remote = false;
  if (parsed.remote && parsed.source) {
    throw new ReleaseChannelError("INVALID_ARGUMENT", "--channel and --source cannot be used together.");
  }
  return parsed;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new ReleaseChannelError("INVALID_ARGUMENT", `${option} requires a value.`);
  return value;
}
