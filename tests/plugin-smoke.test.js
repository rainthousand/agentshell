import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { buildSharePackage } from "../scripts/share-package.js";

test("plugin smoke exposes JSON and markdown help", () => {
  const json = run(["--help"]);
  assert.equal(json.status, 0);
  assert.equal(JSON.parse(json.stdout).usage, "node scripts/plugin-smoke.js [--path <installedPath>] [--markdown]");

  const markdown = run(["--help", "--markdown"]);
  assert.equal(markdown.status, 0);
  assert.match(markdown.stdout, /^# AgentShell Plugin Smoke/m);
});

test("plugin smoke reports every failed slim-package check as structured JSON", () => {
  const result = run(["--path", path.join(os.tmpdir(), "agentshell-plugin-smoke-missing")]);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.protocolVersion, "agentshell.plugin-smoke.v1");
  assert.equal(report.summary.checks, 8);
  assert.equal(report.summary.failed > 0, true);
  assert.equal(report.checks.length, report.summary.checks);
});

test("plugin smoke validates the actual slim V1 delivery package", {
  skip: !fs.existsSync(path.resolve("bin", "agentshell-darwin-arm64"))
}, () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-plugin-smoke-package-"));
  const packaged = buildSharePackage(process.cwd(), {
    outDir,
    name: "agentshell-codex-plugin",
    auditOptions: { allowUntracked: true }
  });
  assert.equal(packaged.ok, true, JSON.stringify(packaged.sourceAudit));

  const result = run(["--path", packaged.packageDir]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.summary, { checks: 8, passed: 8, failed: 0 });
  assert.equal(report.checks.find((entry) => entry.name.includes("MCP is deferred"))?.ok, true);
});

function run(args) {
  return spawnSync(process.execPath, ["scripts/plugin-smoke.js", ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}
