import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { testList } from "../src/commands/test-list.js";

test("testList discovers Node test scripts and files without running them", async () => {
  const root = fixtureDir("agentshell-test-list-node-");
  writeJson(path.join(root, "package.json"), {
    name: "node-fixture",
    scripts: {
      test: "vitest run",
      unit: "vitest run src",
      spec: "mocha",
      e2e: "playwright test",
      build: "vite build"
    }
  });
  touch(path.join(root, "tests", "api.js"));
  touch(path.join(root, "__tests__", "component.tsx"));
  touch(path.join(root, "src", "thing.test.ts"));
  touch(path.join(root, "src", "thing.spec.js"));

  const result = await testList(root, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.test-list.v1");
  assert.equal(result.compact, true);
  assert.equal(result.summary.totalScripts, 4);
  assert.equal(result.summary.totalFiles, 4);
  assert.equal(result.summary.returnedFiles, 4);
  assert.equal(result.summary.truncated, false);
  assert.equal(result.summary.nodePackageCount, 1);
  assert.equal(result.summary.goPackageCount, 0);
  assert.equal(result.summary.hasTests, true);
  assert.deepEqual(result.scripts.map((entry) => entry.name), ["test", "unit", "spec", "e2e"]);
  assert.ok(result.scripts.every((entry) => entry.runCommand.startsWith("npm run ")));
  assert.deepEqual(result.files.map((entry) => entry.path).sort(), [
    "__tests__/component.tsx",
    "src/thing.spec.js",
    "src/thing.test.ts",
    "tests/api.js"
  ]);
  assert.equal(result.files.find((entry) => entry.path === "tests/api.js").kind, "node-directory");
  assert.ok(result.suggestedNextActions.some((entry) => entry.command === "npm run test"));
});

test("testList discovers Go modules and _test.go files", async () => {
  const root = fixtureDir("agentshell-test-list-go-");
  fs.writeFileSync(path.join(root, "go.mod"), "module example.com/service\n\ngo 1.22\n");
  touch(path.join(root, "internal", "service", "service_test.go"));
  touch(path.join(root, "cmd", "app", "main.go"));

  const result = await testList(root, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.summary.totalScripts, 0);
  assert.equal(result.summary.totalFiles, 1);
  assert.equal(result.summary.goPackageCount, 1);
  assert.equal(result.summary.goFileCount, 1);
  assert.deepEqual(result.packages, [{
    type: "go",
    name: "example.com/service",
    path: "go.mod"
  }]);
  assert.deepEqual(result.files, [{
    path: "internal/service/service_test.go",
    language: "go",
    kind: "go-test"
  }]);
  assert.ok(result.suggestedNextActions.some((entry) => entry.command === "go test ./..."));
});

test("testList discovers Python test config, files, and packages", async () => {
  const root = fixtureDir("agentshell-test-list-python-");
  fs.writeFileSync(path.join(root, "pyproject.toml"), "[tool.pytest.ini_options]\n");
  fs.writeFileSync(path.join(root, "requirements-dev.txt"), "pytest\n");
  touch(path.join(root, "tests", "api.py"));
  touch(path.join(root, "src", "test_worker.py"));
  touch(path.join(root, "src", "worker_test.py"));
  touch(path.join(root, "src", "worker.py"));

  const result = await testList(root, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.summary.totalScripts, 0);
  assert.equal(result.summary.totalFiles, 4);
  assert.equal(result.summary.pythonPackageCount, 1);
  assert.equal(result.summary.pythonFileCount, 4);
  assert.equal(result.summary.hasTests, true);
  assert.deepEqual(result.packages, [{
    type: "python",
    name: path.basename(root),
    path: "pyproject.toml"
  }]);
  assert.deepEqual(result.files.map((entry) => entry.path).sort(), [
    "pyproject.toml",
    "src/test_worker.py",
    "src/worker_test.py",
    "tests/api.py"
  ]);
  assert.equal(result.files.find((entry) => entry.path === "pyproject.toml").kind, "python-config");
  assert.equal(result.files.find((entry) => entry.path === "tests/api.py").kind, "python-directory");
  assert.ok(result.suggestedNextActions.some((entry) => entry.command === "python -m pytest"));
});

test("testList discovers Java Maven and Gradle projects with test files", async () => {
  const root = fixtureDir("agentshell-test-list-java-");
  fs.writeFileSync(path.join(root, "pom.xml"), "<project />\n");
  fs.writeFileSync(path.join(root, "build.gradle.kts"), "plugins { java }\n");
  touch(path.join(root, "src", "test", "java", "com", "example", "ServiceTest.java"));
  touch(path.join(root, "src", "test", "java", "com", "example", "Integration.java"));
  touch(path.join(root, "src", "it", "java", "com", "example", "ServiceIT.java"));

  const result = await testList(root, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.summary.totalFiles, 3);
  assert.equal(result.summary.javaPackageCount, 3);
  assert.equal(result.summary.javaFileCount, 3);
  assert.equal(result.summary.hasTests, true);
  assert.ok(result.packages.some((entry) => entry.type === "java" && entry.path === "src"));
  assert.ok(result.packages.some((entry) => entry.type === "maven" && entry.path === "pom.xml"));
  assert.ok(result.packages.some((entry) => entry.type === "gradle" && entry.path === "build.gradle.kts"));
  assert.equal(result.files.find((entry) => entry.path.endsWith("Integration.java")).kind, "java-standard");
  assert.equal(result.files.find((entry) => entry.path.endsWith("ServiceIT.java")).kind, "java-pattern");
  assert.ok(result.suggestedNextActions.some((entry) => entry.command === "mvn test"));
});

test("testList handles mixed Node and Go workspaces", async () => {
  const root = fixtureDir("agentshell-test-list-mixed-");
  writeJson(path.join(root, "package.json"), {
    name: "mixed-fixture",
    scripts: {
      "test:e2e": "playwright test"
    }
  });
  fs.writeFileSync(path.join(root, "go.work"), "go 1.22\n\nuse (\n  ./api\n)\n");
  fs.mkdirSync(path.join(root, "api"), { recursive: true });
  fs.writeFileSync(path.join(root, "api", "go.mod"), "module example.com/api\n\ngo 1.22\n");
  touch(path.join(root, "web", "view.spec.ts"));
  touch(path.join(root, "api", "handler_test.go"));

  const result = await testList(root, { compact: true });

  assert.equal(result.summary.totalScripts, 1);
  assert.equal(result.summary.totalFiles, 2);
  assert.equal(result.summary.nodePackageCount, 1);
  assert.equal(result.summary.goWorkspaceCount, 1);
  assert.equal(result.summary.goPackageCount, 1);
  assert.ok(result.packages.some((entry) => entry.type === "go-workspace" && entry.modules.includes("api")));
  assert.ok(result.packages.some((entry) => entry.type === "go" && entry.name === "example.com/api"));
  assert.ok(result.files.some((entry) => entry.path === "web/view.spec.ts"));
  assert.ok(result.files.some((entry) => entry.path === "api/handler_test.go"));
});

test("testList truncates compact file output while preserving totals", async () => {
  const root = fixtureDir("agentshell-test-list-truncated-");
  writeJson(path.join(root, "package.json"), {
    name: "many-tests",
    scripts: {
      test: "node --test"
    }
  });
  for (let index = 0; index < 45; index += 1) {
    touch(path.join(root, "tests", `case-${String(index).padStart(2, "0")}.js`));
  }

  const result = await testList(root, { compact: true });

  assert.equal(result.summary.totalFiles, 45);
  assert.equal(result.summary.returnedFiles, 40);
  assert.equal(result.summary.truncated, true);
  assert.equal(result.files.length, 40);
  assert.ok(result.suggestedNextActions.some((entry) => entry.command === "agentshell test list"));
});

test("testList reports no tests with tree as the next action", async () => {
  const root = fixtureDir("agentshell-test-list-none-");
  writeJson(path.join(root, "package.json"), {
    name: "empty-fixture",
    scripts: {
      build: "vite build"
    }
  });

  const result = await testList(root, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.summary.totalScripts, 0);
  assert.equal(result.summary.totalFiles, 0);
  assert.equal(result.summary.hasTests, false);
  assert.deepEqual(result.scripts, []);
  assert.deepEqual(result.files, []);
  assert.ok(result.suggestedNextActions.some((entry) => entry.command === "agentshell tree --compact"));
});

test("test list schema exposes the compact response contract", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/test-list.schema.json", "utf8"));

  assert.equal(schema.title, "AgentShell Test List Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.test-list.v1");
  assert.ok(schema.oneOf[0].required.includes("summary"));
  assert.ok(schema.oneOf[0].required.includes("scripts"));
  assert.ok(schema.oneOf[0].required.includes("files"));
  assert.ok(schema.oneOf[0].required.includes("packages"));
  assert.ok(schema.$defs.summary.required.includes("returnedFiles"));
  assert.ok(schema.$defs.summary.required.includes("truncated"));
  assert.ok(schema.$defs.summary.required.includes("pythonPackageCount"));
  assert.ok(schema.$defs.summary.required.includes("javaFileCount"));
  assert.ok(schema.$defs.script.required.includes("runCommand"));
  assert.ok(schema.$defs.file.required.includes("kind"));
  assert.ok(schema.$defs.file.properties.language.enum.includes("python"));
  assert.ok(schema.$defs.file.properties.kind.enum.includes("java-standard"));
  assert.ok(schema.$defs.package.properties.type.enum.includes("go-workspace"));
  assert.ok(schema.$defs.package.properties.type.enum.includes("python"));
  assert.ok(schema.$defs.package.properties.type.enum.includes("gradle"));
});

function fixtureDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
}
