import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { tree } from "../src/commands/tree.js";

test("tree --compact returns a bounded project structure summary", async () => {
  const root = fixtureProject();

  const output = await tree(root, { compact: true });

  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.tree.v1");
  assert.equal(output.compact, true);
  assert.equal(output.root.name, path.basename(root));
  assert.equal(output.root.path, root);
  assert.ok(output.summary.directoryCount >= 4);
  assert.ok(output.summary.fileCount >= 4);
  assert.deepEqual(output.summary.importantDirectories.sort(), ["docs", "scripts", "src", "tests"]);
  assert.ok(output.summary.entryFiles.includes("package.json"));
  assert.ok(output.summary.entryFiles.includes("go.mod"));
  assert.ok(output.summary.entryFiles.includes("src/cli.js"));
  assert.ok(output.directories.some((entry) => entry.path === "src" && entry.important));
  assert.ok(output.files.some((entry) => entry.path === "src/cli.js" && entry.entry));
  assert.ok(output.ignored.some((entry) => entry.path === "node_modules"));
  assert.ok(output.ignored.some((entry) => entry.path === "dist"));
  assert.ok(output.ignored.some((entry) => entry.path === ".git"));
  assert.ok(output.ignored.some((entry) => entry.path === "coverage"));
  assert.ok(output.suggestedNextActions.some((entry) => entry.command === "agentshell read package.json --lines 1:120"));
});

test("tree respects depth and result limits", async () => {
  const root = fixtureProject();
  fs.mkdirSync(path.join(root, "src", "deep", "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "deep", "nested", "hidden.js"), "export const hidden = true;\n");

  const output = await tree(root, {
    compact: true,
    maxDepth: 2,
    maxDirectories: 3,
    maxFiles: 2
  });

  assert.equal(output.ok, true);
  assert.equal(output.summary.maxDepth, 2);
  assert.ok(output.directories.length <= 3);
  assert.ok(output.files.length <= 2);
  assert.equal(output.truncated, true);
  assert.equal(output.files.some((entry) => entry.path === "src/deep/nested/hidden.js"), false);
});

function fixtureProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-tree-"));
  for (const dir of [
    "src",
    "tests",
    "docs",
    "scripts",
    "node_modules/pkg",
    "dist",
    "build",
    ".git",
    "coverage",
    ".cache"
  ]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
  fs.writeFileSync(path.join(root, "go.mod"), "module example.com/fixture\n\ngo 1.22\n");
  fs.writeFileSync(path.join(root, "README.md"), "# Fixture\n");
  fs.writeFileSync(path.join(root, "src", "cli.js"), "console.log('fixture');\n");
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(root, "tests", "cli.test.js"), "import test from 'node:test';\n");
  fs.writeFileSync(path.join(root, "docs", "intro.md"), "# Intro\n");
  fs.writeFileSync(path.join(root, "scripts", "build.js"), "console.log('build');\n");
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(root, "dist", "bundle.js"), "console.log('dist');\n");
  fs.writeFileSync(path.join(root, "coverage", "coverage.json"), "{}\n");
  return root;
}
