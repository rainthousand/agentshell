import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findFile, parseFindFileOptions } from "../src/commands/find-file.js";

test("find file returns bounded categorized matches with safe read commands", async () => {
  const root = fixtureProject();

  const result = await findFile(root, "*.js", { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.find-file.v1");
  assert.equal(result.compact, true);
  assert.equal(result.summary.totalMatches, 3);
  assert.equal(result.summary.returnedMatches, 3);
  assert.equal(result.summary.truncated, false);
  assert.ok(result.summary.ignoredDirectories >= 2);
  assert.equal(result.summary.scanTruncated, false);
  assert.ok(result.summary.scannedEntries < result.summary.scanLimit);
  assert.deepEqual(result.files.map((entry) => entry.path), [
    "src/index.js",
    "tests/index.test.js",
    "docs/example.js"
  ]);
  assert.equal(result.files[0].category, "source");
  assert.equal(result.files[1].category, "test");
  assert.equal(result.files[2].category, "docs");
  assert.ok(result.files.every((entry) => Number.isInteger(entry.sizeBytes)));
  assert.equal(result.files.some((entry) => entry.path.includes("node_modules")), false);
  assert.match(result.files[0].readCommand, /^agentshell read src\/index\.js /);
});

test("find file supports substring patterns, scoped paths, and result limits", async () => {
  const root = fixtureProject();
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export const ts = true;\n");

  const result = await findFile(root, "index", { path: "src", limit: 1, compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.summary.totalMatches, 2);
  assert.equal(result.summary.returnedMatches, 1);
  assert.equal(result.summary.truncated, true);
  assert.equal(result.files[0].path, "src/index.js");
});

test("find file ignores artifact roots and caps total scanned entries", async () => {
  const root = fixtureProject();
  fs.mkdirSync(path.join(root, "artifacts", "external-repos", "fixture"), { recursive: true });
  for (let index = 0; index < 30; index += 1) {
    fs.writeFileSync(path.join(root, "artifacts", "external-repos", "fixture", `artifact-${index}.js`), "export {};\n");
  }

  const ignored = await findFile(root, "*.js", { compact: true });
  assert.equal(ignored.summary.totalMatches, 3);
  assert.equal(ignored.files.some((entry) => entry.path.startsWith("artifacts/")), false);

  const boundedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-find-file-bounded-"));
  for (let index = 0; index < 10; index += 1) {
    fs.writeFileSync(path.join(boundedRoot, `file-${index}.js`), "export {};\n");
  }
  const bounded = await findFile(boundedRoot, "*.js", { compact: true, maxEntries: 3, limit: 10 });
  assert.equal(bounded.summary.scannedEntries, 3);
  assert.equal(bounded.summary.scanLimit, 3);
  assert.equal(bounded.summary.scanTruncated, true);
  assert.equal(bounded.summary.truncated, true);
  assert.equal(bounded.files.length, 3);
  assert.ok(bounded.suggestedNextActions.some((action) => action.reason.includes("scan-entry limit")));
});

test("find file rejects missing patterns and paths outside the workspace", async () => {
  const root = fixtureProject();
  const missing = parseFindFileOptions(undefined, { compact: true });
  const outside = await findFile(root, "*.js", { path: "..", compact: true });
  const absent = await findFile(root, "*.js", { path: "missing", compact: true });

  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "INVALID_ARGUMENT");
  assert.equal(outside.ok, false);
  assert.equal(outside.error.code, "FILE_OUTSIDE_WORKSPACE");
  assert.equal(absent.ok, false);
  assert.equal(absent.error.code, "PATH_NOT_FOUND");
});

test("find file schema exposes the stable compact response", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/find-file.schema.json", "utf8"));
  assert.equal(schema.title, "AgentShell Find File Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.find-file.v1");
  assert.equal(schema.oneOf[0].properties.files.maxItems, 500);
  assert.deepEqual(schema.$defs.file.required, ["path", "name", "category", "sizeBytes", "risk", "readCommand"]);
});

function fixtureProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-find-file-"));
  for (const directory of ["src", "tests", "docs", "node_modules/pkg", "dist"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "src", "index.js"), "export const value = 1;\n");
  fs.writeFileSync(path.join(root, "tests", "index.test.js"), "export const test = true;\n");
  fs.writeFileSync(path.join(root, "docs", "example.js"), "export const docs = true;\n");
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(root, "dist", "bundle.js"), "console.log('generated');\n");
  return root;
}
