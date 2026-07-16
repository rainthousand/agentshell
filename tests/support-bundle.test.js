import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSupportBundle } from "../scripts/support-bundle.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-support-test-"));
  const packageDir = path.join(root, "package");
  const home = path.join(root, "private-user-name");
  fs.mkdirSync(path.join(packageDir, ".codex-plugin"), { recursive: true });
  fs.mkdirSync(path.join(packageDir, "bin"), { recursive: true });
  fs.mkdirSync(path.join(home, ".agentshell", "dashboard-snapshots"), { recursive: true });
  fs.mkdirSync(path.join(home, "plugins", "agentshell", ".codex-plugin"), { recursive: true });
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ version: "1.0.0", secret: "PACKAGE_SECRET" }));
  fs.writeFileSync(path.join(packageDir, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "agentshell", version: "1.0.0" }));
  fs.writeFileSync(path.join(packageDir, "bin", "agentshell-darwin-arm64"), "binary");
  fs.writeFileSync(path.join(home, "plugins", "agentshell", ".codex-plugin", "plugin.json"), JSON.stringify({ version: "1.0.0", commandOutput: "PRIVATE_OUTPUT" }));
  fs.writeFileSync(path.join(home, ".local", "bin", "agentshell"), "binary");
  fs.writeFileSync(path.join(home, ".agentshell", "standalone-install.json"), JSON.stringify({
    protocolVersion: "agentshell.setup-codex.v1",
    path: path.join(home, "secret", "agentshell"),
    authorization: "PRIVATE_AUTH",
    dashboardService: { label: "com.agentshell.dashboard", path: path.join(home, "Library", "service.plist"), sha256: "a".repeat(64) }
  }));
  fs.writeFileSync(path.join(home, ".agentshell", "dashboard-snapshots", "one.json"), JSON.stringify({ estimatedTokensSaved: 999, output: "PRIVATE_OUTPUT" }));
  fs.writeFileSync(path.join(home, ".agentshell", "dashboard-launch.log"), `PRIVATE_OUTPUT ${home}`);
  return { root, packageDir, home };
}

test("support JSON contains only allowlisted diagnostics", () => {
  const value = fixture();
  const output = path.join(value.root, "bundle.json");
  try {
    const result = createSupportBundle({ packageDir: value.packageDir, home: value.home, output });
    const json = fs.readFileSync(output, "utf8");
    const report = JSON.parse(json);
    assert.equal(result.artifact.written, true);
    assert.equal(report.privacy.redacted, true);
    assert.equal(report.installation.dashboardSnapshotCount, 1);
    assert.equal(report.installation.dashboardServiceRecorded, true);
    for (const forbidden of [value.home, "private-user-name", "PRIVATE_AUTH", "PRIVATE_OUTPUT", "PACKAGE_SECRET", "999", "estimatedTokensSaved"]) {
      assert.equal(json.includes(forbidden), false, `bundle leaked ${forbidden}`);
    }
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("support ZIP contains a readable redacted JSON entry", () => {
  const value = fixture();
  const output = path.join(value.root, "bundle.zip");
  try {
    const result = createSupportBundle({ packageDir: value.packageDir, home: value.home, output, format: "zip" });
    assert.equal(result.artifact.format, "zip");
    const unzip = spawnSync("unzip", ["-p", output, "agentshell-support.json"], { encoding: "utf8" });
    assert.equal(unzip.status, 0, unzip.stderr);
    const report = JSON.parse(unzip.stdout);
    assert.equal(report.protocolVersion, "agentshell.support-bundle.v1");
    assert.equal(unzip.stdout.includes(value.home), false);
    assert.equal(unzip.stdout.includes("PRIVATE_OUTPUT"), false);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("support dry-run writes no artifact", () => {
  const value = fixture();
  const output = path.join(value.root, "not-created.json");
  try {
    const result = createSupportBundle({ packageDir: value.packageDir, home: value.home, output, dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.artifact.written, false);
    assert.equal(fs.existsSync(output), false);
    assert.equal(JSON.stringify(result).includes(value.home), false);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});
