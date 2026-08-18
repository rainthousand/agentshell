import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { errorsFromLog, parseErrorsFromLogOptions, summarizeLogText } from "../src/commands/errors-from-log.js";

test("errors from log extracts Node TAP and stack failures without returning full logs", async () => {
  const root = makeFixture({
    "logs/node.log": [
      "TAP version 13",
      "# Subtest: rejects bad input",
      "not ok 1 - rejects bad input",
      "  ---",
      "  error: 'AssertionError [ERR_ASSERTION]: expected 1 to equal 2'",
      "  stack: |-",
      "    AssertionError [ERR_ASSERTION]: expected 1 to equal 2",
      "        at Object.<anonymous> (/workspace/src/math.test.js:12:7)",
      "        at Test.run (node:internal/test_runner/test:1054:7)",
      "  ..."
    ].join("\n")
  });

  const result = await errorsFromLog(root, "logs/node.log", { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.errors-from-log.v1");
  assert.equal(result.compact, true);
  assert.equal(result.source.path, "logs/node.log");
  assert.equal(result.summary.errorCount >= 1, true);
  assert.equal(result.summary.returnedErrors >= 1, true);
  assert.equal(result.summary.truncated, false);
  assert.ok(result.errors.some((entry) => entry.type === "tap-fail"));
  assert.ok(result.errors.some((entry) => entry.type === "assertion"));
  assert.ok(result.errors.some((entry) => entry.file === "/workspace/src/math.test.js" && entry.line === 12 && entry.column === 7));
  assert.ok(result.errors.every((entry) => entry.snippet.length <= 280));
  assert.equal(JSON.stringify(result).includes("TAP version 13"), false);
  assert.ok(result.suggestedNextActions.length > 0);
});

test("errors from log extracts Go test failures and panics", async () => {
  const root = makeFixture({
    "logs/go.log": [
      "=== RUN   TestAdd",
      "--- FAIL: TestAdd (0.00s)",
      "    calc_test.go:17: expected 2, got 3",
      "panic: runtime error: invalid memory address or nil pointer dereference",
      "goroutine 7 [running]:",
      "example.com/demo.(*Server).Serve(0x0)",
      "    /tmp/demo/server.go:44 +0x25",
      "FAIL\texample.com/demo\t0.123s",
      "FAIL"
    ].join("\n")
  });

  const result = await errorsFromLog(root, "logs/go.log", { compact: true });

  assert.equal(result.ok, true);
  assert.ok(result.errors.some((entry) => entry.type === "go-test-fail" && entry.file === "calc_test.go" && entry.line === 17));
  assert.ok(result.errors.some((entry) => entry.type === "panic" && entry.message.includes("nil pointer")));
  assert.ok(result.errors.every((entry) => !entry.snippet.includes("=== RUN   TestAdd") || entry.snippet.length <= 280));
});

test("errors from log truncates large logs and snippets", async () => {
  const noise = Array.from({ length: 60000 }, (_, index) => `noise line ${index}`).join("\n");
  const root = makeFixture({
    "logs/large.log": [
      "Error: short failure",
      "    at run (/tmp/app.js:3:4)",
      noise
    ].join("\n")
  });

  const result = await errorsFromLog(root, "logs/large.log", { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.source.truncated, true);
  assert.equal(result.summary.truncated, true);
  assert.ok(result.errors.length >= 1);
  assert.ok(result.errors.every((entry) => entry.snippet.length <= 280));
  assert.equal(JSON.stringify(result).includes("noise line 8999"), false);
});

test("errors from log reports missing arg, outside root, and missing file errors", async () => {
  const root = makeFixture({});

  const missingArg = parseErrorsFromLogOptions(undefined, { compact: true });
  const outsideRoot = await errorsFromLog(root, "../outside.log", { compact: true });
  const missingPath = await errorsFromLog(root, "missing.log", { compact: true });

  assert.equal(missingArg.ok, false);
  assert.equal(missingArg.error.code, "INVALID_ARGUMENT");
  assert.equal(outsideRoot.ok, false);
  assert.equal(outsideRoot.error.code, "FILE_OUTSIDE_WORKSPACE");
  assert.equal(missingPath.ok, false);
  assert.equal(missingPath.error.code, "FILE_NOT_FOUND");
  assert.deepEqual(missingPath.error.details, { path: "missing.log", exists: false });
});

test("errors from log schema exposes compact response contract", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/errors-from-log.schema.json", "utf8"));

  assert.equal(schema.title, "AgentShell Errors From Log Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.errors-from-log.v1");
  assert.deepEqual(schema.oneOf[0].required, ["ok", "protocolVersion", "compact", "source", "summary", "errors", "suggestedNextActions"]);
  assert.deepEqual(schema.$defs.logError.required, ["message", "type", "file", "line", "column", "confidence", "snippet"]);
  assert.equal(schema.$defs.logError.properties.snippet.maxLength, 280);
});

test("summarizeLogText supports stdin-oriented callers", () => {
  const result = summarizeLogText("ReferenceError: value is not defined\n    at main (app.js:5:2)\n", {
    compact: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.source.kind, "text");
  assert.equal(result.errors[0].type, "node-error");
  assert.equal(result.errors[0].file, "app.js");
  assert.equal(result.errors[0].line, 5);
});

function makeFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-errors-from-log-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}
