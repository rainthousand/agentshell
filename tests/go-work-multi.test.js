import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getProjectInfo, projectCommand } from "../src/core/project.js";

function fixture(goWork) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-go-work-"));
  fs.writeFileSync(path.join(root, "go.work"), goWork);
  return root;
}

function moduleAt(root, relative, name = relative) {
  const moduleRoot = path.join(root, relative);
  fs.mkdirSync(moduleRoot, { recursive: true });
  fs.writeFileSync(path.join(moduleRoot, "go.mod"), `module example.com/${name}\n\ngo 1.22\n`);
  return moduleRoot;
}

test("discovers a single-use go.work from its root and a nested module directory", () => {
  const root = fixture("go 1.22\n\nuse ./service\n");
  const moduleRoot = moduleAt(root, "service");
  const nested = path.join(moduleRoot, "internal", "handler");
  fs.mkdirSync(nested, { recursive: true });

  try {
    for (const start of [root, nested]) {
      const project = getProjectInfo(start);
      assert.equal(project.kind, "go");
      assert.equal(project.root, root);
      assert.equal(project.manifest, "go.work");
      assert.equal(projectCommand(project, "test"), "go test './service/...'");
      assert.deepEqual(project.issues, []);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("parses a go.work use block and tests every valid module explicitly", () => {
  const root = fixture([
    "go 1.22",
    "",
    "use (",
    "  ./api",
    "  \"./worker\" // background jobs",
    ")",
    ""
  ].join("\n"));
  moduleAt(root, "api");
  moduleAt(root, "worker");

  try {
    const project = getProjectInfo(root);
    assert.equal(project.manifest, "go.work");
    assert.equal(projectCommand(project, "test"), "go test './api/...' './worker/...'");
    assert.deepEqual(project.modules.map((module) => module.path), ["./api", "./worker"]);
    assert.ok(project.modules.every((module) => module.valid));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keeps valid go.work modules and reports invalid use paths conservatively", () => {
  const root = fixture("go 1.22\n\nuse (\n ./valid\n ./missing\n ./not-a-module\n)\n");
  moduleAt(root, "valid");
  fs.mkdirSync(path.join(root, "not-a-module"));

  try {
    const project = getProjectInfo(root);
    assert.equal(projectCommand(project, "test"), "go test './valid/...'");
    assert.deepEqual(project.issues, [
      {
        code: "GO_WORK_USE_INVALID",
        path: "./missing",
        reason: "use-path-missing"
      },
      {
        code: "GO_WORK_USE_INVALID",
        path: "./not-a-module",
        reason: "go-mod-missing"
      }
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("returns a structured workspace without a test command when no use module is valid", () => {
  const root = fixture("go 1.22\n\nuse ./missing\n");

  try {
    const project = getProjectInfo(root);
    assert.equal(project.kind, "go");
    assert.equal(project.manifest, "go.work");
    assert.equal(projectCommand(project, "test"), null);
    assert.deepEqual(project.rawScripts, {});
    assert.deepEqual(project.issues, [{
      code: "GO_WORK_USE_INVALID",
      path: "./missing",
      reason: "use-path-missing"
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects go.work use paths outside the AgentShell workspace boundary", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-go-work-parent-"));
  const root = path.join(parent, "workspace");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "go.work"), "go 1.22\n\nuse ../external\n");
  moduleAt(parent, "external");

  try {
    const project = getProjectInfo(root);
    assert.equal(projectCommand(project, "test"), null);
    assert.equal(project.issues[0].reason, "use-path-outside-workspace");
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("an unlisted nested Go module remains independent from an ancestor go.work", () => {
  const root = fixture("go 1.22\n\nuse ./listed\n");
  moduleAt(root, "listed");
  const independent = moduleAt(root, "independent");

  try {
    const project = getProjectInfo(independent);
    assert.equal(project.root, independent);
    assert.equal(project.manifest, "go.mod");
    assert.equal(projectCommand(project, "test"), "go test ./...");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preserves same-root Node and Go test selection inside a go.work module", () => {
  const root = fixture("go 1.22\n\nuse ./mixed\n");
  const mixed = moduleAt(root, "mixed");
  fs.writeFileSync(path.join(mixed, "package.json"), JSON.stringify({
    name: "mixed-tooling",
    scripts: { test: "node --test" }
  }));

  try {
    const nodeProject = getProjectInfo(mixed);
    assert.equal(nodeProject.kind, "node");
    assert.equal(projectCommand(nodeProject, "test"), "npm run test");

    fs.writeFileSync(path.join(mixed, "package.json"), JSON.stringify({
      name: "mixed-tooling",
      scripts: { lint: "eslint ." }
    }));
    const goProject = getProjectInfo(mixed);
    assert.equal(goProject.kind, "go");
    assert.equal(goProject.manifest, "go.work");
    assert.equal(projectCommand(goProject, "test"), "go test './mixed/...'");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
