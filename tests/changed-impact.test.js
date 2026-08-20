import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { changedImpact } from "../src/commands/changed-impact.js";

test("changed impact summarizes changed source, tests, config, and lockfiles", async () => {
  const root = tempProject();
  spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "tests"));
  writeJson(path.join(root, "package.json"), { scripts: { test: "node --test" } });
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const ok = true;\n");
  fs.writeFileSync(path.join(root, "tests", "app.test.js"), "import 'node:test';\n");

  const result = await changedImpact(root, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.changed-impact.v1");
  assert.equal(result.summary.changedFiles, 4);
  assert.ok(result.impacts.some((entry) => entry.area === "runtime-behavior"));
  assert.ok(result.impacts.some((entry) => entry.area === "dependency-resolution"));
  assert.ok(result.suggestedNextActions.some((entry) => entry.command === "npm run test"));
});

test("changed impact schema is parseable", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "changed-impact.schema.json"), "utf8"));
  assert.equal(schema.properties.protocolVersion.const, "agentshell.changed-impact.v1");
});

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-changed-impact-"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
