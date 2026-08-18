import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { verify } from "../src/commands/verify.js";

const goAvailable = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;

test("verify format reports gofmt differences without changing source bytes", { skip: !goAvailable }, async () => {
  const root = moduleFixture("format");
  const source = path.join(root, "main.go");
  fs.writeFileSync(source, "package main\n\nfunc main(){println(\"hello\")}\n");
  const before = fs.readFileSync(source);

  const output = await verify(root, "format", { run: false });

  assert.equal(output.ok, false);
  assert.equal(output.command, "gofmt -d <go files>");
  assert.match(output.summary.mainError, /gofmt differences/);
  assert.deepEqual(output.relatedFiles, ["main.go"]);
  assert.deepEqual(fs.readFileSync(source), before);
});

test("verify format accepts formatted Go files and leaves Node behavior unchanged", { skip: !goAvailable }, async () => {
  const root = moduleFixture("formatted");
  fs.writeFileSync(path.join(root, "main.go"), "package main\n\nfunc main() {\n\tprintln(\"hello\")\n}\n");

  const output = await verify(root, "format", { run: false });
  assert.equal(output.ok, true);
  assert.equal(output.summary.failedTests, 0);

  const nodeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-node-format-"));
  fs.writeFileSync(path.join(nodeRoot, "package.json"), JSON.stringify({ name: "node-format" }));
  const nodeOutput = await verify(nodeRoot, "format", { run: false });
  assert.equal(nodeOutput.ok, false);
  assert.equal(nodeOutput.error.code, "SCRIPT_NOT_FOUND");
});

test("verify modules detects tidy drift while preserving go.mod and go.sum bytes", { skip: !goAvailable }, async () => {
  const root = moduleFixture("tidy-drift");
  const dependency = path.join(root, "dependency");
  fs.mkdirSync(dependency);
  fs.writeFileSync(path.join(dependency, "go.mod"), "module example.com/dependency\n\ngo 1.22\n");
  fs.writeFileSync(path.join(dependency, "dep.go"), "package dependency\n");
  fs.appendFileSync(
    path.join(root, "go.mod"),
    "\nrequire example.com/dependency v0.0.0\n\nreplace example.com/dependency => ./dependency\n"
  );
  fs.writeFileSync(path.join(root, "main.go"), "package main\n\nfunc main() {}\n");
  fs.writeFileSync(path.join(root, "go.sum"), "");
  const before = workspaceBytes(root);

  const output = await verify(root, "modules", { run: false });

  assert.equal(output.ok, false);
  assert.equal(output.command, "go mod verify && go mod tidy -modfile=<temporary>");
  assert.match(output.summary.mainError, /module verification failed/);
  assert.ok(output.relatedFiles.includes("go.mod"), JSON.stringify(output, null, 2));
  assert.deepEqual(workspaceBytes(root), before);
  assert.deepEqual(findTidyArtifacts(root), []);
});

test("verify modules checks every valid go.work module without workspace mutation", { skip: !goAvailable }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-go-quality-work-"));
  fs.writeFileSync(path.join(root, "go.work"), "go 1.22\n\nuse (\n ./api\n ./worker\n)\n");
  const api = moduleFixtureAt(root, "api");
  const worker = moduleFixtureAt(root, "worker");
  fs.writeFileSync(path.join(api, "api.go"), "package api\n");
  fs.writeFileSync(path.join(worker, "worker.go"), "package worker\n");
  const before = workspaceBytes(root);

  const output = await verify(root, "modules", { run: false });

  assert.equal(output.ok, true, JSON.stringify(output, null, 2));
  assert.equal(output.summary.failedTests, 0);
  assert.deepEqual(workspaceBytes(root), before);
  assert.deepEqual(findTidyArtifacts(root), []);
});

test("verify modules surfaces malformed module metadata and preserves files", { skip: !goAvailable }, async () => {
  const root = moduleFixture("verify-failure");
  fs.writeFileSync(path.join(root, "go.sum"), "invalid checksum line\n");
  const before = workspaceBytes(root);

  const output = await verify(root, "modules", { run: false });

  assert.equal(output.ok, false);
  assert.ok(output.relatedFiles.includes("go.sum"));
  assert.deepEqual(workspaceBytes(root), before);
  assert.deepEqual(findTidyArtifacts(root), []);
});

function moduleFixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agentshell-go-quality-${name}-`));
  fs.writeFileSync(path.join(root, "go.mod"), `module example.com/${name}\n\ngo 1.22\n`);
  return root;
}

function moduleFixtureAt(root, relative) {
  const moduleRoot = path.join(root, relative);
  fs.mkdirSync(moduleRoot, { recursive: true });
  fs.writeFileSync(path.join(moduleRoot, "go.mod"), `module example.com/${relative}\n\ngo 1.22\n`);
  return moduleRoot;
}

function workspaceBytes(root) {
  const values = {};
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".agentshell") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      if (entry.isFile()) values[path.relative(root, absolute)] = fs.readFileSync(absolute).toString("base64");
    }
  }
  return values;
}

function findTidyArtifacts(root) {
  const matches = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      if (entry.isFile() && entry.name.startsWith(".agentshell-tidy-")) matches.push(absolute);
    }
  }
  return matches;
}
