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

test("grep exposes a parseable JSON schema contract", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/grep.schema.json", "utf8"));

  assert.equal(schema.title, "AgentShell Grep Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.grep.v1");
  assert.ok(schema.oneOf[0].required.includes("suggestedNextActions"));
  assert.ok(schema.oneOf[0].properties.results.items.required.includes("column"));
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
