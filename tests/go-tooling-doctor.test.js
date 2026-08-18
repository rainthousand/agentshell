import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cli = path.join(process.cwd(), "src", "cli.js");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-go-tools-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeExecutable(file, body) {
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function runDoctor(cwd, binDir) {
  const result = spawnSync(process.execPath, [cli, "doctor"], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: binDir
    }
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("doctor reports installed optional Go tools without affecting status", () => {
  withTempDir((dir) => {
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/tools\n\ngo 1.22\n");
    writeExecutable(path.join(binDir, "go"), 'echo "go version go1.22.5 test/platform"');
    writeExecutable(path.join(binDir, "golangci-lint"), 'echo "golangci-lint has version 1.59.1 built with go1.22"');
    writeExecutable(path.join(binDir, "goimports"), 'echo "goimports version v0.24.0" >&2');

    const output = runDoctor(dir, binDir);

    assert.deepEqual(output.runtime.go.tools, {
      golangciLint: {
        available: true,
        version: "golangci-lint has version 1.59.1 built with go1.22",
        path: path.join(binDir, "golangci-lint")
      },
      goimports: {
        available: true,
        version: "goimports version v0.24.0",
        path: path.join(binDir, "goimports")
      }
    });
    assert.equal(output.status, "warning");
    assert.equal(output.summary.errorCount, 0);
    assert.equal(output.summary.warningCount, 1);
    assert.equal(output.checks.some((check) => check.name.includes("golangci")), false);
    assert.equal(output.checks.some((check) => check.name.includes("goimports")), false);
  });
});

test("missing optional Go tools are non-blocking and compactly reported", () => {
  withTempDir((dir) => {
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/missing-tools\n\ngo 1.22\n");
    writeExecutable(path.join(binDir, "go"), 'echo "go version go1.22.5 test/platform"');

    const output = runDoctor(dir, binDir);

    assert.deepEqual(output.runtime.go.tools, {
      golangciLint: { available: false },
      goimports: { available: false }
    });
    assert.equal(output.status, "warning");
    assert.equal(output.summary.errorCount, 0);
    assert.equal(output.summary.warningCount, 1);
  });
});

test("Node-only doctor output does not expose Go tooling fields", () => {
  withTempDir((dir) => {
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      name: "node-only",
      scripts: { test: "node --test" }
    }));
    writeExecutable(path.join(binDir, "golangci-lint"), 'echo "should not be called"; exit 9');
    writeExecutable(path.join(binDir, "goimports"), 'echo "should not be called"; exit 9');

    const output = runDoctor(dir, binDir);

    assert.deepEqual(Object.keys(output.runtime), ["node"]);
    assert.equal(Object.hasOwn(output.runtime, "go"), false);
    assert.equal(output.summary.errorCount, 0);
  });
});
