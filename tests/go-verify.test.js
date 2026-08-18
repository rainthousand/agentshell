import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cli = path.resolve("src/cli.js");
const goAvailable = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;

test("verify test runs Go modules and summarizes failing tests", { skip: !goAvailable }, () => {
  const root = createGoFixture();
  writeGoSource(root, "return left - right");

  const result = run(root, ["verify", "test"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.command, "go test ./...");
  assert.equal(output.cacheHit, false);
  assert.equal(output.summary.failedTests, 2);
  assert.match(output.summary.mainError, /calc_test\.go:\d+: Add\(2, 3\) should equal 5/);
  assert.ok(output.relatedFiles.includes("internal/calc/calc_test.go"), JSON.stringify(output, null, 2));
});

test("Go failure cache tracks sibling source files in the related package", { skip: !goAvailable }, () => {
  const root = createGoFixture();
  writeGoSource(root, "return left - right");

  const first = run(root, ["verify", "test"]);
  assert.equal(first.status, 1, first.stderr || first.stdout);
  const firstOutput = JSON.parse(first.stdout);
  assert.equal(firstOutput.cacheHit, false);

  const second = run(root, ["verify", "test"]);
  assert.equal(second.status, 1, second.stderr || second.stdout);
  const secondOutput = JSON.parse(second.stdout);
  assert.equal(secondOutput.cacheHit, true);
  assert.equal(secondOutput.cacheKey, firstOutput.cacheKey);

  writeGoSource(root, "return left + right");
  const fixed = run(root, ["verify", "test"]);
  assert.equal(fixed.status, 0, fixed.stderr || fixed.stdout);
  const fixedOutput = JSON.parse(fixed.stdout);
  assert.equal(fixedOutput.cacheHit, false);
  assert.equal(fixedOutput.command, "go test ./...");
  assert.equal(fixedOutput.relatedTestFileVerification.command, "go test './internal/calc'");
  assert.equal(fixedOutput.relatedTestFileVerification.ok, true);
});

test("Go related test reuse runs the package-scoped command", { skip: !goAvailable }, () => {
  const root = createGoFixture();
  writeGoSource(root, "return left - right");

  const first = run(root, ["verify", "test"]);
  assert.equal(first.status, 1, first.stderr || first.stdout);

  const testFile = path.join(root, "internal", "calc", "calc_test.go");
  fs.appendFileSync(testFile, "\n// invalidate the cached failure\n");
  const related = run(root, ["verify", "test"]);
  assert.equal(related.status, 1, related.stderr || related.stdout);
  const output = JSON.parse(related.stdout);
  assert.equal(output.verificationMode, "related-test-file");
  assert.equal(output.fullCommand, "go test ./...");
  assert.equal(output.relatedTestFile, "internal/calc/calc_test.go");
  assert.equal(output.relatedTestFileSource, "cache");
  assert.equal(output.command, "go test './internal/calc'");
});

test("Go build errors resolve unique source basenames from subpackages", { skip: !goAvailable }, () => {
  const root = createGoFixture();
  writeGoSource(root, "return missingValue");

  const result = run(root, ["verify", "test"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.match(output.summary.mainError, /calc\.go:\d+:\d+: undefined: missingValue/);
  assert.ok(output.relatedFiles.includes("internal/calc/calc.go"), JSON.stringify(output, null, 2));
});

test("Go failure cache invalidates when an imported package changes", { skip: !goAvailable }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-go-cross-package-"));
  const calcDir = path.join(root, "internal", "calc");
  const appDir = path.join(root, "app");
  fs.mkdirSync(calcDir, { recursive: true });
  fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(root, "go.mod"), "module example.com/crosspackage\n\ngo 1.22\n");
  fs.writeFileSync(path.join(calcDir, "calc.go"), "package calc\n\nfunc Add(a, b int) int { return a - b }\n");
  fs.writeFileSync(path.join(appDir, "app_test.go"), [
    "package app",
    "",
    'import ("testing"; "example.com/crosspackage/internal/calc")',
    "",
    "func TestAdd(t *testing.T) {",
    '  if calc.Add(2, 3) != 5 { t.Fatal("unexpected sum") }',
    "}",
    ""
  ].join("\n"));

  const first = run(root, ["verify", "test"]);
  assert.equal(first.status, 1, first.stderr || first.stdout);
  assert.equal(JSON.parse(first.stdout).cacheHit, false);

  const cached = run(root, ["verify", "test"]);
  assert.equal(cached.status, 1, cached.stderr || cached.stdout);
  assert.equal(JSON.parse(cached.stdout).cacheHit, true);

  fs.writeFileSync(path.join(calcDir, "calc.go"), "package calc\n\nfunc Add(a, b int) int { return a + b }\n");
  const fixed = run(root, ["verify", "test"]);
  assert.equal(fixed.status, 0, fixed.stderr || fixed.stdout);
  assert.equal(JSON.parse(fixed.stdout).cacheHit, false);
});

function createGoFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-go-verify-"));
  const packageDir = path.join(root, "internal", "calc");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(root, "go.mod"), "module example.com/agentshellfixture\n\ngo 1.22\n");
  fs.writeFileSync(path.join(packageDir, "calc_test.go"), [
    "package calc",
    "",
    'import "testing"',
    "",
    "func TestAdd(t *testing.T) {",
    "  if Add(2, 3) != 5 { t.Fatalf(\"Add(2, 3) should equal 5\") }",
    "}",
    "",
    "func TestAddAgain(t *testing.T) {",
    "  if Add(4, 6) != 10 { t.Fatalf(\"Add(4, 6) should equal 10\") }",
    "}",
    ""
  ].join("\n"));
  return root;
}

function writeGoSource(root, body) {
  fs.writeFileSync(path.join(root, "internal", "calc", "calc.go"), [
    "package calc",
    "",
    "func Add(left, right int) int {",
    `  ${body}`,
    "}",
    ""
  ].join("\n"));
}

function run(cwd, args) {
  return spawnSync("node", [cli, ...args], {
    cwd,
    encoding: "utf8"
  });
}
