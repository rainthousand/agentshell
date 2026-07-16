import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  RELEASE_SIZE_BUDGETS,
  assertStandaloneBuildReport,
  buildReleaseArtifacts,
  evaluateReleaseSizeBudgets,
  inspectArtifactToolchain,
  runLifecycleGate
} from "../scripts/release-artifacts.js";

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

test("release artifacts include a verifiable SHA256 checksum", {
  skip: !fs.existsSync(path.resolve("bin", "agentshell-darwin-arm64"))
}, () => {
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
  assert.equal(report.lifecycle.protocolVersion, "agentshell.package-lifecycle-smoke.v1");
  assert.equal(report.lifecycle.packageDir, path.join(path.dirname(zip), "agentshell-codex-plugin"));
  assert.equal(report.lifecycle.summary.finalState, "uninstalled");
  assert.equal(report.lifecycle.summary.passed, 4);
  assert.equal(report.zipBytes, fs.statSync(zip).size);
  assert.equal(report.standalone.bytes, fs.statSync(standalone).size);
  assert.ok(report.packageBytes >= report.standalone.bytes);
  assert.equal(report.compressionRatio, report.zipBytes / report.packageBytes);
  assert.equal(report.zipToStandaloneRatio, report.zipBytes / report.standalone.bytes);
  assert.equal(report.compression.level, 9);
  assert.equal(report.compression.archiveVerified, true);
  assert.equal(report.sizeBudgets.ok, true);
});

test("release artifacts retain standalone builder metadata and packaging metrics", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-release-report-"));
  const outDir = path.join(projectRoot, "release");
  const binary = Buffer.alloc(20, 1);
  fs.mkdirSync(path.join(projectRoot, "bin"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "bin", "agentshell-darwin-arm64"), binary);

  try {
    const report = buildReleaseArtifacts({
      projectRoot,
      outDir,
      platform: "darwin",
      arch: "arm64",
      nodeVersion: "20.20.2",
      runner(command, args) {
        if (command === "bun" && args[0] === "--version") return { status: 0, stdout: "1.2.20\n", stderr: "" };
        if (command === "npm" && args.includes("dashboard:build-app")) return success({ ok: true });
        if (command === "npm" && args.includes("build:standalone")) {
          return success({
            ok: true,
            protocolVersion: "agentshell.standalone-build.v1",
            status: "built",
            sha256: crypto.createHash("sha256").update(binary).digest("hex"),
            builder: { bundler: "bun", bunVersion: "1.2.20", runtime: "node-sea", nodeVersion: "20.20.2" },
            toolchain: {
              actual: { nodeVersion: "20.20.2", bunVersion: "1.2.20" },
              enforcement: "strict",
              ok: true
            }
          }, "\n> build:standalone\n");
        }
        if (command === "node" && args[0] === "scripts/share-package.js") {
          const deliveryDir = path.join(outDir, "agentshell-codex-plugin");
          fs.mkdirSync(deliveryDir, { recursive: true });
          fs.writeFileSync(path.join(deliveryDir, "payload"), binary);
          fs.writeFileSync(path.join(outDir, "agentshell-codex-plugin.zip"), Buffer.alloc(8, 2));
          return success({ ok: true, zip: { compressionLevel: 9, verification: { ok: true } } });
        }
        if (command === "npm" && args.includes("package:lifecycle:smoke")) {
          return success({
            ok: true,
            protocolVersion: "agentshell.package-lifecycle-smoke.v1",
            packageVersion: "0.0.0",
            packageDir: path.join(outDir, "agentshell-codex-plugin"),
            summary: { passed: 4, finalState: "uninstalled" }
          });
        }
        return { status: 1, stdout: "", stderr: `unexpected command: ${command} ${args.join(" ")}` };
      }
    });

    assert.equal(report.standalone.buildReport.protocolVersion, "agentshell.standalone-build.v1");
    assert.deepEqual(report.standalone.builder, {
      bundler: "bun",
      bunVersion: "1.2.20",
      runtime: "node-sea",
      nodeVersion: "20.20.2"
    });
    assert.equal(report.toolchain.ok, true);
    assert.equal(report.toolchain.enforcement, "strict");
    assert.equal(report.standalone.sourceSha256, report.standalone.sha256);
    assert.equal(report.standalone.bytes, 20);
    assert.equal(report.zipBytes, 8);
    assert.equal(report.packageBytes, 20);
    assert.equal(report.compressionRatio, 0.4);
    assert.equal(report.zipToStandaloneRatio, 0.4);
    assert.equal(report.compression.level, 9);
    assert.equal(report.compression.archiveVerified, true);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("release artifacts reject unsupported build hosts before running build commands", () => {
  const calls = [];
  assert.throws(() => buildReleaseArtifacts({
    projectRoot: "/tmp/agentshell-release-toolchain-test",
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "22.0.0",
    runner(command, args) {
      calls.push([command, ...args]);
      if (command === "bun") return { status: 0, stdout: "1.2.20", stderr: "" };
      return { status: 1, stdout: "", stderr: "unexpected" };
    }
  }), /Unsupported release toolchain/);
  assert.deepEqual(calls, [["bun", "--version"]]);
});

test("skipped native builds report toolchain status without blocking developer packaging", () => {
  const report = inspectArtifactToolchain({
    projectRoot: process.cwd(),
    runner() { throw new Error("Bun must not be invoked"); },
    nodeVersion: "22.0.0",
    enforce: false
  });
  assert.equal(report.ok, false);
  assert.equal(report.status, "incomplete");
  assert.equal(report.enforcement, "informational");
});

test("standalone build attestation rejects stale builder metadata", () => {
  assert.throws(() => assertStandaloneBuildReport({
    protocolVersion: "agentshell.standalone-build.v1",
    status: "built",
    sha256: "a".repeat(64),
    builder: { nodeVersion: "22.0.0", bunVersion: "1.2.20" },
    toolchain: {
      actual: { nodeVersion: "20.20.2", bunVersion: "1.2.20" },
      enforcement: "strict",
      ok: true
    }
  }), /Unsupported release toolchain/);
});

test("standalone build attestation requires a strict digest-bearing report", () => {
  assert.throws(() => assertStandaloneBuildReport({
    protocolVersion: "agentshell.standalone-build.v1",
    status: "dry-run",
    builder: { nodeVersion: "20.20.2", bunVersion: "1.2.20" }
  }), /not a completed/);
});

test("release artifact size budgets accept their limits and reject either overage", () => {
  const atLimit = evaluateReleaseSizeBudgets(RELEASE_SIZE_BUDGETS);
  assert.equal(atLimit.ok, true);
  assert.equal(atLimit.standalone.limitBytes, 100 * 1024 * 1024);
  assert.equal(atLimit.zip.limitBytes, 40 * 1024 * 1024);

  const standaloneOver = evaluateReleaseSizeBudgets({
    standaloneBytes: RELEASE_SIZE_BUDGETS.standaloneBytes + 1,
    zipBytes: RELEASE_SIZE_BUDGETS.zipBytes
  });
  const zipOver = evaluateReleaseSizeBudgets({
    standaloneBytes: RELEASE_SIZE_BUDGETS.standaloneBytes,
    zipBytes: RELEASE_SIZE_BUDGETS.zipBytes + 1
  });
  assert.equal(standaloneOver.ok, false);
  assert.equal(standaloneOver.standalone.ok, false);
  assert.equal(zipOver.ok, false);
  assert.equal(zipOver.zip.ok, false);
});

test("release artifacts block when packaged lifecycle smoke fails", () => {
  const deliveryDir = path.join(process.cwd(), "artifacts", "release", "agentshell-codex-plugin");
  assert.throws(() => runLifecycleGate(deliveryDir, {
    runner(command, args) {
      assert.equal(command, "npm");
      assert.deepEqual(args, ["run", "package:lifecycle:smoke", "--", "--package-dir", deliveryDir]);
      return { status: 1, stdout: '{"ok":false}', stderr: "lifecycle failed" };
    }
  }), /lifecycle failed/);
});

test("release artifacts block malformed lifecycle output", () => {
  assert.throws(() => runLifecycleGate("/tmp/delivery", {
    runner() {
      return { status: 0, stdout: "not json", stderr: "" };
    }
  }), /Packaged install lifecycle smoke failed/);
});

test("core release workflow publishes audited assets without Apple credentials or installer packages", () => {
  const release = fs.readFileSync(".github/workflows/release.yml", "utf8");
  assert.doesNotMatch(release, /APPLE_DEVELOPER_ID|APPLE_NOTARY|notarize-release|stapler|\.pkg/u);
  assert.match(release, /agentshell-codex-plugin\.zip\.sha256/u);
  assert.match(release, /agentshell-darwin-arm64\.sha256/u);
  assert.match(release, /release-report\.json/u);
  assert.ok(release.indexOf("Verify release payload") < release.indexOf("gh release create"));
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

function success(report, prefix = "") {
  return { status: 0, stdout: `${prefix}${JSON.stringify(report, null, 2)}\n`, stderr: "" };
}
