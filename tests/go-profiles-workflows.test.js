import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { verify } from "../src/commands/verify.js";
import { getProjectInfo } from "../src/core/project.js";
import { planGoVerification } from "../src/core/go-profiles.js";

const cli = path.resolve("src/cli.js");
const goAvailable = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;

test("Go test profiles add bounded built-in flags and preserve verify.v1", { skip: !goAvailable }, async () => {
  for (const [profile, flags] of [
    ["fast", "-short -failfast"],
    ["race", "-race"],
    ["coverage", "-covermode=atomic"]
  ]) {
    const root = moduleFixture(`profile-${profile}`);
    const output = await verify(root, "test", { profile, run: false });

    assert.equal(output.ok, true, JSON.stringify(output, null, 2));
    assert.equal(output.protocolVersion, "agentshell.verify.v1");
    assert.equal(output.type, "test");
    assert.equal(output.command, `go test ${flags} ./...`);
  }
});

test("profile runs do not use a cached related-package command that drops flags", { skip: !goAvailable }, async () => {
  const root = moduleFixture("profile-related");
  fs.writeFileSync(path.join(root, "broken_test.go"), [
    "package profilerelated",
    'import "testing"',
    'func TestBroken(t *testing.T) { t.Fatal("broken") }',
    ""
  ].join("\n"));

  const initial = await verify(root, "test", { run: false });
  assert.equal(initial.ok, false);
  fs.appendFileSync(path.join(root, "broken_test.go"), "// invalidate\n");

  const profiled = await verify(root, "test", { profile: "fast", run: false });
  assert.equal(profiled.ok, false);
  assert.equal(profiled.command, "go test -short -failfast ./...");
  assert.equal(Object.hasOwn(profiled, "verificationMode"), false);
});

test("benchmark safely quotes regex input and never uses the result cache", { skip: !goAvailable }, async () => {
  const root = moduleFixture("benchmark");
  fs.writeFileSync(path.join(root, "bench_test.go"), [
    "package benchmark",
    'import "testing"',
    "func BenchmarkAdd(b *testing.B) { for i := 0; i < b.N; i++ { _ = i + i } }",
    ""
  ].join("\n"));

  const output = await verify(root, "benchmark", { bench: "^Benchmark(Add|Sub)$", run: false });
  assert.equal(output.ok, true, JSON.stringify(output, null, 2));
  assert.equal(output.type, "benchmark");
  assert.equal(output.cacheHit, false);
  assert.equal(output.cacheKey, "uncached:go:benchmark");
  assert.match(output.command, /-bench '\^Benchmark\(Add\|Sub\)\$'/);

  const injected = planGoVerification(getProjectInfo(root), "benchmark", {
    bench: "BenchmarkAdd'; touch /tmp/agentshell-injected; echo '"
  });
  assert.equal(injected.ok, true);
  assert.match(injected.command, /'\\''/);
});

test("benchmark shell quoting prevents command injection during execution", { skip: !goAvailable }, async () => {
  const root = moduleFixture("benchmark-injection");
  const marker = path.join(root, "injected.txt");
  const output = await verify(root, "benchmark", {
    bench: `BenchmarkNone'; touch ${marker}; echo '`,
    run: false
  });

  assert.equal(output.cacheHit, false);
  assert.equal(fs.existsSync(marker), false);
});

test("fuzz requires an explicit target, finite duration, and one in-project package", () => {
  const root = moduleFixture("fuzz-boundary");
  fs.mkdirSync(path.join(root, "parser"));
  const project = getProjectInfo(root);

  assert.equal(planGoVerification(project, "fuzz", {
    duration: "5s",
    package: "./parser"
  }).code, "GO_FUZZ_TARGET_REQUIRED");
  assert.equal(planGoVerification(project, "fuzz", {
    fuzz: "FuzzParse",
    duration: "0s",
    package: "./parser"
  }).code, "GO_FUZZ_DURATION_INVALID");
  assert.equal(planGoVerification(project, "fuzz", {
    fuzz: "FuzzParse",
    duration: "11m",
    package: "./parser"
  }).code, "GO_FUZZ_DURATION_INVALID");
  assert.equal(planGoVerification(project, "fuzz", {
    fuzz: "FuzzParse",
    duration: "5s",
    package: "../outside"
  }).code, "GO_FUZZ_PACKAGE_INVALID");
  assert.equal(planGoVerification(project, "fuzz", {
    fuzz: "FuzzParse",
    duration: "5s",
    package: "./..."
  }).code, "GO_FUZZ_PACKAGE_INVALID");

  const valid = planGoVerification(project, "fuzz", {
    fuzz: "^Fuzz(Parse|Decode)$",
    duration: "5s",
    package: "./parser"
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.cacheable, false);
  assert.match(valid.command, /-fuzz '\^Fuzz\(Parse\|Decode\)\$'/);
  assert.match(valid.command, /-fuzztime '5s' '\.\/parser'$/);
});

test("fuzz executes one explicitly bounded package and stays uncached", { skip: !goAvailable }, async () => {
  const root = moduleFixture("fuzz-execution");
  fs.writeFileSync(path.join(root, "fuzz_test.go"), [
    "package fuzzexecution",
    'import "testing"',
    "func FuzzEcho(f *testing.F) {",
    '  f.Add("seed")',
    "  f.Fuzz(func(t *testing.T, value string) { _ = value })",
    "}",
    ""
  ].join("\n"));

  const output = await verify(root, "fuzz", {
    fuzz: "^FuzzEcho$",
    duration: "1s",
    package: ".",
    run: false
  });

  assert.equal(output.ok, true, JSON.stringify(output, null, 2));
  assert.equal(output.cacheHit, false);
  assert.equal(output.cacheKey, "uncached:go:fuzz");
  assert.match(output.command, /-fuzz '\^FuzzEcho\$' -fuzztime '1s' '\.'$/);
});

test("generate is a read-only go generate -n preview", { skip: !goAvailable }, async () => {
  const root = moduleFixture("generate");
  const source = path.join(root, "generate.go");
  const marker = path.join(root, "generated.txt");
  fs.writeFileSync(source, [
    "package generate",
    "//go:generate sh -c \"echo changed > generated.txt\"",
    ""
  ].join("\n"));
  const before = fs.readFileSync(source);

  const output = await verify(root, "generate", { run: false });
  assert.equal(output.ok, true, JSON.stringify(output, null, 2));
  assert.equal(output.command, "go generate -n ./...");
  assert.equal(output.cacheHit, false);
  assert.equal(output.cacheKey, "uncached:go:generate");
  assert.deepEqual(fs.readFileSync(source), before);
  assert.equal(fs.existsSync(marker), false);
});

test("CLI validates advanced workflow arguments without changing Node verification", () => {
  const invalidProfile = runCli(process.cwd(), ["verify", "test", "--profile", "turbo"]);
  assert.equal(invalidProfile.status, 2);
  assert.equal(JSON.parse(invalidProfile.stdout).error.code, "INVALID_ARGUMENT");

  const missingFuzzTarget = runCli(process.cwd(), [
    "verify", "fuzz", "--duration", "5s", "--package", "."
  ]);
  assert.equal(missingFuzzTarget.status, 2);
  assert.equal(JSON.parse(missingFuzzTarget.stdout).error.code, "INVALID_ARGUMENT");

  const nodeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-node-profile-contract-"));
  fs.writeFileSync(path.join(nodeRoot, "package.json"), JSON.stringify({
    name: "node-profile-contract",
    scripts: { test: "node --test" }
  }));
  const node = runCli(nodeRoot, ["verify", "test"]);
  assert.equal(node.status, 0, node.stderr || node.stdout);
  assert.equal(JSON.parse(node.stdout).command, "npm run test");

  const compact = runCli(nodeRoot, ["verify", "test", "--compact"]);
  assert.notEqual(JSON.parse(compact.stdout).error?.code, "INVALID_ARGUMENT");
});

function moduleFixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agentshell-go-${name}-`));
  const packageName = name.replace(/[^A-Za-z0-9]/g, "");
  fs.writeFileSync(path.join(root, "go.mod"), `module example.com/${name}\n\ngo 1.22\n`);
  fs.writeFileSync(path.join(root, "main.go"), `package ${packageName}\n`);
  return root;
}

function runCli(cwd, args) {
  return spawnSync("node", [cli, ...args], { cwd, encoding: "utf8" });
}
