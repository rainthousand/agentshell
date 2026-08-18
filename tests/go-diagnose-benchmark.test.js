import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cli = path.resolve("src/cli.js");
const goAvailable = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;

test("Go diagnosis links a failing test to sibling implementation without auto-repair", {
  skip: !goAvailable
}, () => {
  const root = createFailingGoModule();
  const diagnosis = runCli(root, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0, diagnosis.stderr);
  const output = JSON.parse(diagnosis.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.verificationOk, false);
  assert.ok(output.verification.relatedFiles.includes("calc_test.go"));
  assert.ok(output.implementationReads.some((read) => read.file === "calc.go"));
  assert.equal(output.fixPlan.target.file, "calc.go");

  const suggestion = runCli(root, ["change", "suggest", "--dry-run", "--compact"]);
  assert.equal(suggestion.status, 1);
  const refusal = JSON.parse(suggestion.stdout);
  assert.equal(refusal.error.code, "SUGGESTION_UNAVAILABLE");
  assert.equal(refusal.error.details.unsupportedReason, "unsupported-language-go");
});

test("benchmark test compares raw and compact output for Go modules", {
  skip: !goAvailable
}, () => {
  const root = createFailingGoModule({ noiseLines: 120 });
  const result = runCli(root, ["benchmark", "test"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.command, "go test ./...");
  assert.equal(output.raw.exitCode, 1);
  assert.equal(output.agentshell.exitCode, 1);
  assert.ok(output.raw.estimatedTokens > output.agentshell.estimatedTokens);
  assert.ok(output.agentshell.relatedFiles.includes("calc_test.go"));
});

function createFailingGoModule(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-go-diagnose-"));
  fs.writeFileSync(path.join(root, "go.mod"), "module example.com/calc\n\ngo 1.22\n");
  fs.writeFileSync(path.join(root, "calc.go"), [
    "package calc",
    "",
    "func Add(left, right int) int {",
    "\treturn left + right + 1",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(root, "calc_test.go"), [
    "package calc",
    "",
    "import (",
    '\t"fmt"',
    '\t"testing"',
    ")",
    "",
    "func TestAdd(t *testing.T) {",
    `\tfor i := 0; i < ${options.noiseLines || 0}; i++ { fmt.Printf("go test progress %d complete\\n", i) }`,
    "\tif got := Add(2, 2); got != 4 {",
    '\t\tt.Fatalf("Add(2, 2) = %d; want 4", got)',
    "\t}",
    "}",
    ""
  ].join("\n"));
  return root;
}

function runCli(cwd, args) {
  return spawnSync("node", [cli, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 20_000
  });
}
