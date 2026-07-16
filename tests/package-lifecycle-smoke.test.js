import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = "scripts/package-lifecycle-smoke.js";
const standaloneAvailable = fs.existsSync(path.resolve("bin", "agentshell-darwin-arm64"));

test("delivery package completes isolated install, doctor, update, and uninstall through its prebuilt CLI", {
  skip: !standaloneAvailable
}, () => {
  const result = spawnSync(process.execPath, [script, "--package-dir", process.cwd()], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 120_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.package-lifecycle-smoke.v1");
  assert.equal(output.packageVersion, "1.0.0");
  assert.deepEqual(output.steps.map(({ action }) => action), ["install", "doctor", "update", "uninstall"]);
  assert.equal(output.steps.every(({ ok }) => ok), true);
  assert.equal(output.steps.find(({ action }) => action === "doctor").checks.codex, true);
  assert.equal(output.summary.finalState, "uninstalled");
  assert.equal(output.externalCommands.some((command) => command.startsWith("codex plugin add")), true);
  assert.equal(output.externalCommands.some((command) => command.startsWith("launchctl ")), false);
});

test("package lifecycle dry run invokes the packaged CLI without writing installation state", {
  skip: !standaloneAvailable
}, () => {
  const result = spawnSync(process.execPath, [script, `--package-dir=${process.cwd()}`, "--dry-run"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 60_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.dryRun, true);
  assert.equal(output.summary.finalState, "unchanged");
  assert.equal(output.steps.find(({ action }) => action === "doctor").status, "skipped");
  assert.deepEqual(output.steps.filter(({ action }) => action !== "doctor").map(({ action }) => action), ["install", "update", "uninstall"]);
});

test("package lifecycle smoke returns compact diagnostics for an invalid delivery directory", () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-invalid-package-"));
  const result = spawnSync(process.execPath, [script, "--package-dir", packageDir], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.error.code, "PREBUILT_CLI_MISSING");
  assert.equal(output.summary.total, 0);
});

test("package exposes the delivery lifecycle smoke script", () => {
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(packageJson.scripts?.["package:lifecycle:smoke"], "node scripts/package-lifecycle-smoke.js");
});
