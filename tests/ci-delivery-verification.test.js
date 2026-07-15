import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findPathLeaks, verifyReleaseArtifacts } from "./ci-verify-release-artifacts.js";

test("CI release verification accepts an audited package and pinned toolchain", () => {
  const fixture = createReleaseFixture();
  try {
    const result = verifyReleaseArtifacts({
      directory: fixture,
      requireToolchain: true,
      nodeVersion: "20.20.2",
      bunVersion: "1.2.20"
    });
    assert.equal(result.ok, true);
    assert.equal(result.lifecycleSteps, 4);
    assert.equal(result.pathLeaks, 0);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("CI release verification blocks checksum, size report, and toolchain drift", () => {
  const fixture = createReleaseFixture();
  try {
    fs.appendFileSync(path.join(fixture, "agentshell-codex-plugin.zip"), "drift");
    assert.throws(() => verifyReleaseArtifacts({ directory: fixture }), /sha256.*invalid/i);

    const clean = createReleaseFixture();
    try {
      assert.throws(() => verifyReleaseArtifacts({
        directory: clean,
        requireToolchain: true,
        nodeVersion: "20.20.2",
        bunVersion: "9.9.9"
      }), /unexpected standalone Bun version/);
    } finally {
      fs.rmSync(clean, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("CI path hygiene detects macOS, Linux, Windows, and GitHub runner paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-path-leak-"));
  try {
    fs.writeFileSync(path.join(root, "mac.txt"), ["", "Users", "alvin", "project"].join("/"));
    fs.writeFileSync(path.join(root, "linux.txt"), "/home/runner/project");
    fs.writeFileSync(path.join(root, "windows.txt"), "C:\\Users\\alvin\\project");
    fs.writeFileSync(path.join(root, "actions.txt"), "/__w/agentshell/agentshell");
    assert.deepEqual(findPathLeaks(root).map((entry) => entry.kind).sort(), [
      "GitHub workspace path",
      "Linux user path",
      "Windows user path",
      "macOS user path"
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workflows preserve the compatibility matrix and audit artifacts before publishing", () => {
  const ci = fs.readFileSync(".github/workflows/ci.yml", "utf8");
  const release = fs.readFileSync(".github/workflows/release.yml", "utf8");
  const gitignore = fs.readFileSync(".gitignore", "utf8");
  assert.match(ci, /os: \[ubuntu-latest, macos-latest\]/u);
  assert.match(ci, /node: \[20, 22\]/u);
  assert.match(ci, /npm run security:scan/u);
  assert.match(ci, /Prepare test-only standalone launcher[\s\S]*node scripts\/prepare-test-standalone\.js[\s\S]*npm test/u);
  assert.match(ci, /AGENTSHELL_TEST_STANDALONE_LAUNCHER: "1"/u);
  assert.match(ci, /package and run lifecycle smoke/u);
  assert.match(ci, /ci-verify-release-artifacts\.js/u);
  assert.match(ci, /actions\/upload-artifact@v4/u);
  assert.match(release, /node-version: 20\.20\.2/u);
  assert.match(release, /bun-version: 1\.2\.20/u);
  assert.match(release, /Prepare test-only standalone launcher[\s\S]*node scripts\/prepare-test-standalone\.js[\s\S]*npm test/u);
  assert.match(release, /AGENTSHELL_TEST_STANDALONE_LAUNCHER: "1"/u);
  assert.match(release, /gh release create/u);
  assert.match(release, /artifacts\/release\/agentshell-darwin-arm64/u);
  assert.match(release, /artifacts\/release\/agentshell-darwin-arm64\.sha256/u);
  assert.match(release, /artifacts\/release\/agentshell-codex-plugin\.zip/u);
  assert.match(release, /artifacts\/release\/agentshell-codex-plugin\.zip\.sha256/u);
  assert.match(gitignore, /^bin\/agentshell-darwin-arm64$/mu);
  assert.ok(release.indexOf("ci-verify-release-artifacts.js") < release.indexOf("gh release create"));
  assert.ok(release.indexOf("actions/upload-artifact@v4") < release.indexOf("gh release create"));
});

function createReleaseFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-ci-release-"));
  const packageDirectory = path.join(directory, "agentshell-codex-plugin");
  fs.mkdirSync(packageDirectory);
  fs.writeFileSync(path.join(packageDirectory, "README.md"), "portable package\n");
  const zip = path.join(directory, "agentshell-codex-plugin.zip");
  const standalone = path.join(directory, "agentshell-darwin-arm64");
  fs.writeFileSync(zip, "zip payload");
  fs.writeFileSync(standalone, "standalone payload");
  const zipSha256 = checksum(zip);
  const standaloneSha256 = checksum(standalone);
  fs.writeFileSync(path.join(directory, "release-report.json"), `${JSON.stringify({
    ok: true,
    protocolVersion: "agentshell.release-artifacts.v1",
    sha256: zipSha256,
    zipBytes: fs.statSync(zip).size,
    sizeBudgets: { ok: true, zip: { ok: true }, standalone: { ok: true } },
    compression: { archiveVerified: true },
    lifecycle: {
      protocolVersion: "agentshell.package-lifecycle-smoke.v1",
      summary: { passed: 4, finalState: "uninstalled" }
    },
    standalone: {
      sha256: standaloneSha256,
      bytes: fs.statSync(standalone).size,
      builder: { bundler: "bun", runtime: "node-sea", nodeVersion: "20.20.2", bunVersion: "1.2.20" }
    }
  }, null, 2)}\n`);
  return directory;
}

function checksum(file) {
  const value = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  fs.writeFileSync(`${file}.sha256`, `${value}  ${path.basename(file)}\n`);
  return value;
}
