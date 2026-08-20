import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { diskUsage, du } from "../src/commands/du.js";

test("du returns bounded largest entries and excludes generated noise", async () => {
  const root = fixtureProject();
  const output = await du(root, { compact: true, limit: 2 });

  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.du.v1");
  assert.equal(output.compact, true);
  assert.equal(output.root.path, ".");
  assert.equal(output.summary.totalSizeBytes, 70 * 1024 + 20);
  assert.equal(output.summary.fileCount, 3);
  assert.ok(output.summary.directoryCount >= 3);
  assert.equal(output.summary.excludedCount, 3);
  assert.ok(output.largestFiles.length <= 2);
  assert.equal(output.largestFiles[0].path, "src/large.log");
  assert.equal(output.largestFiles[0].tokenNoiseRisk, "medium");
  assert.ok(output.largestDirectories.some((entry) => entry.path === "src"));
  assert.equal(new Set(output.largestDirectories.map((entry) => entry.path)).size, output.largestDirectories.length);
  assert.deepEqual(output.excluded.map((entry) => entry.path), [".git", "dist"]);
  assert.ok(output.excluded.every((entry) => entry.generated));
  assert.equal(output.truncated, true);
  assert.ok(output.suggestedNextActions.length <= 3);
});

test("du respects scan bounds and rejects unsafe targets", async () => {
  const root = fixtureProject();
  for (let index = 0; index < 140; index += 1) {
    fs.writeFileSync(path.join(root, "src", `item-${index}.txt`), "x");
  }

  const bounded = await diskUsage(root, { maxScannedEntries: 100, limit: 50 });
  const outside = await du(root, { path: "../outside" });
  const missing = await du(root, { path: "missing" });
  const file = await du(root, { path: "README.md" });

  assert.equal(bounded.truncated, true);
  assert.equal(bounded.summary.scannedEntries, 100);
  assert.ok(bounded.largestFiles.length <= 50);
  assert.equal(outside.ok, false);
  assert.equal(outside.error.code, "PATH_OUTSIDE_WORKSPACE");
  assert.equal(missing.error.code, "PATH_NOT_FOUND");
  assert.equal(file.error.code, "PATH_NOT_DIRECTORY");
});

test("du schema exposes a bounded compact response contract", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/du.schema.json", "utf8"));

  assert.equal(schema.title, "AgentShell Disk Usage Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.du.v1");
  assert.equal(schema.oneOf[0].properties.largestFiles.maxItems, 50);
  assert.equal(schema.oneOf[0].properties.excluded.maxItems, 50);
  assert.deepEqual(schema.$defs.noiseRisk.enum, ["low", "medium", "high"]);
});

function fixtureProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-du-"));
  for (const directory of ["src", "docs", ".git", "dist", "node_modules/pkg"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "README.md"), "x".repeat(10));
  fs.writeFileSync(path.join(root, "src", "small.js"), "x".repeat(10));
  fs.writeFileSync(path.join(root, "src", "large.log"), "x".repeat(70 * 1024));
  fs.writeFileSync(path.join(root, ".git", "large.pack"), "x".repeat(512 * 1024));
  fs.writeFileSync(path.join(root, "dist", "bundle.js"), "x".repeat(256 * 1024));
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "x".repeat(128 * 1024));
  return root;
}
