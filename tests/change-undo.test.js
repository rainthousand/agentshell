import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cli = path.resolve("src/cli.js");

test("change applies a hash-checked edit and undo restores it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-change-"));
  fs.writeFileSync(path.join(dir, "target.js"), "export const value = 1;\n");

  const read = run(dir, ["read", "target.js", "--lines", "1:1"]);
  assert.equal(read.status, 0);
  const readOutput = JSON.parse(read.stdout);
  assert.equal(readOutput.ok, true);

  fs.writeFileSync(path.join(dir, "change.json"), JSON.stringify({
    reason: "Update value",
    edits: [{
      file: "target.js",
      expectedHash: readOutput.hash,
      range: { start: 1, end: 1 },
      replacement: "export const value = 2;"
    }]
  }));

  const changed = run(dir, ["change", "change.json"]);
  assert.equal(changed.status, 0);
  const changedOutput = JSON.parse(changed.stdout);
  assert.equal(changedOutput.ok, true);
  assert.deepEqual(changedOutput.changedFiles, ["target.js"]);
  assert.equal(fs.readFileSync(path.join(dir, "target.js"), "utf8"), "export const value = 2;\n");

  const history = run(dir, ["history"]);
  const historyOutput = JSON.parse(history.stdout);
  assert.equal(historyOutput.ok, true);
  assert.equal(historyOutput.operations[0].type, "change");

  const undone = run(dir, ["undo"]);
  assert.equal(undone.status, 0);
  const undoneOutput = JSON.parse(undone.stdout);
  assert.equal(undoneOutput.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, "target.js"), "utf8"), "export const value = 1;\n");
});

test("change rejects stale hashes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-stale-"));
  fs.writeFileSync(path.join(dir, "target.js"), "export const value = 1;\n");

  fs.writeFileSync(path.join(dir, "change.json"), JSON.stringify({
    edits: [{
      file: "target.js",
      expectedHash: "sha256:not-current",
      range: { start: 1, end: 1 },
      replacement: "export const value = 2;"
    }]
  }));

  const changed = run(dir, ["change", "change.json"]);
  assert.equal(changed.status, 1);
  const output = JSON.parse(changed.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.error.code, "HASH_MISMATCH");
  assert.equal(fs.readFileSync(path.join(dir, "target.js"), "utf8"), "export const value = 1;\n");
});

test("change fill applies a generated template with --apply", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-fill-"));
  fs.mkdirSync(path.join(dir, ".agentshell", "change-templates"), { recursive: true });
  fs.writeFileSync(path.join(dir, "target.js"), "export const value = 1;\n");

  const read = run(dir, ["read", "target.js", "--lines", "1:1"]);
  const readOutput = JSON.parse(read.stdout);
  const templatePath = path.join(dir, ".agentshell", "change-templates", "change_test.json");
  fs.writeFileSync(templatePath, JSON.stringify({
    reason: "Update value",
    edits: [{
      file: "target.js",
      expectedHash: readOutput.hash,
      range: { start: 1, end: 1 },
      replacement: ""
    }]
  }));
  fs.writeFileSync(path.join(dir, "fill.json"), JSON.stringify({
    replacement: "export const value = 3;"
  }));

  const filled = run(dir, ["change", "fill", ".agentshell/change-templates/change_test.json", "fill.json", "--apply"]);
  assert.equal(filled.status, 0);
  const output = JSON.parse(filled.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.filledEdits, 1);
  assert.deepEqual(output.applied.changedFiles, ["target.js"]);
  assert.equal(fs.readFileSync(path.join(dir, "target.js"), "utf8"), "export const value = 3;\n");
});

function run(cwd, args) {
  return spawnSync("node", [cli, ...args], {
    cwd,
    encoding: "utf8"
  });
}
