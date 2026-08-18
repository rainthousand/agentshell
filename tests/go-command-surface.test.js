import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getProjectInfo, projectCommand } from "../src/core/project.js";

test("Go modules expose test, build, and lint verification commands", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-go-commands-"));
  fs.writeFileSync(path.join(root, "go.mod"), "module example.com/commands\n\ngo 1.22\n");

  const project = getProjectInfo(root);

  assert.equal(projectCommand(project, "test"), "go test ./...");
  assert.equal(projectCommand(project, "build"), "go build ./...");
  assert.equal(projectCommand(project, "lint"), "go vet ./...");
});

test("Go workspaces expose build and lint commands for every valid module", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-go-work-commands-"));
  fs.writeFileSync(path.join(root, "go.work"), "go 1.22\n\nuse (\n ./api\n ./worker\n)\n");
  for (const name of ["api", "worker"]) {
    const moduleRoot = path.join(root, name);
    fs.mkdirSync(moduleRoot);
    fs.writeFileSync(path.join(moduleRoot, "go.mod"), `module example.com/${name}\n\ngo 1.22\n`);
  }

  const project = getProjectInfo(root);

  assert.equal(projectCommand(project, "test"), "go test './api/...' './worker/...'");
  assert.equal(projectCommand(project, "build"), "go build './api/...' './worker/...'");
  assert.equal(projectCommand(project, "lint"), "go vet './api/...' './worker/...'");
});
