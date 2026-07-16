import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SUPPORT_BUNDLE_PROTOCOL_VERSION = "agentshell.support-bundle.v1";
const ZIP_ENTRY = "agentshell-support.json";

export function createSupportBundle(options = {}) {
  if (!options.packageDir) throw argumentError("PACKAGE_DIR_REQUIRED", "--package-dir is required.");
  const packageDir = path.resolve(options.packageDir);
  const home = path.resolve(options.home || os.homedir());
  const format = resolveFormat(options.format, options.output);
  const report = collectReport(packageDir, home);
  assertPrivate(report, home);

  if (options.dryRun === true) {
    return { ...report, dryRun: true, artifact: { format, written: false } };
  }
  if (!options.output) throw argumentError("OUTPUT_REQUIRED", "--output is required unless --dry-run is used.");
  const output = path.resolve(options.output);
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (format === "zip") fs.writeFileSync(output, createZip(ZIP_ENTRY, Buffer.from(json)), { mode: 0o600 });
  else fs.writeFileSync(output, json, { mode: 0o600 });
  return { ...report, dryRun: false, artifact: { format, written: true, bytes: fs.statSync(output).size } };
}

function collectReport(packageDir, home) {
  const packageManifest = readJson(path.join(packageDir, "package.json"));
  const sourcePlugin = readJson(path.join(packageDir, ".codex-plugin", "plugin.json"));
  const installRecord = readJson(path.join(home, ".agentshell", "standalone-install.json"));
  const installedPlugin = readJson(path.join(home, "plugins", "agentshell", ".codex-plugin", "plugin.json"));
  const snapshotDir = path.join(home, ".agentshell", "dashboard-snapshots");
  const serviceRecord = installRecord?.dashboardService;

  return {
    ok: true,
    protocolVersion: SUPPORT_BUNDLE_PROTOCOL_VERSION,
    privacy: {
      redacted: true,
      fileContentsIncluded: false,
      commandOutputIncluded: false,
      userPathsIncluded: false,
      usageMetricsIncluded: false,
      secretValuesIncluded: false
    },
    environment: {
      platform: process.platform,
      architecture: process.arch,
      osRelease: safeVersion(os.release()),
      nodeVersion: safeVersion(process.versions.node),
      supportedRuntime: process.platform === "darwin" && process.arch === "arm64"
    },
    package: {
      present: isDirectory(packageDir),
      version: safeVersion(packageManifest?.version),
      pluginVersion: safeVersion(sourcePlugin?.version),
      manifestValid: sourcePlugin?.name === "agentshell" && typeof sourcePlugin?.version === "string",
      nativeCliPresent: isFile(path.join(packageDir, "bin", "agentshell-darwin-arm64"))
    },
    installation: {
      recordPresent: installRecord !== null,
      recordProtocolVersion: safeProtocol(installRecord?.protocolVersion),
      cliPresent: isFile(path.join(home, ".local", "bin", "agentshell")),
      pluginPresent: isDirectory(path.join(home, "plugins", "agentshell")),
      installedPluginVersion: safeVersion(installedPlugin?.version),
      policyPresent: isFile(path.join(home, ".codex", "AGENTS.md")),
      dashboardServiceRecorded: serviceRecord?.label === "com.agentshell.dashboard" && typeof serviceRecord?.sha256 === "string",
      dashboardSnapshotCount: safeDirectoryCount(snapshotDir, ".json")
    }
  };
}

function assertPrivate(report, home) {
  const serialized = JSON.stringify(report);
  const forbiddenKeys = /(?:^|["_-])(token|secret|password|authorization|commandOutput|fileContent)(?:["_-]|$)/iu;
  if (serialized.includes(home) || serialized.includes(path.basename(home)) || forbiddenKeys.test(serialized)) {
    throw new Error("Support bundle privacy invariant failed.");
  }
}

function resolveFormat(format, output) {
  const inferred = output && path.extname(output).toLowerCase() === ".zip" ? "zip" : "json";
  const value = format || inferred;
  if (value !== "json" && value !== "zip") throw argumentError("INVALID_FORMAT", "--format must be json or zip.");
  return value;
}

function safeDirectoryCount(directory, suffix) {
  try { return fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(suffix)).length; } catch { return 0; }
}

function safeVersion(value) {
  return typeof value === "string" && /^[0-9A-Za-z.+_-]{1,64}$/u.test(value) ? value : null;
}

function safeProtocol(value) {
  return typeof value === "string" && /^[a-z0-9.+_-]{1,80}$/u.test(value) ? value : null;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function isDirectory(value) {
  try { return fs.statSync(value).isDirectory(); } catch { return false; }
}

function isFile(value) {
  try { return fs.statSync(value).isFile(); } catch { return false; }
}

function argumentError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createZip(name, data) {
  const nameBuffer = Buffer.from(name);
  const checksum = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuffer.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuffer.length, 28);
  const centralOffset = local.length + nameBuffer.length + data.length;
  const centralSize = central.length + nameBuffer.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBuffer, data, central, nameBuffer, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
