import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("security and release gates pass for the source tree", () => {
  const security = run("scripts/security-scan.js");
  const gate = run("scripts/release-gate.js");
  assert.equal(security.ok, true);
  assert.equal(gate.ok, true);
  assert.equal(gate.checks.manifestMatchesPackage, true);
});

test("release gate rejects a mismatched tag", () => {
  const result = spawnSync("node", ["scripts/release-gate.js", "--tag", "v99.0.0"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).checks.tagMatchesPackage, false);
});

test("release artifacts include a verifiable SHA256 checksum", () => {
  const report = run("scripts/release-artifacts.js");
  const zip = path.resolve(report.zip);
  const actual = crypto.createHash("sha256").update(fs.readFileSync(zip)).digest("hex");
  assert.equal(actual, report.sha256);
  assert.match(fs.readFileSync(`${zip}.sha256`, "utf8"), new RegExp(`^${actual}`));
  assert.equal(fs.existsSync(path.join(path.dirname(zip), "release-report.json")), true);
});

function run(script) {
  const result = spawnSync("node", [script], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
