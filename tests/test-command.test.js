import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { testCommand } from "../src/commands/test-command.js";

test("test command recommends Node and Python commands without running them", async () => {
  const root = tempProject();
  writeJson(path.join(root, "package.json"), {
    scripts: {
      test: "node --test",
      "test:e2e": "playwright test"
    }
  });
  fs.writeFileSync(path.join(root, "pyproject.toml"), "[project]\nname = \"fixture\"\n");
  fs.mkdirSync(path.join(root, "tests"));
  fs.writeFileSync(path.join(root, "tests", "test_app.py"), "def test_ok():\n    assert True\n");

  const result = await testCommand(root, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.test-command.v1");
  assert.equal(result.summary.primaryCommand, "npm run test");
  assert.ok(result.commands.some((entry) => entry.command === "npm run test" && entry.ecosystem === "node"));
  assert.ok(result.commands.some((entry) => entry.command === "python -m pytest" && entry.ecosystem === "python"));
  assert.ok(result.risks.some((entry) => entry.type === "environment-dependent"));
});

test("test command prefers Java wrappers when present", async () => {
  const root = tempProject();
  fs.writeFileSync(path.join(root, "pom.xml"), "<project />\n");
  fs.writeFileSync(path.join(root, "mvnw"), "#!/bin/sh\n");

  const result = await testCommand(root, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.summary.primaryCommand, "./mvnw test");
  assert.ok(result.commands.some((entry) => entry.source === "pom.xml" && entry.confidence === "high"));
});

test("test command schema is parseable", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "test-command.schema.json"), "utf8"));
  assert.equal(schema.properties.protocolVersion.const, "agentshell.test-command.v1");
});

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-test-command-"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
