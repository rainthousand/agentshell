#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "desktop", "macos", "AgentShellDashboard.swift");
const outputRoot = path.join(root, "desktop", "macos", "dist");
const app = path.join(outputRoot, "AgentShell Dashboard.app");
const contents = path.join(app, "Contents");
const macos = path.join(contents, "MacOS");
const executable = path.join(macos, "AgentShellDashboard");

if (process.platform !== "darwin") {
  console.log(JSON.stringify({
    ok: false,
    protocolVersion: "agentshell.dashboard-build.v1",
    status: "unsupported",
    reason: "The native dashboard app currently targets macOS."
  }, null, 2));
  process.exit(1);
}

fs.rmSync(app, { recursive: true, force: true });
fs.mkdirSync(macos, { recursive: true });
fs.mkdirSync(path.join(contents, "Resources"), { recursive: true });

const build = spawnSync("xcrun", [
  "swiftc",
  source,
  "-o",
  executable,
  "-framework",
  "AppKit",
  "-framework",
  "WebKit",
  "-O"
], {
  cwd: root,
  encoding: "utf8"
});

if (build.status !== 0) {
  console.error(build.stderr || build.stdout || "swiftc failed");
  process.exit(build.status || 1);
}

fs.writeFileSync(path.join(contents, "Info.plist"), infoPlist());
fs.writeFileSync(path.join(contents, "PkgInfo"), "APPL????\n");
fs.chmodSync(executable, 0o755);

const size = fs.statSync(executable).size;
console.log(JSON.stringify({
  ok: true,
  protocolVersion: "agentshell.dashboard-build.v1",
  platform: "macos",
  app,
  executable,
  executableBytes: size
}, null, 2));

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key><string>AgentShell Dashboard</string>
  <key>CFBundleExecutable</key><string>AgentShellDashboard</string>
  <key>CFBundleIdentifier</key><string>dev.agentshell.dashboard</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>AgentShell Dashboard</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.24.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
`;
}
