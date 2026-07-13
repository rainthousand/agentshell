#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const tagIndex = args.indexOf("--tag");
const tag = tagIndex >= 0 ? args[tagIndex + 1] : process.env.GITHUB_REF_NAME || null;
const packageJson = read("package.json");
const manifest = read(".codex-plugin/plugin.json");
const manifestBase = String(manifest.version || "").split("+", 1)[0];
const checks = {
  packageVersion: /^\d+\.\d+\.\d+$/.test(packageJson.version),
  manifestMatchesPackage: manifestBase === packageJson.version,
  tagMatchesPackage: !tag || tag === `v${packageJson.version}`,
  licensePresent: fs.existsSync(path.join(root, "LICENSE")),
  changelogPresent: fs.existsSync(path.join(root, "CHANGELOG.md")),
  ciPresent: fs.existsSync(path.join(root, ".github", "workflows", "ci.yml")),
  releaseWorkflowPresent: fs.existsSync(path.join(root, ".github", "workflows", "release.yml"))
};
const report = {
  ok: Object.values(checks).every(Boolean),
  protocolVersion: "agentshell.release-gate.v1",
  version: packageJson.version,
  pluginVersion: manifest.version,
  tag,
  checks
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;

function read(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}
