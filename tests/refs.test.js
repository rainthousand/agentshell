import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { refs } from "../src/commands/refs.js";

test("refs aggregates references by file and returns compact previews", async () => {
  const root = makeFixture({
    "src/app.js": "const targetSymbol = true;\nconsole.log(targetSymbol);\n",
    "src/util.js": "export function targetSymbol() {}\n"
  });

  const result = await refs(root, "targetSymbol", { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.refs.v1");
  assert.equal(result.compact, true);
  assert.equal(result.query, "targetSymbol");
  assert.equal(result.summary.totalMatches, 3);
  assert.equal(result.summary.returnedMatches, 3);
  assert.equal(result.summary.fileCount, 2);
  assert.equal(result.summary.limit, 40);
  assert.deepEqual(result.matches.map((entry) => entry.file).sort(), ["src/app.js", "src/util.js"]);
  assert.deepEqual(result.matches.find((entry) => entry.file === "src/app.js").lineNumbers, [1, 2]);
  assert.equal(result.matches.find((entry) => entry.file === "src/app.js").count, 2);
  assert.ok(result.matches.every((entry) => entry.preview.length <= 120));
  assert.ok(result.suggestedNextActions.length > 0);
});

test("refs truncates returned line numbers using options.limit", async () => {
  const root = makeFixture({
    "src/many.js": [
      "targetSymbol one",
      "targetSymbol two",
      "targetSymbol three"
    ].join("\n"),
    "src/other.js": "targetSymbol four\n"
  });

  const result = await refs(root, "targetSymbol", { compact: true, limit: 2 });

  assert.equal(result.ok, true);
  assert.equal(result.summary.totalMatches, 4);
  assert.equal(result.summary.returnedMatches, 2);
  assert.equal(result.summary.omittedMatches, 2);
  assert.equal(result.summary.truncated, true);
  assert.equal(result.matches.reduce((sum, entry) => sum + entry.lineNumbers.length, 0), 2);
});

test("refs ignores dependency and build output directories", async () => {
  const root = makeFixture({
    "src/app.js": "const targetSymbol = true;\n",
    "node_modules/pkg/index.js": "targetSymbol ignored\n",
    ".git/hooks/pre-commit": "targetSymbol ignored\n",
    "dist/bundle.js": "targetSymbol ignored\n",
    "build/app.js": "targetSymbol ignored\n",
    "coverage/report.txt": "targetSymbol ignored\n",
    ".agentshell/log.json": "targetSymbol ignored\n"
  });

  const result = await refs(root, "targetSymbol", { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.summary.totalMatches, 1);
  assert.deepEqual(result.matches.map((entry) => entry.file), ["src/app.js"]);
  assert.ok(result.summary.ignoredDirs.includes("node_modules"));
  assert.ok(result.summary.ignoredDirs.includes(".git"));
  assert.ok(result.summary.ignoredDirs.includes("dist"));
  assert.ok(result.summary.ignoredDirs.includes("build"));
  assert.ok(result.summary.ignoredDirs.includes("coverage"));
  assert.ok(result.summary.ignoredDirs.includes(".agentshell"));
});

test("refs reports missing query as invalid argument", async () => {
  const result = await refs(process.cwd(), "", { compact: true });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_ARGUMENT");
  assert.match(result.error.message, /agentshell refs <symbol>/);
});

test("refs exposes a parseable JSON schema contract", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/refs.schema.json", "utf8"));

  assert.equal(schema.title, "AgentShell Refs Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.refs.v1");
  assert.ok(schema.oneOf[0].required.includes("suggestedNextActions"));
  assert.ok(schema.oneOf[0].properties.matches.items.required.includes("lineNumbers"));
  assert.ok(schema.oneOf[0].properties.matches.items.required.includes("count"));
  assert.ok(schema.oneOf[0].properties.matches.items.required.includes("preview"));
});

function makeFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-refs-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}
