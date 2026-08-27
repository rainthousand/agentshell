import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cli = path.resolve("src/cli.js");

test("workspace guard and compare-search are available through the public CLI", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-workspace-cli-"));
  const first = makeGitRoot(parent, "first");
  const second = makeGitRoot(parent, "second");
  fs.writeFileSync(path.join(first, "service.go"), "package service // SharedSymbol\n");
  fs.writeFileSync(path.join(second, "service.php"), "<?php // SharedSymbol\n");

  const guarded = invoke(first, ["workspace", "guard", "--root", first, "--root", second, "--compact"]);
  assert.equal(guarded.status, 0, guarded.stderr);
  const guard = JSON.parse(guarded.stdout);
  assert.equal(guard.protocolVersion, "agentshell.workspace-guard.v1");
  assert.equal(guard.summary.repositoryCount, 2);
  assert.doesNotMatch(guarded.stdout, new RegExp(escapeRegExp(parent)));

  const searched = invoke(first, [
    "compare-search", "SharedSymbol", "--root", first, "--root", second,
    "--fixed-strings", "--compact"
  ]);
  assert.equal(searched.status, 0, searched.stderr);
  const search = JSON.parse(searched.stdout);
  assert.equal(search.protocolVersion, "agentshell.compare-search.v1");
  assert.equal(search.summary.rootsWithMatches, 2);
  assert.deepEqual(search.roots.map((root) => root.rootId), ["root-1", "root-2"]);
});

test("verify changed plans by default and inline boundary rules block matching changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-change-cli-"));
  run("git", ["init", "-q"], root);
  fs.mkdirSync(path.join(root, "restricted"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "fixture",
    scripts: { test: "node --test" }
  }));
  fs.writeFileSync(path.join(root, "restricted", "change.js"), "export const changed = true;\n");

  const planned = invoke(root, ["verify", "changed", "--compact"]);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.protocolVersion, "agentshell.verify-changed.v1");
  assert.equal(plan.mode, "plan");
  assert.equal(plan.executions.length, 0);

  const checked = invoke(root, ["boundary", "check", "--deny", "restricted", "--compact"]);
  assert.equal(checked.status, 1, checked.stderr);
  const boundary = JSON.parse(checked.stdout);
  assert.equal(boundary.protocolVersion, "agentshell.boundary-check.v1");
  assert.equal(boundary.summary.violationCount, 1);
  assert.equal(boundary.violations[0].file, "restricted/change.js");
});

test("verify go exposes structured selectors without shell interpolation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-go-cli-"));
  fs.writeFileSync(path.join(root, "go.mod"), "module example.test/fixture\n\ngo 1.22\n");
  fs.writeFileSync(path.join(root, "value_test.go"), [
    "package fixture",
    "import \"testing\"",
    "func TestValue(t *testing.T) {}",
    ""
  ].join("\n"));

  const verified = invoke(root, [
    "verify", "go", "--packages", "./...", "--run", "^TestValue$",
    "--count", "1", "--timeout", "30s", "--compact"
  ]);
  assert.equal(verified.status, 0, verified.stderr);
  const result = JSON.parse(verified.stdout);
  assert.equal(result.protocolVersion, "agentshell.verify-go.v1");
  assert.equal(result.ok, true);
  assert.equal(result.command.shellInterpolation, false);
  assert.ok(result.command.args.includes("-run=^TestValue$"));
});

function makeGitRoot(parent, name) {
  const root = path.join(parent, name);
  fs.mkdirSync(root);
  run("git", ["init", "-q"], root);
  return root;
}

function invoke(root, args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
