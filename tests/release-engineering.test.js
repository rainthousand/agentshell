import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("security and release gates pass for the source tree", () => {
  const security = run("scripts/security-scan.js");
  const gate = runReleaseGate();
  assert.equal(security.ok, true);
  assert.equal(gate.ok, true);
  assert.equal(gate.checks.manifestMatchesPackage, true);
});

test("release gate ignores branch and pull request ref names", () => {
  const branch = runReleaseGate([], {
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_NAME: "main",
    GITHUB_REF_TYPE: "branch"
  });
  const pullRequest = runReleaseGate([], {
    GITHUB_REF: "refs/pull/42/merge",
    GITHUB_REF_NAME: "42/merge",
    GITHUB_REF_TYPE: "branch"
  });

  assert.equal(branch.ok, true);
  assert.equal(branch.tag, null);
  assert.equal(branch.checks.tagMatchesPackage, true);
  assert.equal(pullRequest.ok, true);
  assert.equal(pullRequest.tag, null);
  assert.equal(pullRequest.checks.tagMatchesPackage, true);
});

test("release gate strictly validates GitHub tag refs", () => {
  const expectedTag = `v${JSON.parse(fs.readFileSync("package.json", "utf8")).version}`;
  const matching = runReleaseGate([], {
    GITHUB_REF: `refs/tags/${expectedTag}`,
    GITHUB_REF_NAME: expectedTag,
    GITHUB_REF_TYPE: "tag"
  });
  const mismatched = spawnReleaseGate([], {
    GITHUB_REF: "refs/tags/v99.0.0",
    GITHUB_REF_NAME: "v99.0.0",
    GITHUB_REF_TYPE: "tag"
  });

  assert.equal(matching.ok, true);
  assert.equal(matching.tag, expectedTag);
  assert.equal(mismatched.status, 1);
  assert.equal(JSON.parse(mismatched.stdout).checks.tagMatchesPackage, false);
});

test("release gate strictly validates explicit tags", () => {
  const result = spawnReleaseGate(["--tag", "v99.0.0"], {
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_NAME: "main",
    GITHUB_REF_TYPE: "branch"
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).checks.tagMatchesPackage, false);
});

test("release gate rejects --tag without a value", () => {
  const result = spawnReleaseGate(["--tag"]);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).tag, null);
  assert.equal(JSON.parse(result.stdout).checks.tagMatchesPackage, false);
});

test("release artifacts include a verifiable SHA256 checksum", () => {
  const report = run("scripts/release-artifacts.js", {
    AGENTSHELL_SKIP_NATIVE_RELEASE_BUILD: "1"
  });
  const zip = path.resolve(report.zip);
  const actual = crypto.createHash("sha256").update(fs.readFileSync(zip)).digest("hex");
  assert.equal(actual, report.sha256);
  assert.match(fs.readFileSync(`${zip}.sha256`, "utf8"), new RegExp(`^${actual}`));

  const standalone = path.resolve(report.standalone.path);
  const standaloneActual = crypto.createHash("sha256").update(fs.readFileSync(standalone)).digest("hex");
  assert.equal(path.basename(standalone), "agentshell-darwin-arm64");
  assert.equal(standaloneActual, report.standalone.sha256);
  assert.match(fs.readFileSync(`${standalone}.sha256`, "utf8"), new RegExp(`^${standaloneActual}`));
  assert.notEqual(fs.statSync(standalone).mode & 0o111, 0);
  assert.equal(fs.existsSync(path.join(path.dirname(zip), "release-report.json")), true);
});

function run(script, env = {}) {
  const result = spawnSync("node", [script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function runReleaseGate(args = [], env = {}) {
  const result = spawnReleaseGate(args, env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function spawnReleaseGate(args = [], env = {}) {
  const cleanEnv = { ...process.env };
  delete cleanEnv.GITHUB_REF;
  delete cleanEnv.GITHUB_REF_NAME;
  delete cleanEnv.GITHUB_REF_TYPE;
  return spawnSync("node", ["scripts/release-gate.js", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...cleanEnv, ...env }
  });
}
