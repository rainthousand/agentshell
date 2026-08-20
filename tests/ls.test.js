import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listDirectory, ls } from "../src/commands/ls.js";

test("ls summarizes manifests, tests, generated directories, and hidden entries", async () => {
  const root = fixtureProject();

  const result = await ls(root, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.ls.v1");
  assert.equal(result.compact, true);
  assert.equal(result.path, ".");
  assert.equal(result.summary.totalEntries, 7);
  assert.equal(result.summary.files, 3);
  assert.equal(result.summary.directories, 4);
  assert.equal(result.summary.hidden, 1);
  assert.deepEqual(result.summary.manifests, ["package.json"]);
  assert.deepEqual(result.summary.tests, ["tests"]);
  assert.deepEqual(result.summary.generated.sort(), ["dist", "node_modules"]);
  assert.ok(result.entries.find((entry) => entry.name === "src").important);
  assert.ok(result.entries.find((entry) => entry.name === ".env.example").hidden);
  assert.ok(result.suggestedNextActions.some((action) => action.command.includes("package.json")));
});

test("ls supports safe subdirectory listing and bounded output", async () => {
  const root = fixtureProject();
  for (let index = 0; index < 10; index += 1) {
    fs.writeFileSync(path.join(root, "src", `file-${index}.js`), "export {};\n");
  }

  const result = await listDirectory(root, "src", { compact: true, limit: 3 });

  assert.equal(result.ok, true);
  assert.equal(result.path, "src");
  assert.equal(result.summary.totalEntries, 11);
  assert.equal(result.summary.returnedEntries, 3);
  assert.equal(result.summary.truncated, true);
  assert.equal(result.entries.length, 3);
});

test("ls rejects outside, missing, and non-directory paths", async () => {
  const root = fixtureProject();
  const outside = await listDirectory(root, "..");
  const missing = await listDirectory(root, "missing");
  const file = await listDirectory(root, "package.json");

  assert.equal(outside.ok, false);
  assert.equal(outside.error.code, "FILE_OUTSIDE_WORKSPACE");
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "PATH_NOT_FOUND");
  assert.equal(file.ok, false);
  assert.equal(file.error.code, "NOT_A_DIRECTORY");
});

test("ls schema exposes bounded entry metadata", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/ls.schema.json", "utf8"));
  assert.equal(schema.title, "AgentShell List Directory Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.ls.v1");
  assert.equal(schema.oneOf[0].properties.entries.maxItems, 500);
  assert.ok(schema.$defs.entry.required.includes("generated"));
});

function fixtureProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-ls-"));
  for (const directory of ["src", "tests", "dist", "node_modules"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  fs.writeFileSync(path.join(root, "README.md"), "# Fixture\n");
  fs.writeFileSync(path.join(root, ".env.example"), "SAFE=true\n");
  fs.writeFileSync(path.join(root, "src", "index.js"), "export {};\n");
  return root;
}
