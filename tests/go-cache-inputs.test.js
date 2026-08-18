import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createTestResultCacheContext,
  findTestResultCacheFromContext,
  writeTestResultCacheFromContext
} from "../src/core/cache.js";
import { writeLog } from "../src/core/store.js";

test("Go failure cache invalidates when testdata changes", () => {
  const fixture = createFixture({
    "pkg/calc_test.go": "package pkg\n",
    "pkg/testdata/golden.json": "{\"value\":1}\n"
  });

  assertInputInvalidates(fixture, "pkg/testdata/golden.json", "{\"value\":2}\n");
});

test("Go failure cache invalidates when a new module input appears", () => {
  const fixture = createFixture({
    "pkg/calc_test.go": "package pkg\n",
    "pkg/testdata/existing.txt": "existing\n"
  });

  const cacheWrite = primeFailure(fixture);
  assert.ok(cacheWrite);
  assert.equal(findFailure(fixture).cacheHit, true);
  fs.writeFileSync(path.join(fixture, "pkg", "testdata", "new.txt"), "new\n");
  assert.equal(findFailure(fixture).cacheHit, false);
});

test("Go failure cache invalidates when an embedded resource changes", () => {
  const fixture = createFixture({
    "pkg/calc_test.go": "package pkg\n",
    "pkg/embed.go": "package pkg\n\nimport _ \"embed\"\n\n//go:embed assets/message.txt\nvar message string\n",
    "pkg/assets/message.txt": "before\n"
  });

  assertInputInvalidates(fixture, "pkg/assets/message.txt", "after\n");
});

test("Go failure cache tracks native build inputs", () => {
  const inputs = [
    ["pkg/native.c", "int value = 1;\n", "int value = 2;\n"],
    ["pkg/native.h", "#define VALUE 1\n", "#define VALUE 2\n"],
    ["pkg/native.s", "// assembly input one\n", "// assembly input two\n"]
  ];

  for (const [file, before, after] of inputs) {
    const fixture = createFixture({
      "pkg/calc_test.go": "package pkg\n",
      [file]: before
    });
    assertInputInvalidates(fixture, file, after);
  }
});

test("Go cache ignores generated directories and disables itself above its input budget", () => {
  const ignored = createFixture({
    "pkg/calc_test.go": "package pkg\n",
    "build/generated.go": "package generated\n"
  });
  primeFailure(ignored);
  fs.writeFileSync(path.join(ignored, "build", "generated.go"), "package generated\n\nconst Changed = true\n");
  assert.equal(findFailure(ignored).cacheHit, true);

  const oversized = createFixture({ "pkg/calc_test.go": "package pkg\n" });
  const data = path.join(oversized, "pkg", "testdata");
  fs.mkdirSync(data, { recursive: true });
  for (let index = 0; index < 2000; index += 1) {
    fs.writeFileSync(path.join(data, `${index}.txt`), `${index}\n`);
  }
  assert.equal(primeFailure(oversized), null);
  assert.equal(findFailure(oversized).cacheHit, false);
});

test("Go workspace cache fingerprints every valid use module", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-go-work-cache-"));
  const alpha = path.join(root, "alpha");
  const beta = path.join(root, "beta");
  fs.mkdirSync(alpha);
  fs.mkdirSync(beta);
  fs.writeFileSync(path.join(root, "go.work"), "go 1.22\n\nuse (\n ./alpha\n ./beta\n)\n");
  for (const [moduleRoot, name] of [[alpha, "alpha"], [beta, "beta"]]) {
    fs.writeFileSync(path.join(moduleRoot, "go.mod"), `module example.com/${name}\n\ngo 1.22\n`);
    fs.writeFileSync(path.join(moduleRoot, `${name}.go`), `package ${name}\n`);
  }
  fs.writeFileSync(path.join(beta, "beta_test.go"), "package beta\n");
  const project = {
    kind: "go",
    manifest: "go.work",
    modules: [
      { root: alpha, valid: true },
      { root: beta, valid: true }
    ]
  };
  const options = {
    type: "test",
    command: "go test './alpha/...' './beta/...'",
    packagePath: path.join(root, "go.work"),
    project
  };
  const context = createTestResultCacheContext(root, options);
  const logRef = "workspace-cache";
  writeLog(root, logRef, "failure\n", "");
  writeTestResultCacheFromContext(context, {
    result: { exitCode: 1, stdout: "failure\n", stderr: "" },
    summary: { mainError: "failure", failedTests: 1 },
    relatedFiles: ["beta/beta_test.go"],
    logRef
  });
  assert.equal(findTestResultCacheFromContext(createTestResultCacheContext(root, options)).cacheHit, true);

  fs.writeFileSync(path.join(alpha, "alpha.go"), "package alpha\n\nconst Changed = true\n");
  assert.equal(findTestResultCacheFromContext(createTestResultCacheContext(root, options)).cacheHit, false);
});

function assertInputInvalidates(root, file, replacement) {
  const cacheWrite = primeFailure(root);
  assert.ok(cacheWrite, `expected cache write for ${file}`);
  assert.equal(findFailure(root).cacheHit, true);

  fs.writeFileSync(path.join(root, file), replacement);
  assert.equal(findFailure(root).cacheHit, false, `${file} should invalidate the cached failure`);
}

function createFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-go-cache-inputs-"));
  fs.writeFileSync(path.join(root, "go.mod"), "module example.com/cacheinputs\n\ngo 1.22\n");
  for (const [file, content] of Object.entries(files)) {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  return root;
}

function primeFailure(root) {
  const context = cacheContext(root);
  const logRef = `cache-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  writeLog(root, logRef, "failure\n", "");
  return writeTestResultCacheFromContext(context, {
    result: { exitCode: 1, stdout: "failure\n", stderr: "" },
    summary: { mainError: "failure", failedTests: 1 },
    relatedFiles: ["pkg/calc_test.go"],
    logRef
  });
}

function findFailure(root) {
  return findTestResultCacheFromContext(cacheContext(root));
}

function cacheContext(root) {
  return createTestResultCacheContext(root, {
    type: "test",
    command: "go test ./...",
    packagePath: path.join(root, "go.mod")
  });
}
