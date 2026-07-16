import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runV1CleanMachineSmoke } from "../scripts/v1-clean-machine-smoke.js";

function fakePackage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-clean-package-"));
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.0.0" }));
  fs.writeFileSync(path.join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "agentshell", version: "1.0.0" }));
  const binary = path.join(root, "bin", "agentshell-darwin-arm64");
  fs.writeFileSync(binary, `#!${process.execPath}
const fs = require("node:fs"); const path = require("node:path");
const args = process.argv.slice(2); const home = args[args.indexOf("--home") + 1] || process.env.HOME;
const action = args[2]; const dry = args.includes("--dry-run");
if (args[0] === "dashboard") console.log(JSON.stringify({ok:true,protocolVersion:"agentshell.dashboard-control.v1",status:"stopped",running:false}));
else if (action === "install" || action === "update") {
  if (!dry) { const target=path.join(home,".local/bin/agentshell"); fs.mkdirSync(path.dirname(target),{recursive:true}); fs.copyFileSync(process.argv[1],target); fs.chmodSync(target,0o755); fs.mkdirSync(path.join(home,"plugins/agentshell"),{recursive:true}); fs.mkdirSync(path.join(home,".agentshell"),{recursive:true}); fs.writeFileSync(path.join(home,".agentshell/standalone-install.json"),"{}"); }
  console.log(JSON.stringify({ok:true,protocolVersion:"agentshell.setup-codex.v1",action}));
} else if (action === "doctor") console.log(JSON.stringify({ok:true,protocolVersion:"agentshell.setup-codex.v1",action,checks:{plugin:true,nativeCli:true,codex:true},dashboardService:{status:"skipped"}}));
else if (action === "uninstall") { if(!dry){fs.rmSync(path.join(home,".local/bin/agentshell"),{force:true});fs.rmSync(path.join(home,"plugins/agentshell"),{recursive:true,force:true});fs.rmSync(path.join(home,".agentshell/standalone-install.json"),{force:true});} console.log(JSON.stringify({ok:true,protocolVersion:"agentshell.setup-codex.v1",action})); }
else process.exit(2);
`, { mode: 0o755 });
  return root;
}

test("V1 smoke verifies an isolated install through uninstall lifecycle", () => {
  const packageDir = fakePackage();
  try {
    const report = runV1CleanMachineSmoke({ packageDir });
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.protocolVersion, "agentshell.v1-clean-machine-smoke.v1");
    assert.deepEqual(report.steps.map((step) => step.name), ["install", "doctor", "update", "dashboard-status", "uninstall"]);
    assert.equal(report.steps.find((step) => step.name === "doctor").dashboardServiceStatus, "skipped");
    assert.equal(report.summary.finalState, "uninstalled");
    assert.equal(report.isolation.developerHomeUsed, false);
    assert.doesNotMatch(JSON.stringify(report), new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally { fs.rmSync(packageDir, { recursive: true, force: true }); }
});

test("V1 smoke dry-run makes no managed installation", () => {
  const packageDir = fakePackage();
  try {
    const report = runV1CleanMachineSmoke({ packageDir, dryRun: true });
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.dryRun, true);
    assert.equal(report.summary.finalState, "unchanged");
    assert.deepEqual(report.steps.map((step) => step.name), ["install", "update", "dashboard-status", "uninstall"]);
  } finally { fs.rmSync(packageDir, { recursive: true, force: true }); }
});

test("V1 smoke requires an explicit delivery package", () => {
  const report = runV1CleanMachineSmoke({});
  assert.equal(report.ok, false);
  assert.equal(report.error.code, "PACKAGE_DIR_REQUIRED");
  assert.equal(report.summary.total, 0);
});
