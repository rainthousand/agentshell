import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  STANDALONE_BUILD_PROTOCOL_VERSION,
  assertSeaBundleCompatibility,
  buildStandalone,
  parseBuildStandaloneArgs
} from "../scripts/build-standalone.js";

test("standalone bundle compatibility rejects Node 20 CJS hazards", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-bundle-check-"));
  const bundle = path.join(root, "agentshell.cjs");
  try {
    fs.writeFileSync(bundle, "const here = import.meta.dirname;\n");
    assert.throws(() => assertSeaBundleCompatibility(bundle, { packageRoot: root }), /import\.meta syntax/);

    fs.writeFileSync(bundle, `const root = ${JSON.stringify(root)};\n`);
    assert.throws(() => assertSeaBundleCompatibility(bundle, { packageRoot: root }), /build machine package path/);

    fs.writeFileSync(bundle, "module.exports = { ok: true };\n");
    assert.doesNotThrow(() => assertSeaBundleCompatibility(bundle, { packageRoot: root }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("standalone dry run describes the macOS arm64 artifact and smoke checks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-build-test-"));
  try {
    const result = buildStandalone({ dryRun: true }, { root, platform: "darwin", arch: "arm64" });
    assert.equal(result.ok, true);
    assert.equal(result.protocolVersion, STANDALONE_BUILD_PROTOCOL_VERSION);
    assert.equal(result.status, "dry-run");
    assert.equal(result.target, "darwin-arm64");
    assert.equal(result.output, path.join(root, "bin", "agentshell-darwin-arm64"));
    assert.equal(result.runtimeDependency, false);
    assert.deepEqual(result.signing, { identity: "ad-hoc", status: "planned" });
    assert.equal(result.build.args.includes("--target=node"), true);
    assert.equal(result.build.args.includes("--format=cjs"), true);
    assert.deepEqual(result.build.args.slice(-2), ["--outfile", "<temporary>/agentshell.cjs"]);
    assert.deepEqual(result.smokeChecks.map((check) => check.name), ["version", "schema-list", "plugin-status"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("standalone parser accepts an explicit output and rejects incomplete options", () => {
  assert.deepEqual(parseBuildStandaloneArgs(["--dry-run", "--out", "dist/agentshell"]), {
    dryRun: true,
    out: "dist/agentshell"
  });
  assert.throws(() => parseBuildStandaloneArgs(["--out"]), /requires a file path/);
  assert.throws(() => parseBuildStandaloneArgs(["--unknown"]), /Unknown option/);
});

test("standalone build rejects unsupported targets before invoking Bun", () => {
  let invoked = false;
  assert.throws(() => buildStandalone({}, {
    platform: "linux",
    arch: "x64",
    run() {
      invoked = true;
    }
  }), /macOS arm64 only/);
  assert.equal(invoked, false);
});

test("standalone CLI emits a versioned dry-run report", () => {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;
  const result = spawnSync("node", ["scripts/build-standalone.js", "--dry-run"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.protocolVersion, STANDALONE_BUILD_PROTOCOL_VERSION);
  assert.equal(payload.runtimeDependency, false);
});

test("real standalone build is opt-in", { skip: process.env.AGENTSHELL_TEST_STANDALONE !== "1" }, () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-real-build-"));
  try {
    const result = spawnSync("node", ["scripts/build-standalone.js", "--out", path.join(outputRoot, "agentshell")], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "built");
    assert.equal(payload.runtimeDependency, false);
    assert.equal(payload.smokeChecks.every((check) => check.ok), true);
    assert.match(payload.sha256, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});
