import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { grep } from "../src/commands/grep.js";

test("grep returns compact structured matches and ignores noisy directories", async () => {
  const root = makeFixture({
    "src/app.js": "const needle = true;\nconsole.log(needle);\n",
    "src/util.js": "export const value = 'needle';\n",
    "node_modules/pkg/index.js": "const needle = 'ignored';\n",
    "dist/bundle.js": "const needle = 'ignored';\n",
    "coverage/report.txt": "needle ignored\n"
  });

  const result = await grep(root, "needle", { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.grep.v1");
  assert.equal(result.compact, true);
  assert.equal(result.query, "needle");
  assert.equal(result.summary.totalMatches, 3);
  assert.equal(result.summary.returnedMatches, 3);
  assert.equal(result.summary.fileCount, 2);
  assert.equal(result.truncated.value, false);
  assert.deepEqual(
    result.results.map((entry) => entry.file).sort(),
    ["src/app.js", "src/app.js", "src/util.js"]
  );
  assert.ok(result.results.every((entry) => entry.line >= 1));
  assert.ok(result.results.every((entry) => entry.column >= 1));
  assert.ok(result.summary.ignoredDirs.includes("node_modules"));
  assert.ok(result.summary.ignoredDirs.includes("dist"));
  assert.ok(result.suggestedNextActions.length > 0);
});

test("grep reports per-file omissions and global truncation", async () => {
  const root = makeFixture({
    "src/many.js": [
      "needle one",
      "needle two",
      "needle three",
      "needle four"
    ].join("\n"),
    "src/other.js": "needle five\nneedle six\n"
  });

  const result = await grep(root, "needle", {
    compact: true,
    maxMatches: 3,
    maxMatchesPerFile: 2
  });

  assert.equal(result.ok, true);
  assert.equal(result.summary.totalMatches, 6);
  assert.equal(result.summary.returnedMatches, 3);
  assert.equal(result.summary.omittedMatches, 3);
  assert.equal(result.truncated.value, true);
  assert.equal(result.truncated.omittedMatches, 3);
  assert.equal(result.files.find((entry) => entry.file === "src/many.js").omitted, 2);
});

test("grep filters language aliases and ignores generated and vendor trees", async () => {
  const root = makeFixture({
    "src/app.py": "needle = True\n",
    "src/app.go": "var needle = true\n",
    "vendor/pkg/ignored.py": "needle = True\n",
    "generated/client.py": "needle = True\n"
  });

  const result = await grep(root, "needle", { compact: true, type: "py" });

  assert.equal(result.ok, true);
  assert.equal(result.type, "python");
  assert.deepEqual(result.results.map((entry) => entry.file), ["src/app.py"]);
  assert.ok(result.summary.ignoredDirs.includes("vendor"));
  assert.ok(result.summary.ignoredDirs.includes("generated"));
});

test("grep returns bounded line context and category groups", async () => {
  const root = makeFixture({
    "src/app.ts": "before\nconst needle = true;\nafter\n",
    "tests/app.test.ts": "setup\nexpect(needle).toBe(true);\nteardown\n",
    "docs/guide.md": "intro\nneedle\noutro\n"
  });

  const result = await grep(root, "needle", { compact: true, type: "typescript", context: 1 });

  assert.equal(result.ok, true);
  assert.equal(result.summary.limits.contextLines, 1);
  assert.deepEqual(result.results[0].before, [{ line: 1, text: "before" }]);
  assert.deepEqual(result.results[0].after, [{ line: 3, text: "after" }]);
  assert.deepEqual(result.groups.map((entry) => entry.category), ["source", "test"]);
  assert.equal(result.files.find((entry) => entry.file === "tests/app.test.ts").category, "test");
});

test("grep files-with-matches mode omits line payloads", async () => {
  const root = makeFixture({
    "src/app.java": "class App { String needle; }\n",
    "src/Other.java": "class Other { String needle; }\n"
  });

  const result = await grep(root, "needle", { filesWithMatches: true, type: "java" });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "files");
  assert.equal(result.summary.fileCount, 2);
  assert.equal(result.summary.totalMatches, 2);
  assert.deepEqual(result.results, []);
  assert.ok(result.files.every((entry) => entry.returned === 0));
});

test("grep files-with-matches mode bounds file summaries and reports omissions", async () => {
  const root = makeFixture({
    "src/a.ts": "needle\n",
    "src/b.ts": "needle\nneedle\n",
    "tests/c.test.ts": "needle\n",
    "docs/d.md": "needle\n"
  });

  const result = await grep(root, "needle", { filesWithMatches: true, maxMatches: 2 });

  assert.equal(result.ok, true);
  assert.deepEqual(result.files.map((entry) => entry.file), ["src/a.ts", "src/b.ts"]);
  assert.equal(result.summary.fileCount, 4);
  assert.equal(result.summary.returnedFileCount, 2);
  assert.equal(result.summary.omittedFileCount, 2);
  assert.equal(result.summary.omittedMatches, 2);
  assert.equal(result.truncated.value, true);
  assert.equal(result.truncated.omittedFiles, 2);
});

test("grep caps requested context to keep output bounded", async () => {
  const root = makeFixture({ "src/app.go": "before\nneedle\nafter\n" });

  const result = await grep(root, "needle", { type: "golang", context: 1000 });

  assert.equal(result.ok, true);
  assert.equal(result.type, "go");
  assert.equal(result.summary.limits.contextLines, 20);
});

test("grep rejects unknown language filters", async () => {
  const result = await grep(makeFixture({ "src/app.js": "needle\n" }), "needle", { type: "brainfuck" });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_ARGUMENT");
  assert.ok(result.error.details.supportedTypes.includes("go"));
});

test("grep exposes a parseable JSON schema contract", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/grep.schema.json", "utf8"));

  assert.equal(schema.title, "AgentShell Grep Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.grep.v1");
  assert.ok(schema.oneOf[0].required.includes("suggestedNextActions"));
  assert.ok(schema.oneOf[0].properties.results.items.required.includes("column"));
  assert.ok(schema.oneOf[0].properties.results.items.required.includes("before"));
  assert.ok(schema.oneOf[0].properties.summary.properties.limits.required.includes("contextLines"));
});

function makeFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-grep-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}
