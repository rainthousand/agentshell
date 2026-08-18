import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getProjectInfo, projectCommand, relatedTestCommand } from "../src/core/project.js";

test("project adapter preserves Node package commands", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-node-project-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "node-project",
    scripts: { test: "node --test", lint: "eslint ." }
  }));

  const project = getProjectInfo(root);
  assert.equal(project.kind, "node");
  assert.equal(project.name, "node-project");
  assert.equal(project.manager, "npm");
  assert.equal(projectCommand(project, "test"), "npm run test");
  assert.equal(projectCommand(project, "lint"), "npm run lint");
  assert.equal(relatedTestCommand(project, "test/user.test.js"), "node --test 'test/user.test.js'");
});

test("project adapter discovers a Go module from a nested directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-go-project-"));
  const nested = path.join(root, "internal", "math");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(root, "go.mod"), "module example.com/tools\n\ngo 1.22\n");

  const project = getProjectInfo(nested);
  assert.equal(project.kind, "go");
  assert.equal(project.root, root);
  assert.equal(project.name, "example.com/tools");
  assert.equal(project.manager, "go");
  assert.equal(project.manifest, "go.mod");
  assert.equal(projectCommand(project, "test"), "go test ./...");
  assert.equal(relatedTestCommand(project, "internal/math/math_test.go"), "go test './internal/math'");
});

test("project adapter selects a testable Go module over same-root Node tooling", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-mixed-project-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "tooling-only",
    scripts: { lint: "eslint ." }
  }));
  fs.writeFileSync(path.join(root, "go.mod"), "module example.com/mixed\n\ngo 1.22\n");

  const project = getProjectInfo(root);

  assert.equal(project.kind, "go");
  assert.equal(project.name, "example.com/mixed");
  assert.equal(project.commands.test, "go test ./...");
});
