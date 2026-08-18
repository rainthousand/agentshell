import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseGoTestJson } from "../src/core/go-test-json.js";

const cli = path.resolve("src/cli.js");
const goAvailable = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;

test("parses interleaved packages and counts only failed leaf subtests", () => {
  const root = fixture([
    "internal/alpha/alpha_test.go",
    "internal/beta/alpha_test.go"
  ]);
  const input = jsonLines([
    event("run", "example.com/json/internal/alpha", "TestTable"),
    event("run", "example.com/json/internal/beta", "TestTable"),
    output("example.com/json/internal/alpha", "TestTable/case_one", "    alpha_test.go:12: wrong alpha\n"),
    output("example.com/json/internal/beta", "TestTable", "    alpha_test.go:8: wrong beta\n"),
    event("fail", "example.com/json/internal/alpha", "TestTable/case_one"),
    event("fail", "example.com/json/internal/alpha", "TestTable"),
    event("fail", "example.com/json/internal/beta", "TestTable")
  ]);

  const parsed = parseGoTestJson(input, { root });
  assert.equal(parsed.failedTests, 2);
  assert.deepEqual(parsed.failedTestNames, ["TestTable/case_one", "TestTable"]);
  assert.equal(parsed.mainError, "alpha_test.go:12: wrong alpha");
  assert.deepEqual(parsed.relatedFiles, [
    "internal/alpha/alpha_test.go",
    "internal/beta/alpha_test.go"
  ]);
});

test("prefers panic details while retaining the failed test", () => {
  const root = fixture(["panic_test.go"]);
  const input = jsonLines([
    output("example.com/json", "TestPanic", "--- FAIL: TestPanic (0.00s)\n"),
    output("example.com/json", "TestPanic", "panic: index out of range [recovered]\n"),
    output("example.com/json", "TestPanic", "\tpanic_test.go:9 +0x20\n"),
    event("fail", "example.com/json", "TestPanic")
  ]);

  const parsed = parseGoTestJson(input, { root });
  assert.equal(parsed.failedTests, 1);
  assert.equal(parsed.mainError, "panic: index out of range [recovered]");
  assert.deepEqual(parsed.relatedFiles, ["panic_test.go"]);
});

test("parses build-output events and source locations", () => {
  const root = fixture(["internal/broken/broken.go"]);
  const input = jsonLines([
    {
      ImportPath: "example.com/json/internal/broken",
      Action: "build-output",
      Output: "internal/broken/broken.go:4:9: undefined: missing\n"
    },
    {
      ImportPath: "example.com/json/internal/broken",
      Action: "build-fail"
    },
    output("example.com/json/internal/broken", null, "FAIL\texample.com/json/internal/broken [build failed]\n"),
    event("fail", "example.com/json/internal/broken")
  ]);

  const parsed = parseGoTestJson(input, { root });
  assert.equal(parsed.failedTests, null);
  assert.equal(parsed.mainError, "internal/broken/broken.go:4:9: undefined: missing");
  assert.deepEqual(parsed.relatedFiles, ["internal/broken/broken.go"]);
});

test("uses go.work module mappings to resolve duplicate basenames", () => {
  const root = fixture([]);
  const alpha = path.join(root, "alpha");
  const beta = path.join(root, "beta");
  for (const [moduleRoot, moduleName] of [[alpha, "alpha"], [beta, "beta"]]) {
    fs.mkdirSync(moduleRoot);
    fs.writeFileSync(path.join(moduleRoot, "go.mod"), `module example.com/${moduleName}\n\ngo 1.22\n`);
    fs.writeFileSync(path.join(moduleRoot, "shared_test.go"), "package placeholder\n");
  }
  const input = jsonLines([
    output("example.com/beta", "TestShared", "    shared_test.go:8: wrong beta\n"),
    event("fail", "example.com/beta", "TestShared")
  ]);

  const parsed = parseGoTestJson(input, {
    root,
    modules: [
      { root: alpha, valid: true },
      { root: beta, valid: true }
    ]
  });

  assert.deepEqual(parsed.relatedFiles, ["beta/shared_test.go"]);
});

test("verify executes Go tests as JSON but keeps the compact public command", { skip: !goAvailable }, () => {
  const root = fixture(["calc.go", "calc_test.go"]);
  fs.writeFileSync(path.join(root, "calc.go"), "package jsonfixture\n\nfunc Add(a, b int) int { return a - b }\n");
  fs.writeFileSync(path.join(root, "calc_test.go"), [
    "package jsonfixture",
    "import \"testing\"",
    "func TestAdd(t *testing.T) {",
    "  t.Run(\"positive\", func(t *testing.T) {",
    "    if Add(2, 3) != 5 { t.Fatal(\"bad sum\") }",
    "  })",
    "}",
    ""
  ].join("\n"));

  const result = spawnSync("node", [cli, "verify", "test"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const response = JSON.parse(result.stdout);
  assert.equal(response.command, "go test ./...");
  assert.equal(response.summary.failedTests, 1);
  assert.match(response.summary.mainError, /calc_test\.go:\d+: bad sum/);
  assert.ok(response.relatedFiles.includes("calc_test.go"));

  const log = fs.readFileSync(path.join(root, ".agentshell", "logs", `${response.logRef}.stdout.log`), "utf8");
  assert.match(log, /"Action":"fail"/);
  assert.match(log, /"Test":"TestAdd\/positive"/);
});

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-go-json-"));
  fs.writeFileSync(path.join(root, "go.mod"), "module example.com/json\n\ngo 1.22\n");
  for (const file of files) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "package placeholder\n");
  }
  return root;
}

function event(action, packageName, testName) {
  return {
    Time: "2026-07-28T00:00:00Z",
    Action: action,
    Package: packageName,
    ...(testName ? { Test: testName } : {})
  };
}

function output(packageName, testName, text) {
  return {
    ...event("output", packageName, testName),
    Output: text
  };
}

function jsonLines(events) {
  return events.map((item) => JSON.stringify(item)).join("\n");
}
