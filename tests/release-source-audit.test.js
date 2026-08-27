import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  auditReleaseSource,
  isRuntimeDeliveryPath
} from "../scripts/release-source-audit.js";

const manifest = {
  exact: ["package.json", "bin/agentshell"],
  prefixes: ["src/", "skills/"],
  excludedPrefixes: ["src/mcp/"],
  excludedExact: ["bin/agentshell-mcp"],
  generated: ["bin/agentshell-darwin-arm64"]
};

test("release source audit produces a bounded tracked delivery set", () => {
  const dir = fixtureTree();
  const trackedFiles = ["package.json", "bin/agentshell", "src/cli.js", "skills/agentshell/SKILL.md"];
  const report = auditReleaseSource(dir, { manifest, trackedFiles, worktreeFiles: trackedFiles });

  assert.equal(report.ok, true);
  assert.deepEqual(report.deliveryFiles, [
    "bin/agentshell",
    "bin/agentshell-darwin-arm64",
    "package.json",
    "skills/agentshell/SKILL.md",
    "src/cli.js"
  ]);
  assert.equal(report.deliveryFiles.includes("tests/fixture.test.js"), false);
});

test("release source audit blocks untracked runtime files", () => {
  const dir = fixtureTree();
  fs.writeFileSync(path.join(dir, "src", "new-runtime.js"), "export {};\n");
  const trackedFiles = ["package.json", "bin/agentshell", "src/cli.js", "skills/agentshell/SKILL.md"];
  const report = auditReleaseSource(dir, {
    manifest,
    trackedFiles,
    worktreeFiles: [...trackedFiles, "src/new-runtime.js"]
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.untrackedIncludedFiles, ["src/new-runtime.js"]);
});

test("runtime manifest excludes deferred MCP and unrelated development files", () => {
  assert.equal(isRuntimeDeliveryPath("src/cli.js", manifest), true);
  assert.equal(isRuntimeDeliveryPath("src/mcp/server.js", manifest), false);
  assert.equal(isRuntimeDeliveryPath("bin/agentshell-mcp", manifest), false);
  assert.equal(isRuntimeDeliveryPath("tests/cli.test.js", manifest), false);
});

function fixtureTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-release-source-"));
  for (const file of [
    "package.json",
    "bin/agentshell",
    "bin/agentshell-darwin-arm64",
    "src/cli.js",
    "skills/agentshell/SKILL.md",
    "tests/fixture.test.js"
  ]) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${file}\n`);
  }
  return dir;
}
