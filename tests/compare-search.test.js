import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { compareSearch } from "../src/commands/compare-search.js";
import { fallbackSearch, parseRipgrepJson } from "../src/core/compare-search.js";

test("compare search aligns bounded results by root and hides absolute paths", async () => {
  const php = fixture("php-service", {
    "src/Order.php": "class Order { // SharedOrder\n}\n",
    "tests/OrderTest.php": "// SharedOrder test\n"
  });
  const go = fixture("go-service", {
    "internal/order.go": "package order // SharedOrder\n",
    "internal/other.go": "package order // no match\n"
  });

  const result = await compareSearch([php, go], "SharedOrder", { compact: true, fixedStrings: true });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.compare-search.v1");
  assert.equal(result.summary.rootCount, 2);
  assert.equal(result.summary.rootsWithMatches, 2);
  assert.equal(result.summary.observedMatches, 3);
  assert.deepEqual(result.roots.map((root) => root.rootId), ["root-1", "root-2"]);
  assert.deepEqual(result.roots.map((root) => root.returnedMatches), [2, 1]);
  assert.equal(result.roots[0].matches[0].file, "src/Order.php");
  assert.equal(result.privacy.workspacePathsExposed, false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(escapeRegex(path.dirname(php))));
});

test("compare search distributes a global result budget across roots", async () => {
  const first = fixture("first", {
    "a.txt": "needle 1\nneedle 2\nneedle 3\nneedle 4\n"
  });
  const second = fixture("second", {
    "b.txt": "needle 1\nneedle 2\nneedle 3\nneedle 4\n"
  });

  const result = await compareSearch([first, second], "needle", {
    fixedStrings: true,
    maxMatches: 4,
    maxMatchesPerRoot: 4,
    maxMatchesPerFile: 4
  });

  assert.equal(result.ok, true);
  assert.equal(result.summary.returnedMatches, 4);
  assert.equal(result.summary.omittedMatches, 4);
  assert.equal(result.summary.truncated, true);
  assert.deepEqual(result.roots.map((root) => root.returnedMatches), [2, 2]);
});

test("compare search deterministically orders rg candidates before allocation", () => {
  const events = [
    rgMatch("tests/OrderTest.php", 3, 8, "needle test"),
    rgMatch("src/Order.php", 9, 5, "needle later"),
    rgMatch("src/Order.php", 2, 1, "needle first")
  ].join("\n");
  const parsed = parseRipgrepJson(events, { maxMatchesPerFile: 1, previewChars: 100 });

  assert.deepEqual(parsed.matches.map(({ file, line, column }) => ({ file, line, column })), [
    { file: "src/Order.php", line: 2, column: 1 },
    { file: "tests/OrderTest.php", line: 3, column: 8 }
  ]);
});

test("node fallback is deterministic and returns a structured timeout", async () => {
  const rootPath = fixture("fallback", {
    "z-last.txt": "needle z\n",
    "src/b.txt": "needle b\n",
    "src/a.txt": "needle a\n"
  });
  const root = { id: "root-1", name: "fallback", path: rootPath };
  const limits = { maxMatchesPerFile: 3, previewChars: 100 };

  const result = await fallbackSearch(root, "needle", limits, {
    fixedStrings: true,
    deadlineMs: Date.now() + 5_000
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.candidates.map((match) => match.file), [
    "src/a.txt", "src/b.txt", "z-last.txt"
  ]);

  const startedAt = Date.now();
  const timedOut = await fallbackSearch(root, "needle", limits, {
    fixedStrings: true,
    deadlineMs: Date.now() - 1
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.code, "SEARCH_TIMEOUT");
  assert.equal(timedOut.details.timedOut, true);
  assert.equal(timedOut.details.engine, "node-fallback");
  assert.ok(Date.now() - startedAt < 500);

  const busyRootPath = fixture("fallback-busy", {
    "large.txt": `${"no match\n".repeat(50_000)}needle\n`
  });
  const activeTimeout = await fallbackSearch(
    { id: "root-2", name: "fallback-busy", path: busyRootPath },
    "needle",
    limits,
    { fixedStrings: true, deadlineMs: Date.now() + 2 }
  );
  assert.equal(activeTimeout.ok, false);
  assert.equal(activeTimeout.code, "SEARCH_TIMEOUT");
  assert.equal(activeTimeout.details.timedOut, true);
});

test("compare search redacts secret-like preview values", async () => {
  const first = fixture("first", { "config.txt": "api_key=super-secret needle\n" });
  const second = fixture("second", { "config.txt": "authorization: Bearer abc123 needle\n" });

  const result = await compareSearch([first, second], "needle", { fixedStrings: true });
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.match(serialized, /\[REDACTED\]/);
  assert.doesNotMatch(serialized, /super-secret|abc123/);
});

test("compare search accepts non-git directories but rejects unsafe root sets", async () => {
  const first = fixture("first", { "a.txt": "needle\n" });
  const second = fixture("second", { "b.txt": "needle\n" });

  assert.equal((await compareSearch([first, second], "needle", { fixedStrings: true })).ok, true);
  assert.equal((await compareSearch([first], "needle")).error.code, "TOO_FEW_ROOTS");
  assert.equal((await compareSearch([first, first], "needle")).error.code, "DUPLICATE_ROOT");
  assert.equal((await compareSearch([os.homedir(), second], "needle")).error.code, "DANGEROUS_ROOT");
  assert.equal((await compareSearch([first, second], "   ")).error.code, "INVALID_ARGUMENT");
  assert.equal((await compareSearch([first, second], "[")).error.code, "INVALID_QUERY");
});

test("compare search schema exposes aligned roots, privacy, and shared failures", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/compare-search.schema.json", "utf8"));
  assert.equal(schema.title, "AgentShell Compare Search Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.compare-search.v1");
  assert.ok(schema.oneOf[0].required.includes("privacy"));
  assert.ok(schema.oneOf[0].properties.roots.items.required.includes("matches"));
  assert.equal(schema.oneOf[1].$ref, "common.schema.json#/$defs/failure");
});

function fixture(name, files) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-compare-search-"));
  const root = path.join(parent, name);
  fs.mkdirSync(root);
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rgMatch(file, line, column, preview) {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: file },
      line_number: line,
      lines: { text: `${preview}\n` },
      submatches: [{ start: column - 1 }]
    }
  });
}
