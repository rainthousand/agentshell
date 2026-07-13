import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildSharePackage } from "../scripts/share-package.js";

test("share package builds a real-user handoff directory without runtime state", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-share-package-"));
  const report = buildSharePackage(process.cwd(), {
    outDir,
    name: "agentshell-real-user"
  });

  assert.equal(report.ok, true);
  assert.equal(report.protocolVersion, "agentshell.share-package.v1");
  assert.equal(report.packageName, "agentshell-real-user");
  assert.equal(report.zipPath, null);
  assert.equal(report.summary.excludedPresent, 0);
  assert.equal(report.summary.zipCreated, false);

  const packageDir = report.packageDir;
  assert.equal(fs.existsSync(path.join(packageDir, "START-HERE.md")), true);
  assert.equal(fs.existsSync(path.join(packageDir, "install.command")), true);
  assert.equal(fs.existsSync(path.join(packageDir, "check-install.command")), true);
  assert.equal(fs.existsSync(path.join(packageDir, "update.command")), true);
  assert.equal(fs.existsSync(path.join(packageDir, "uninstall.command")), true);
  assert.equal(fs.existsSync(path.join(packageDir, "README.md")), true);
  assert.equal(fs.existsSync(path.join(packageDir, "package.json")), true);
  assert.equal(fs.existsSync(path.join(packageDir, ".codex-plugin", "plugin.json")), true);
  assert.equal(fs.existsSync(path.join(packageDir, "bin", "agentshell")), true);
  assert.equal(fs.existsSync(path.join(packageDir, "bin", "agentshell-darwin-arm64")), true);
  assert.equal(fs.existsSync(path.join(packageDir, "src", "cli.js")), true);
  assert.equal(fs.existsSync(path.join(packageDir, "scripts", "install-for-codex-user.js")), true);
  assert.equal(fs.existsSync(path.join(packageDir, "scripts", "install-codex-plugin.js")), true);
  assert.equal(fs.existsSync(path.join(packageDir, "scripts", "install-agent-policy.js")), true);
  assert.equal(fs.existsSync(path.join(packageDir, "scripts", "plugin-smoke.js")), true);
  assert.equal(fs.existsSync(path.join(packageDir, "docs", "quickstart.md")), true);
  assert.equal(fs.existsSync(path.join(packageDir, "docs", "codex-plugin-flow.md")), true);
  assert.equal(fs.existsSync(path.join(packageDir, "skills", "agentshell", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(packageDir, "schemas", "manual.schema.json")), true);
  assert.equal(fs.existsSync(path.join(packageDir, "examples", "failing-test-demo", "package.json")), true);

  for (const excluded of [".git", ".agentshell", "artifacts", "node_modules"]) {
    assert.equal(fs.existsSync(path.join(packageDir, excluded)), false, `${excluded} should be excluded`);
    assert.equal(
      fs.existsSync(path.join(packageDir, "examples", "failing-test-demo", excluded)),
      false,
      `nested ${excluded} should be excluded`
    );
  }

  const startHere = fs.readFileSync(path.join(packageDir, "START-HERE.md"), "utf8");
  assert.match(startHere, /agentshell-darwin-arm64 setup codex install/);
  assert.match(startHere, /Double-click `install\.command`/);
  assert.match(startHere, /check-install\.command/);
  assert.match(startHere, /agentshell trial export --verify --rating 5/);
  assert.match(startHere, /not a public plugin release/i);

  const binMode = fs.statSync(path.join(packageDir, "bin", "agentshell")).mode;
  assert.notEqual(binMode & 0o111, 0, "bin/agentshell should remain executable");
  const installCommand = fs.readFileSync(path.join(packageDir, "install.command"), "utf8");
  assert.match(installCommand, /npm run install:codex/);
  assert.match(installCommand, /agentshell-darwin-arm64.*setup codex install/);
  assert.match(installCommand, /agentshell-install\.log/);
  assert.match(installCommand, /PIPESTATUS/);
  const installCommandMode = fs.statSync(path.join(packageDir, "install.command")).mode;
  assert.notEqual(installCommandMode & 0o111, 0, "install.command should be executable");
  const checkInstallCommand = fs.readFileSync(path.join(packageDir, "check-install.command"), "utf8");
  assert.match(checkInstallCommand, /doctor:codex/);
  assert.match(checkInstallCommand, /setup codex doctor/);
  assert.match(checkInstallCommand, /agentshell-install-check\.json/);
  const checkInstallCommandMode = fs.statSync(path.join(packageDir, "check-install.command")).mode;
  assert.notEqual(checkInstallCommandMode & 0o111, 0, "check-install.command should be executable");
  for (const action of ["update", "uninstall"]) {
    const file = path.join(packageDir, `${action}.command`);
    assert.match(fs.readFileSync(file, "utf8"), new RegExp(`npm run ${action}:codex`));
    assert.match(fs.readFileSync(file, "utf8"), new RegExp(`setup codex ${action}`));
    assert.notEqual(fs.statSync(file).mode & 0o111, 0, `${action}.command should be executable`);
  }
});

test("share package CLI prints help and creates parseable JSON", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-share-package-cli-"));
  const help = spawnSync("node", ["scripts/share-package.js", "--help"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const build = spawnSync("node", ["scripts/share-package.js", "--out-dir", outDir, "--name", "agentshell-cli-share"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(help.status, 0, help.stderr);
  assert.equal(build.status, 0, build.stderr);

  const helpOutput = JSON.parse(help.stdout);
  assert.equal(helpOutput.ok, true);
  assert.match(helpOutput.usage, /share-package\.js/);

  const output = JSON.parse(build.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.share-package.v1");
  assert.equal(fs.existsSync(path.join(outDir, "agentshell-cli-share", "START-HERE.md")), true);
  assert.deepEqual(output.excludedPresent, []);
});

test("package exposes share package script", () => {
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(packageJson.scripts?.["share:package"], "node scripts/share-package.js");
});

test("share package rejects unsafe package names", () => {
  assert.throws(
    () => buildSharePackage(process.cwd(), { outDir: os.tmpdir(), name: "../agentshell" }),
    /--name may only contain/
  );
});
