#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "artifacts", "release");
const skipNativeBuild = process.env.AGENTSHELL_SKIP_NATIVE_RELEASE_BUILD === "1";
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

if (process.platform === "darwin" && !skipNativeBuild) run("npm", ["run", "dashboard:build-app"]);
if (process.platform === "darwin" && process.arch === "arm64" && !skipNativeBuild) {
  run("npm", ["run", "build:standalone"]);
}
run("node", ["scripts/share-package.js", "--out-dir", outDir, "--name", "agentshell-codex-plugin", "--zip"]);
const zip = path.join(outDir, "agentshell-codex-plugin.zip");
const checksum = writeChecksum(zip);
const standaloneSource = path.join(root, "bin", "agentshell-darwin-arm64");
const standalone = path.join(outDir, path.basename(standaloneSource));
fs.copyFileSync(standaloneSource, standalone);
fs.chmodSync(standalone, 0o755);
const standaloneChecksum = writeChecksum(standalone);
const report = {
  ok: true,
  protocolVersion: "agentshell.release-artifacts.v1",
  platform: process.platform,
  zip,
  bytes: fs.statSync(zip).size,
  sha256: checksum,
  standalone: {
    path: standalone,
    bytes: fs.statSync(standalone).size,
    sha256: standaloneChecksum,
    rebuilt: process.platform === "darwin" && process.arch === "arm64" && !skipNativeBuild
  }
};
fs.writeFileSync(path.join(outDir, "release-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed`);
}

function writeChecksum(file) {
  const checksum = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  fs.writeFileSync(`${file}.sha256`, `${checksum}  ${path.basename(file)}\n`);
  return checksum;
}
