import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { projectHealth } from "../src/commands/project-health.js";

test("project health summarizes tests, config, deps, and git state", async () => {
  const root = tempProject();
  spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
  writeJson(path.join(root, "package.json"), {
    dependencies: { vite: "^5.0.0" },
    scripts: { test: "node --test" }
  });
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), "name: ci\n");

  const result = await projectHealth(root, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.project-health.v1");
  assert.equal(result.summary.hasTestCommand, true);
  assert.equal(result.summary.primaryTestCommand, "npm run test");
  assert.equal(result.summary.hasCi, true);
  assert.equal(result.summary.dirty, true);
  assert.ok(result.suggestedNextActions.some((entry) => entry.command === "agentshell changed impact --compact"));
});

test("project health schema is parseable", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "project-health.schema.json"), "utf8"));
  assert.equal(schema.properties.protocolVersion.const, "agentshell.project-health.v1");
});

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-project-health-"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
