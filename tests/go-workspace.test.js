import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cli = path.join(process.cwd(), "src", "cli.js");
const realGo = spawnSync("go", ["version"], { encoding: "utf8" });
const hasGo = realGo.status === 0;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-go-workspace-"));
  const nested = path.join(root, "internal", "service");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(root, "go.mod"), "module example.com/agentshell/service\n\ngo 1.22\n");
  return { root, nested };
}

function run(command, cwd, env = process.env) {
  const result = spawnSync(process.execPath, [cli, command], {
    cwd,
    env,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("understand discovers Go module readiness from a nested directory", () => {
  const { root, nested } = fixture();
  try {
    const output = run("understand", nested);

    assert.equal(output.workspace.root, fs.realpathSync(root));
    assert.equal(output.workspace.name, "example.com/agentshell/service");
    assert.deepEqual(output.stack.languages, ["go"]);
    assert.equal(output.stack.packageManager, "go");
    assert.deepEqual(output.scripts, {
      test: "go test ./...",
      lint: "go vet ./...",
      build: "go build ./..."
    });
    assert.ok(output.suggestedNextActions.some((action) => action.command === "agentshell verify test"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("doctor reports a Go module even when the Go executable is unavailable", () => {
  const { root, nested } = fixture();
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-empty-bin-"));
  try {
    const output = run("doctor", nested, { ...process.env, PATH: emptyBin });
    const goCheck = output.checks.find((check) => check.name === "go");

    assert.equal(output.workspace.root, fs.realpathSync(root));
    assert.equal(output.package.found, true);
    assert.equal(output.package.manager, "go");
    assert.equal(output.package.kind, "go");
    assert.equal(output.package.manifest, "go.mod");
    assert.equal(output.package.scripts.test, "go test ./...");
    assert.equal(output.runtime.node.ok, true);
    assert.equal(output.runtime.go.available, false);
    assert.equal(output.runtime.go.version, null);
    assert.match(output.runtime.go.error, /ENOENT|failed/);
    assert.equal(goCheck.ok, false);
    assert.equal(goCheck.severity, "error");
    assert.equal(output.status, "blocked");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(emptyBin, { recursive: true, force: true });
  }
});

test("doctor reports the installed Go toolchain version", { skip: !hasGo }, () => {
  const { root } = fixture();
  try {
    const output = run("doctor", root);
    const goCheck = output.checks.find((check) => check.name === "go");

    assert.equal(output.runtime.go.available, true);
    assert.match(output.runtime.go.version, /^\d+\.\d+/);
    assert.equal(output.runtime.go.error, null);
    assert.equal(goCheck.ok, true);
    assert.match(goCheck.message, /^Go \d+\.\d+/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
