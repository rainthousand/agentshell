import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { suggestChange } from "../src/commands/change.js";

const cli = path.resolve("src/cli.js");

test("change suggest reports unsupportedReason when there is no active diagnosis", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-suggest-"));

  const suggestion = run(dir, ["change", "suggest", "--dry-run", "--compact"]);
  assert.equal(suggestion.status, 1);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.ok, false);
  assert.equal(suggestionOutput.error.code, "NO_CHANGE_SUGGESTION");
  assert.equal(suggestionOutput.error.details.unsupportedReason, "no-active-diagnosis");
  assert.match(suggestionOutput.error.suggestedNextActions[0].command, /diagnose test --compact/);
});

test("change suggest replaces a wrong returned literal when assertion shows expected value", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-suggest-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "suggest-demo",
    type: "module",
    scripts: {
      test: "node test/status.test.js"
    }
  }, null, 2));
  fs.writeFileSync(path.join(dir, "src", "status.js"), [
    "export function getStatus() {",
    "  return \"pending\";",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "test", "status.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { getStatus } from '../src/status.js';",
    "assert.equal(getStatus(), 'ready');",
    ""
  ].join("\n"));

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);
  const diagnosisOutput = JSON.parse(diagnosis.stdout);
  assert.equal(diagnosisOutput.fixPlan.target.file, "src/status.js");

  const preview = run(dir, ["change", "suggest", "--dry-run", "--compact"]);
  assert.equal(preview.status, 0);
  const previewOutput = JSON.parse(preview.stdout);
  assert.equal(previewOutput.ok, true);
  assert.equal(previewOutput.compact, true);
  assert.equal(previewOutput.dryRun, true);
  assert.equal(previewOutput.strategy, "literal-replacement");
  assert.equal(previewOutput.preview.file, "src/status.js");
  assert.deepEqual(previewOutput.preview.range, { start: 1, end: 4 });
  assert.equal(previewOutput.preview.fill, previewOutput.fill);
  const fillOutput = JSON.parse(fs.readFileSync(path.join(dir, previewOutput.preview.fill), "utf8"));
  assert.match(fillOutput.replacement, /return "ready";/);
  assert.equal(Object.hasOwn(previewOutput, "replacement"), false);
  assert.match(previewOutput.suggestedNextActions[0].command, /change fill .* --apply/);
  assert.match(fs.readFileSync(path.join(dir, "src", "status.js"), "utf8"), /pending/);

  const suggestion = run(dir, ["change", "suggest", "--apply"]);
  assert.equal(suggestion.status, 0);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.ok, true);
  assert.equal(suggestionOutput.dryRun, false);
  assert.match(suggestionOutput.replacement, /return "ready";/);
  assert.deepEqual(suggestionOutput.applied.changedFiles, ["src/status.js"]);

  const verify = run(dir, ["verify", "test"]);
  assert.equal(verify.status, 0);
  const verifyOutput = JSON.parse(verify.stdout);
  assert.equal(verifyOutput.ok, true);
});

test("change suggest preserves single quote style for simple string literals", () => {
  const dir = makeProject("quote-demo", [
    "export function getStatus() {",
    "  return 'pending';",
    "}",
    ""
  ], [
    "import assert from 'node:assert/strict';",
    "import { getStatus } from '../src/status.js';",
    "assert.equal(getStatus(), 'ready');",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);

  const suggestion = run(dir, ["change", "suggest", "--apply", "--compact"]);
  assert.equal(suggestion.status, 0);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.strategy, "literal-replacement");
  assert.deepEqual(suggestionOutput.applied.changedFiles, ["src/status.js"]);
  assert.match(fs.readFileSync(path.join(dir, "src", "status.js"), "utf8"), /return 'ready';/);
});

test("change suggest repairs an empty join separator from string assertion values", () => {
  const dir = makeProject("join-separator-demo", [
    "export function format(...parts) {",
    "  return parts.join('');",
    "}",
    ""
  ], [
    "import assert from 'node:assert/strict';",
    "import { format } from '../src/status.js';",
    "assert.equal(format('hello', 'there'), 'hello there');",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);

  const suggestion = run(dir, ["change", "suggest", "--apply", "--compact"]);
  assert.equal(suggestion.status, 0, suggestion.stderr || suggestion.stdout);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.strategy, "join-separator-literal");
  assert.deepEqual(suggestionOutput.applied.changedFiles, ["src/status.js"]);
  assert.match(fs.readFileSync(path.join(dir, "src", "status.js"), "utf8"), /join\(' '\)/);
});

test("change suggest repairs a simple string case transform", () => {
  const dir = makeProject("string-case-demo", [
    "export function shout(name) {",
    "  return name;",
    "}",
    ""
  ], [
    "import assert from 'node:assert/strict';",
    "import { shout } from '../src/status.js';",
    "assert.equal(shout('ada'), 'ADA');",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);

  const suggestion = run(dir, ["change", "suggest", "--apply", "--compact"]);
  assert.equal(suggestion.status, 0, suggestion.stderr || suggestion.stdout);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.strategy, "string-case-transform");
  assert.deepEqual(suggestionOutput.applied.changedFiles, ["src/status.js"]);
  assert.match(fs.readFileSync(path.join(dir, "src", "status.js"), "utf8"), /return name\.toUpperCase\(\);/);

  const verify = run(dir, ["verify", "test"]);
  assert.equal(verify.status, 0);
});

test("change suggest refuses ambiguous string case transforms", () => {
  const dir = makeProject("ambiguous-string-case-demo", [
    "export function shout(name, fallback) {",
    "  const local = name;",
    "  return fallback || local;",
    "}",
    ""
  ], [
    "import assert from 'node:assert/strict';",
    "import { shout } from '../src/status.js';",
    "assert.equal(shout('ada', ''), 'ADA');",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);

  const suggestion = run(dir, ["change", "suggest", "--dry-run", "--compact"]);
  assert.equal(suggestion.status, 1);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.ok, false);
  assert.equal(suggestionOutput.error.details.unsupportedReason, "unsupported-pattern");
});

test("change suggest reads AVA-style reverse string diffs", () => {
  const dir = makeProject("ava-diff-demo", [
    "export function format(...parts) {",
    "  return parts.join('');",
    "}",
    ""
  ], [
    "import { format } from '../src/status.js';",
    "console.log(\"Difference:\\n\\n- 'hellothere'\\n+ 'hello there'\\n\\n› file://test/status.test.js:3:8\");",
    "process.exit(format ? 1 : 1);",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);

  const suggestion = run(dir, ["change", "suggest", "--apply", "--compact"]);
  assert.equal(suggestion.status, 0, suggestion.stderr || suggestion.stdout);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.strategy, "join-separator-literal");
  assert.match(fs.readFileSync(path.join(dir, "src", "status.js"), "utf8"), /join\(' '\)/);
});

test("change suggest --apply returns failure when apply sees a stale target", async () => {
  const dir = makeProject("stale-apply-demo", [
    "export function getStatus() {",
    "  return \"pending\";",
    "}",
    ""
  ], [
    "import assert from 'node:assert/strict';",
    "import { getStatus } from '../src/status.js';",
    "assert.equal(getStatus(), 'ready');",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);

  const originalWriteFileSync = fs.writeFileSync;
  let changedAfterSuggestedFill = false;
  fs.writeFileSync = function writeFileSyncWithStaleTarget(file, data, options) {
    const result = originalWriteFileSync.call(this, file, data, options);
    if (
      !changedAfterSuggestedFill
      && typeof file === "string"
      && path.dirname(file).endsWith(path.join(".agentshell", "change-templates"))
      && path.basename(file).startsWith("fill_")
    ) {
      changedAfterSuggestedFill = true;
      originalWriteFileSync(path.join(dir, "src", "status.js"), [
        "export function getStatus() {",
        "  return \"changed\";",
        "}",
        ""
      ].join("\n"));
    }
    return result;
  };

  try {
    const suggestion = await suggestChange(dir, { apply: true, compact: true });
    assert.equal(changedAfterSuggestedFill, true);
    assert.equal(suggestion.ok, false);
    assert.equal(suggestion.applied.ok, false);
    assert.equal(suggestion.applied.error.code, "HASH_MISMATCH");
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
});

test("change suggest uses assertion expected value for a missing object property", () => {
  const dir = makeProject("role-demo", [
    "export function createUser(input) {",
    "  return {",
    "    name: input.name",
    "  };",
    "}",
    ""
  ], [
    "import assert from 'node:assert/strict';",
    "import { createUser } from '../src/status.js';",
    "const user = createUser({ name: 'Ada' });",
    "assert.equal(user.role, 'admin', 'Expected user.role to be set');",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);

  const suggestion = run(dir, ["change", "suggest", "--apply", "--compact"]);
  assert.equal(suggestion.status, 0);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.strategy, "missing-object-property");
  assert.deepEqual(suggestionOutput.applied.changedFiles, ["src/status.js"]);
  assert.match(fs.readFileSync(path.join(dir, "src", "status.js"), "utf8"), /role: "admin"/);

  const verify = run(dir, ["verify", "test"]);
  assert.equal(verify.status, 0);
});

test("change suggest adds a flat missing property from deepEqual expected object", () => {
  const dir = makeProject("deep-equal-demo", [
    "export function createUser() {",
    "  return { name: 'Ada' };",
    "}",
    ""
  ], [
    "import assert from 'node:assert/strict';",
    "import { createUser } from '../src/status.js';",
    "assert.deepEqual(createUser(), { name: 'Ada', active: true });",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);

  const suggestion = run(dir, ["change", "suggest", "--apply", "--compact"]);
  assert.equal(suggestion.status, 0, suggestion.stderr || suggestion.stdout);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.strategy, "deep-equal-missing-property");
  assert.deepEqual(suggestionOutput.applied.changedFiles, ["src/status.js"]);
  assert.match(fs.readFileSync(path.join(dir, "src", "status.js"), "utf8"), /active: true/);

  const verify = run(dir, ["verify", "test"]);
  assert.equal(verify.status, 0);
});

test("change suggest appends simple missing array elements from deepEqual expected array", () => {
  const dir = makeProject("deep-equal-array-demo", [
    "export function tags() {",
    "  return [\"a\"];",
    "}",
    ""
  ], [
    "import assert from 'node:assert/strict';",
    "import { tags } from '../src/status.js';",
    "assert.deepEqual(tags(), [\"a\", \"b\"]);",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);

  const suggestion = run(dir, ["change", "suggest", "--apply", "--compact"]);
  assert.equal(suggestion.status, 0, suggestion.stderr || suggestion.stdout);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.strategy, "deep-equal-array-elements");
  assert.deepEqual(suggestionOutput.applied.changedFiles, ["src/status.js"]);
  assert.match(fs.readFileSync(path.join(dir, "src", "status.js"), "utf8"), /return \["a", "b"\];/);

  const verify = run(dir, ["verify", "test"]);
  assert.equal(verify.status, 0);
});

test("change suggest removes simple extra tail elements from deepEqual expected array", () => {
  const dir = makeProject("deep-equal-array-removal-demo", [
    "export function tags() {",
    "  return [\"a\", \"b\"];",
    "}",
    ""
  ], [
    "import assert from 'node:assert/strict';",
    "import { tags } from '../src/status.js';",
    "assert.deepEqual(tags(), [\"a\"]);",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);

  const suggestion = run(dir, ["change", "suggest", "--apply", "--compact"]);
  assert.equal(suggestion.status, 0, suggestion.stderr || suggestion.stdout);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.strategy, "deep-equal-array-removal");
  assert.deepEqual(suggestionOutput.applied.changedFiles, ["src/status.js"]);
  assert.match(fs.readFileSync(path.join(dir, "src", "status.js"), "utf8"), /return \["a"\];/);

  const verify = run(dir, ["verify", "test"]);
  assert.equal(verify.status, 0);
});

test("change suggest removes simple multiline extra tail elements from deepEqual expected array", () => {
  const dir = makeProject("deep-equal-array-multiline-removal-demo", [
    "export function tags() {",
    "  return [",
    "    \"a\",",
    "    \"b\"",
    "  ];",
    "}",
    ""
  ], [
    "import assert from 'node:assert/strict';",
    "import { tags } from '../src/status.js';",
    "assert.deepEqual(tags(), [\"a\"]);",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);

  const suggestion = run(dir, ["change", "suggest", "--apply", "--compact"]);
  assert.equal(suggestion.status, 0, suggestion.stderr || suggestion.stdout);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.strategy, "deep-equal-array-removal");
  assert.deepEqual(suggestionOutput.applied.changedFiles, ["src/status.js"]);
  const source = fs.readFileSync(path.join(dir, "src", "status.js"), "utf8");
  assert.match(source, /"a"\n\s+\]/);
  assert.doesNotMatch(source, /"b"/);

  const verify = run(dir, ["verify", "test"]);
  assert.equal(verify.status, 0);
});

test("change suggest removes a simple extra property from deepEqual expected object", () => {
  const dir = makeProject("deep-equal-extra-property-demo", [
    "export function createUser() {",
    "  return { name: 'Ada', active: true };",
    "}",
    ""
  ], [
    "import assert from 'node:assert/strict';",
    "import { createUser } from '../src/status.js';",
    "assert.deepEqual(createUser(), { name: 'Ada' });",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);

  const suggestion = run(dir, ["change", "suggest", "--apply", "--compact"]);
  assert.equal(suggestion.status, 0, suggestion.stderr || suggestion.stdout);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.strategy, "deep-equal-extra-property-removal");
  assert.deepEqual(suggestionOutput.applied.changedFiles, ["src/status.js"]);
  const source = fs.readFileSync(path.join(dir, "src", "status.js"), "utf8");
  assert.match(source, /return \{ name: 'Ada' \};/);
  assert.doesNotMatch(source, /active/);

  const verify = run(dir, ["verify", "test"]);
  assert.equal(verify.status, 0);
});

test("change suggest replaces a simple primitive element from deepEqual expected array", () => {
  const dir = makeProject("deep-equal-array-primitive-replacement-demo", [
    "export function tags() {",
    "  return ['a', 'b'];",
    "}",
    ""
  ], [
    "import assert from 'node:assert/strict';",
    "import { tags } from '../src/status.js';",
    "assert.deepEqual(tags(), ['a', 'c']);",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);

  const suggestion = run(dir, ["change", "suggest", "--apply", "--compact"]);
  assert.equal(suggestion.status, 0, suggestion.stderr || suggestion.stdout);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.strategy, "deep-equal-array-primitive-replacement");
  assert.deepEqual(suggestionOutput.applied.changedFiles, ["src/status.js"]);
  assert.match(fs.readFileSync(path.join(dir, "src", "status.js"), "utf8"), /return \['a', 'c'\];/);

  const verify = run(dir, ["verify", "test"]);
  assert.equal(verify.status, 0);
});

test("change suggest refuses ambiguous deepEqual array primitive replacements", () => {
  const dir = makeProject("deep-equal-array-ambiguous-primitive-replacement-demo", [
    "export function tags() {",
    "  return ['b', 'b'];",
    "}",
    ""
  ], [
    "import assert from 'node:assert/strict';",
    "import { tags } from '../src/status.js';",
    "assert.deepEqual(tags(), ['c', 'b']);",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);

  const suggestion = run(dir, ["change", "suggest", "--dry-run", "--compact"]);
  assert.equal(suggestion.status, 1);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.error.code, "SUGGESTION_UNAVAILABLE");
  assert.equal(suggestionOutput.error.details.unsupportedReason, "unsupported-pattern");
});

test("change suggest conservatively fills a simple returned array length mismatch", () => {
  const dir = makeProject("array-length-demo", [
    "export function tags() {",
    "  return [",
    "    \"a\"",
    "  ];",
    "}",
    ""
  ], [
    "import assert from 'node:assert/strict';",
    "import { tags } from '../src/status.js';",
    "assert.equal(tags().length, 2);",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);

  const suggestion = run(dir, ["change", "suggest", "--apply", "--compact"]);
  assert.equal(suggestion.status, 0, suggestion.stderr || suggestion.stdout);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.strategy, "array-length");
  assert.deepEqual(suggestionOutput.applied.changedFiles, ["src/status.js"]);
  assert.match(fs.readFileSync(path.join(dir, "src", "status.js"), "utf8"), /"a",\n    undefined/);

  const verify = run(dir, ["verify", "test"]);
  assert.equal(verify.status, 0);
});

test("change suggest repairs a simple falsy return for assert.ok", () => {
  const dir = makeProject("truthy-demo", [
    "export function isReady() {",
    "  return false;",
    "}",
    ""
  ], [
    "import assert from 'node:assert/strict';",
    "import { isReady } from '../src/status.js';",
    "assert.ok(isReady());",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);

  const suggestion = run(dir, ["change", "suggest", "--apply", "--compact"]);
  assert.equal(suggestion.status, 0);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.strategy, "truthy-return");
  assert.deepEqual(suggestionOutput.applied.changedFiles, ["src/status.js"]);
  assert.match(fs.readFileSync(path.join(dir, "src", "status.js"), "utf8"), /return true;/);

  const verify = run(dir, ["verify", "test"]);
  assert.equal(verify.status, 0);
});

test("change suggest exports a uniquely declared missing named export", () => {
  const dir = makeProject("export-demo", [
    "function makeUser(input) {",
    "  return {",
    "    name: input.name",
    "  };",
    "}",
    ""
  ], [
    "import assert from 'node:assert/strict';",
    "import { makeUser } from '../src/status.js';",
    "assert.equal(makeUser({ name: 'Ada' }).name, 'Ada');",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);
  const diagnosisOutput = JSON.parse(diagnosis.stdout);
  assert.equal(diagnosisOutput.fixPlan.target.file, "src/status.js");

  const suggestion = run(dir, ["change", "suggest", "--apply", "--compact"]);
  assert.equal(suggestion.status, 0, suggestion.stderr || suggestion.stdout);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.strategy, "missing-named-export");
  assert.deepEqual(suggestionOutput.applied.changedFiles, ["src/status.js"]);
  assert.match(fs.readFileSync(path.join(dir, "src", "status.js"), "utf8"), /^export function makeUser/m);

  const verify = run(dir, ["verify", "test"]);
  assert.equal(verify.status, 0);
});

test("change suggest repairs a unique local import path typo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-suggest-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "import-path-demo",
    type: "module",
    scripts: {
      test: "node test/user.test.js"
    }
  }, null, 2));
  fs.writeFileSync(path.join(dir, "src", "user.js"), [
    "export function makeUser(input) {",
    "  return { name: input.name };",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "test", "user.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { makeUser } from '../src/usre.js';",
    "assert.equal(makeUser({ name: 'Ada' }).name, 'Ada');",
    ""
  ].join("\n"));

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);
  const diagnosisOutput = JSON.parse(diagnosis.stdout);
  assert.equal(diagnosisOutput.fixPlan.confidence, "medium");
  assert.equal(diagnosisOutput.fixPlan.target.file, "test/user.test.js");
  assert.deepEqual(diagnosisOutput.fixPlan.target.range, { start: 2, end: 2 });
  assert.match(diagnosisOutput.fixPlan.target.intent, /`..\/src\/usre\.js` with `..\/src\/user\.js`/);

  const suggestion = run(dir, ["change", "suggest", "--apply", "--compact"]);
  assert.equal(suggestion.status, 0, suggestion.stderr || suggestion.stdout);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.strategy, "import-path");
  assert.deepEqual(suggestionOutput.applied.changedFiles, ["test/user.test.js"]);
  assert.match(fs.readFileSync(path.join(dir, "test", "user.test.js"), "utf8"), /..\/src\/user\.js/);

  const verify = run(dir, ["verify", "test"]);
  assert.equal(verify.status, 0);
});

test("change suggest repairs a missing local import extension", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-suggest-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "missing-extension-import-demo",
    type: "module",
    scripts: {
      test: "node test/user.test.js"
    }
  }, null, 2));
  fs.writeFileSync(path.join(dir, "src", "user.js"), "export const user = { name: 'Ada' };\n");
  fs.writeFileSync(path.join(dir, "test", "user.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { user } from '../src/user';",
    "assert.equal(user.name, 'Ada');",
    ""
  ].join("\n"));

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);
  const diagnosisOutput = JSON.parse(diagnosis.stdout);
  assert.equal(diagnosisOutput.fixPlan.confidence, "medium");
  assert.equal(diagnosisOutput.fixPlan.target.file, "test/user.test.js");
  assert.deepEqual(diagnosisOutput.fixPlan.target.range, { start: 2, end: 2 });
  assert.match(diagnosisOutput.fixPlan.target.intent, /`..\/src\/user` with `..\/src\/user\.js`/);

  const suggestion = run(dir, ["change", "suggest", "--apply", "--compact"]);
  assert.equal(suggestion.status, 0, suggestion.stderr || suggestion.stdout);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.strategy, "import-path");
  assert.deepEqual(suggestionOutput.applied.changedFiles, ["test/user.test.js"]);
  assert.match(fs.readFileSync(path.join(dir, "test", "user.test.js"), "utf8"), /..\/src\/user\.js/);

  const verify = run(dir, ["verify", "test"]);
  assert.equal(verify.status, 0);
});

test("change suggest repairs a unique directory index import", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-suggest-"));
  fs.mkdirSync(path.join(dir, "src", "user"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "directory-index-import-demo",
    type: "module",
    scripts: {
      test: "node test/user.test.js"
    }
  }, null, 2));
  fs.writeFileSync(path.join(dir, "src", "user", "index.js"), "export const user = { name: 'Ada' };\n");
  fs.writeFileSync(path.join(dir, "test", "user.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { user } from '../src/user';",
    "assert.equal(user.name, 'Ada');",
    ""
  ].join("\n"));

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);
  const diagnosisOutput = JSON.parse(diagnosis.stdout);
  assert.equal(diagnosisOutput.fixPlan.confidence, "medium");
  assert.equal(diagnosisOutput.fixPlan.target.file, "test/user.test.js");
  assert.deepEqual(diagnosisOutput.fixPlan.target.range, { start: 2, end: 2 });
  assert.match(diagnosisOutput.fixPlan.target.intent, /`..\/src\/user` with `..\/src\/user\/index\.js`/);

  const suggestion = run(dir, ["change", "suggest", "--apply", "--compact"]);
  assert.equal(suggestion.status, 0, suggestion.stderr || suggestion.stdout);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.strategy, "import-path");
  assert.deepEqual(suggestionOutput.applied.changedFiles, ["test/user.test.js"]);
  assert.match(fs.readFileSync(path.join(dir, "test", "user.test.js"), "utf8"), /..\/src\/user\/index\.js/);

  const verify = run(dir, ["verify", "test"]);
  assert.equal(verify.status, 0);
});

test("change suggest repairs a unique CommonJS import path typo without an extension", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-suggest-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "commonjs-extensionless-typo-import-demo",
    scripts: {
      test: "node test/user.test.cjs"
    }
  }, null, 2));
  fs.writeFileSync(path.join(dir, "src", "user.js"), "module.exports = { user: { name: 'Ada' } };\n");
  fs.writeFileSync(path.join(dir, "test", "user.test.cjs"), [
    "const assert = require('node:assert/strict');",
    "const { user } = require('../src/usre');",
    "assert.equal(user.name, 'Ada');",
    ""
  ].join("\n"));

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);
  const diagnosisOutput = JSON.parse(diagnosis.stdout);
  assert.equal(diagnosisOutput.fixPlan.confidence, "medium");
  assert.equal(diagnosisOutput.fixPlan.target.file, "test/user.test.cjs");
  assert.deepEqual(diagnosisOutput.fixPlan.target.range, { start: 2, end: 2 });
  assert.match(diagnosisOutput.fixPlan.target.intent, /`..\/src\/usre` with `..\/src\/user\.js`/);

  const suggestion = run(dir, ["change", "suggest", "--apply", "--compact"]);
  assert.equal(suggestion.status, 0, suggestion.stderr || suggestion.stdout);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.strategy, "import-path");
  assert.deepEqual(suggestionOutput.applied.changedFiles, ["test/user.test.cjs"]);
  assert.match(fs.readFileSync(path.join(dir, "test", "user.test.cjs"), "utf8"), /..\/src\/user\.js/);

  const verify = run(dir, ["verify", "test"]);
  assert.equal(verify.status, 0);
});

test("change suggest repairs a simple TypeScript missing-property diagnostic", () => {
  const dir = makeTypeScriptDiagnosticProject("ts-missing-property-demo", [
    "interface User {",
    "  name: string;",
    "  id: string;",
    "}",
    "export function createUser(name: string): User {",
    "  return { name };",
    "}",
    ""
  ], [
    "const fs = require('node:fs');",
    "const source = fs.readFileSync('src/user.ts', 'utf8');",
    "if (!/return\\s*\\{[^}]*\\bid\\s*:/.test(source)) {",
    "  console.error(\"src/user.ts(6,3): error TS2741: Property 'id' is missing in type '{ name: string; }' but required in type 'User'.\");",
    "  process.exit(1);",
    "}",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);
  const diagnosisOutput = JSON.parse(diagnosis.stdout);
  assert.equal(diagnosisOutput.fixPlan.confidence, "medium");
  assert.equal(diagnosisOutput.fixPlan.target.file, "src/user.ts");
  assert.deepEqual(diagnosisOutput.fixPlan.target.range, { start: 6, end: 6 });
  assert.match(diagnosisOutput.fixPlan.target.intent, /TypeScript TS2741/);
  assert.match(diagnosisOutput.fixPlan.target.intent, /`id` with a string value/);
  assert.ok(diagnosisOutput.changeTemplate.path);

  const suggestion = run(dir, ["change", "suggest", "--apply", "--compact"]);
  assert.equal(suggestion.status, 0, suggestion.stderr || suggestion.stdout);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.strategy, "typescript-missing-property");
  assert.deepEqual(suggestionOutput.applied.changedFiles, ["src/user.ts"]);
  assert.match(fs.readFileSync(path.join(dir, "src", "user.ts"), "utf8"), /return \{ name, id: "" \};/);

  const verify = run(dir, ["verify", "test"]);
  assert.equal(verify.status, 0);
});

test("change suggest repairs a simple TypeScript literal mismatch diagnostic", () => {
  const dir = makeTypeScriptDiagnosticProject("ts-literal-mismatch-demo", [
    "const count: number = \"1\";",
    "console.log(count);",
    ""
  ], [
    "const fs = require('node:fs');",
    "const source = fs.readFileSync('src/user.ts', 'utf8');",
    "if (!/const count: number = 0;/.test(source)) {",
    "  console.error(\"src/user.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\");",
    "  process.exit(1);",
    "}",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);
  const diagnosisOutput = JSON.parse(diagnosis.stdout);
  assert.equal(diagnosisOutput.fixPlan.confidence, "medium");
  assert.equal(diagnosisOutput.fixPlan.target.file, "src/user.ts");
  assert.deepEqual(diagnosisOutput.fixPlan.target.range, { start: 1, end: 1 });
  assert.match(diagnosisOutput.fixPlan.target.intent, /TypeScript TS2322/);
  assert.match(diagnosisOutput.fixPlan.target.intent, /string literal with a number literal/);
  assert.ok(diagnosisOutput.changeTemplate.path);

  const suggestion = run(dir, ["change", "suggest", "--apply", "--compact"]);
  assert.equal(suggestion.status, 0, suggestion.stderr || suggestion.stdout);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.strategy, "typescript-literal-mismatch");
  assert.deepEqual(suggestionOutput.applied.changedFiles, ["src/user.ts"]);
  assert.match(fs.readFileSync(path.join(dir, "src", "user.ts"), "utf8"), /const count: number = 0;/);

  const verify = run(dir, ["verify", "test"]);
  assert.equal(verify.status, 0);
});

test("change suggest repairs a unique TypeScript argument primitive literal mismatch", () => {
  const dir = makeTypeScriptDiagnosticProject("ts-argument-literal-mismatch-demo", [
    "type Status = \"ready\";",
    "function expectStatus(status: Status) {",
    "  return status;",
    "}",
    "expectStatus(\"pending\");",
    ""
  ], [
    "const fs = require('node:fs');",
    "const source = fs.readFileSync('src/user.ts', 'utf8');",
    "if (!/expectStatus\\(\"ready\"\\)/.test(source)) {",
    "  console.error(\"src/user.ts(5,14): error TS2345: Argument of type '\\\"pending\\\"' is not assignable to parameter of type '\\\"ready\\\"'.\");",
    "  process.exit(1);",
    "}",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);
  const diagnosisOutput = JSON.parse(diagnosis.stdout);
  assert.equal(diagnosisOutput.fixPlan.confidence, "medium");
  assert.equal(diagnosisOutput.fixPlan.target.file, "src/user.ts");
  assert.deepEqual(diagnosisOutput.fixPlan.target.range, { start: 5, end: 5 });
  assert.match(diagnosisOutput.fixPlan.target.intent, /TypeScript TS2345/);
  assert.match(diagnosisOutput.fixPlan.target.intent, /primitive literal `"pending"` with `"ready"`/);
  assert.ok(diagnosisOutput.changeTemplate.path);

  const suggestion = run(dir, ["change", "suggest", "--apply", "--compact"]);
  assert.equal(suggestion.status, 0, suggestion.stderr || suggestion.stdout);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.strategy, "typescript-primitive-literal-mismatch");
  assert.deepEqual(suggestionOutput.applied.changedFiles, ["src/user.ts"]);
  assert.match(fs.readFileSync(path.join(dir, "src", "user.ts"), "utf8"), /expectStatus\("ready"\);/);

  const verify = run(dir, ["verify", "test"]);
  assert.equal(verify.status, 0);
});

test("change suggest repairs a simple TypeScript property suggestion diagnostic", () => {
  const dir = makeTypeScriptDiagnosticProject("ts-property-suggestion-demo", [
    "interface User {",
    "  firstName: string;",
    "}",
    "const user: User = { firstName: 'Ada' };",
    "console.log(user.fristName);",
    ""
  ], [
    "const fs = require('node:fs');",
    "const source = fs.readFileSync('src/user.ts', 'utf8');",
    "if (!/user\\.firstName/.test(source)) {",
    "  console.error(\"src/user.ts(5,18): error TS2551: Property 'fristName' does not exist on type 'User'. Did you mean 'firstName'?\");",
    "  process.exit(1);",
    "}",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);
  const diagnosisOutput = JSON.parse(diagnosis.stdout);
  assert.equal(diagnosisOutput.fixPlan.confidence, "medium");
  assert.equal(diagnosisOutput.fixPlan.target.file, "src/user.ts");
  assert.deepEqual(diagnosisOutput.fixPlan.target.range, { start: 5, end: 5 });
  assert.match(diagnosisOutput.fixPlan.target.intent, /TypeScript TS2551/);
  assert.match(diagnosisOutput.fixPlan.target.intent, /`fristName` with suggested property `firstName`/);
  assert.ok(diagnosisOutput.changeTemplate.path);

  const suggestion = run(dir, ["change", "suggest", "--apply", "--compact"]);
  assert.equal(suggestion.status, 0, suggestion.stderr || suggestion.stdout);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.strategy, "typescript-property-suggestion");
  assert.deepEqual(suggestionOutput.applied.changedFiles, ["src/user.ts"]);
  assert.match(fs.readFileSync(path.join(dir, "src", "user.ts"), "utf8"), /user\.firstName/);

  const verify = run(dir, ["verify", "test"]);
  assert.equal(verify.status, 0);
});

test("change suggest refuses ambiguous TypeScript literal mismatch diagnostics", () => {
  const dir = makeTypeScriptDiagnosticProject("ts-ambiguous-literal-mismatch-demo", [
    "const count: number = \"1\"; const label = \"count\";",
    "console.log(count, label);",
    ""
  ], [
    "console.error(\"src/user.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\");",
    "process.exit(1);",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);
  const diagnosisOutput = JSON.parse(diagnosis.stdout);
  assert.equal(diagnosisOutput.fixPlan.confidence, "medium");
  assert.equal(diagnosisOutput.fixPlan.target.file, "src/user.ts");
  assert.deepEqual(diagnosisOutput.fixPlan.target.range, { start: 1, end: 1 });
  assert.match(diagnosisOutput.fixPlan.target.intent, /string literal with a number literal/);

  const suggestion = run(dir, ["change", "suggest", "--dry-run", "--compact"]);
  assert.equal(suggestion.status, 1);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.error.code, "SUGGESTION_UNAVAILABLE");
  assert.equal(suggestionOutput.error.details.unsupportedReason, "unsupported-pattern");
});

test("change suggest refuses ambiguous TypeScript primitive literal mismatch replacements", () => {
  const dir = makeTypeScriptDiagnosticProject("ts-ambiguous-argument-literal-mismatch-demo", [
    "type Status = \"ready\";",
    "function expectStatus(status: Status, label: string) {",
    "  return `${status}:${label}`;",
    "}",
    "expectStatus(\"pending\", \"pending\");",
    ""
  ], [
    "console.error(\"src/user.ts(5,14): error TS2345: Argument of type '\\\"pending\\\"' is not assignable to parameter of type '\\\"ready\\\"'.\");",
    "process.exit(1);",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);
  const diagnosisOutput = JSON.parse(diagnosis.stdout);
  assert.equal(diagnosisOutput.fixPlan.confidence, "medium");
  assert.equal(diagnosisOutput.fixPlan.target.file, "src/user.ts");
  assert.deepEqual(diagnosisOutput.fixPlan.target.range, { start: 5, end: 5 });
  assert.match(diagnosisOutput.fixPlan.target.intent, /TypeScript TS2345/);
  assert.match(diagnosisOutput.fixPlan.target.intent, /primitive literal `"pending"` with `"ready"`/);

  const suggestion = run(dir, ["change", "suggest", "--dry-run", "--compact"]);
  assert.equal(suggestion.status, 1);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.error.code, "SUGGESTION_UNAVAILABLE");
  assert.equal(suggestionOutput.error.details.unsupportedReason, "unsupported-pattern");
});

test("change suggest refuses ambiguous TypeScript property suggestion replacements", () => {
  const dir = makeTypeScriptDiagnosticProject("ts-ambiguous-property-suggestion-demo", [
    "interface User {",
    "  firstName: string;",
    "}",
    "const user: User = { firstName: 'Ada' };",
    "console.log(user.fristName, user.fristName);",
    ""
  ], [
    "console.error(\"src/user.ts(5,18): error TS2551: Property 'fristName' does not exist on type 'User'. Did you mean 'firstName'?\");",
    "process.exit(1);",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);
  const diagnosisOutput = JSON.parse(diagnosis.stdout);
  assert.equal(diagnosisOutput.fixPlan.confidence, "medium");
  assert.equal(diagnosisOutput.fixPlan.target.file, "src/user.ts");
  assert.deepEqual(diagnosisOutput.fixPlan.target.range, { start: 5, end: 5 });
  assert.match(diagnosisOutput.fixPlan.target.intent, /TypeScript TS2551/);

  const suggestion = run(dir, ["change", "suggest", "--dry-run", "--compact"]);
  assert.equal(suggestion.status, 1);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.error.code, "SUGGESTION_UNAVAILABLE");
  assert.equal(suggestionOutput.error.details.unsupportedReason, "unsupported-pattern");
});

test("diagnose refuses ambiguous TypeScript diagnostics", () => {
  const dir = makeTypeScriptDiagnosticProject("ts-ambiguous-demo", [
    "interface User {",
    "  id: string;",
    "  active: boolean;",
    "}",
    "export function createUser(): User {",
    "  return {};",
    "}",
    ""
  ], [
    "console.error(\"src/user.ts(6,3): error TS2739: Type '{}' is missing the following properties from type 'User': id, active\");",
    "console.error(\"src/user.ts(6,3): error TS2741: Property 'id' is missing in type '{}' but required in type 'User'.\");",
    "process.exit(1);",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);
  const diagnosisOutput = JSON.parse(diagnosis.stdout);
  assert.equal(diagnosisOutput.fixPlan.confidence, "low");
  assert.equal(diagnosisOutput.fixPlan.target, null);
  assert.equal(diagnosisOutput.changeTemplate, null);

  const suggestion = run(dir, ["change", "suggest", "--dry-run", "--compact"]);
  assert.equal(suggestion.status, 1);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.error.details.unsupportedReason, "no-change-template");
});

test("change suggest refuses ambiguous nearby import path matches", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-suggest-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "ambiguous-import-path-demo",
    type: "module",
    scripts: {
      test: "node test/user.test.js"
    }
  }, null, 2));
  fs.writeFileSync(path.join(dir, "src", "user.js"), "export const user = true;\n");
  fs.writeFileSync(path.join(dir, "src", "sure.js"), "export const user = false;\n");
  fs.writeFileSync(path.join(dir, "test", "user.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { user } from '../src/usre.js';",
    "assert.equal(user, true);",
    ""
  ].join("\n"));

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);
  const diagnosisOutput = JSON.parse(diagnosis.stdout);
  assert.equal(diagnosisOutput.fixPlan.confidence, "low");
  assert.equal(diagnosisOutput.fixPlan.target.file, "test/user.test.js");
  assert.deepEqual(diagnosisOutput.fixPlan.target.range, { start: 2, end: 2 });

  const suggestion = run(dir, ["change", "suggest", "--dry-run", "--compact"]);
  assert.equal(suggestion.status, 1);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.ok, false);
  assert.equal(suggestionOutput.error.details.unsupportedReason, "unsupported-pattern");
});

test("change suggest refuses ambiguous directory index import matches", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-suggest-"));
  fs.mkdirSync(path.join(dir, "src", "user"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "ambiguous-index-import-demo",
    type: "module",
    scripts: {
      test: "node test/user.test.js"
    }
  }, null, 2));
  fs.writeFileSync(path.join(dir, "src", "user", "index.js"), "export const user = { name: 'Ada' };\n");
  fs.writeFileSync(path.join(dir, "src", "user", "index.mjs"), "export const user = { name: 'Grace' };\n");
  fs.writeFileSync(path.join(dir, "test", "user.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { user } from '../src/user';",
    "assert.equal(user.name, 'Ada');",
    ""
  ].join("\n"));

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);
  const diagnosisOutput = JSON.parse(diagnosis.stdout);
  assert.equal(diagnosisOutput.fixPlan.confidence, "low");
  assert.equal(diagnosisOutput.fixPlan.target.file, "test/user.test.js");
  assert.deepEqual(diagnosisOutput.fixPlan.target.range, { start: 2, end: 2 });

  const suggestion = run(dir, ["change", "suggest", "--dry-run", "--compact"]);
  assert.equal(suggestion.status, 1);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.ok, false);
  assert.equal(suggestionOutput.error.details.unsupportedReason, "unsupported-pattern");
});

test("change suggest refuses ambiguous CommonJS import path matches", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-suggest-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "ambiguous-commonjs-import-demo",
    scripts: {
      test: "node test/user.test.cjs"
    }
  }, null, 2));
  fs.writeFileSync(path.join(dir, "src", "user.js"), "module.exports = { user: { name: 'Ada' } };\n");
  fs.writeFileSync(path.join(dir, "src", "sure.js"), "module.exports = { user: { name: 'Grace' } };\n");
  fs.writeFileSync(path.join(dir, "test", "user.test.cjs"), [
    "const assert = require('node:assert/strict');",
    "const { user } = require('../src/usre');",
    "assert.equal(user.name, 'Ada');",
    ""
  ].join("\n"));

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);
  const diagnosisOutput = JSON.parse(diagnosis.stdout);
  assert.equal(diagnosisOutput.fixPlan.confidence, "low");
  assert.equal(diagnosisOutput.fixPlan.target.file, "test/user.test.cjs");
  assert.deepEqual(diagnosisOutput.fixPlan.target.range, { start: 2, end: 2 });

  const suggestion = run(dir, ["change", "suggest", "--dry-run", "--compact"]);
  assert.equal(suggestion.status, 1);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.ok, false);
  assert.equal(suggestionOutput.error.details.unsupportedReason, "unsupported-pattern");
});

test("change suggest reports unsupportedReason when the diagnosed pattern is unsupported", () => {
  const dir = makeProject("unsupported-demo", [
    "export function total() {",
    "  return 2 + 2;",
    "}",
    ""
  ], [
    "import assert from 'node:assert/strict';",
    "import { total } from '../src/status.js';",
    "assert.equal(total(), 5);",
    ""
  ]);

  const diagnosis = run(dir, ["diagnose", "test", "--compact"]);
  assert.equal(diagnosis.status, 0);
  const diagnosisOutput = JSON.parse(diagnosis.stdout);
  assert.equal(diagnosisOutput.changeTemplate.replacementRequired, true);

  const suggestion = run(dir, ["change", "suggest", "--dry-run", "--compact"]);
  assert.equal(suggestion.status, 1);
  const suggestionOutput = JSON.parse(suggestion.stdout);
  assert.equal(suggestionOutput.ok, false);
  assert.equal(suggestionOutput.error.code, "SUGGESTION_UNAVAILABLE");
  assert.equal(suggestionOutput.error.details.unsupportedReason, "unsupported-pattern");
  assert.equal(suggestionOutput.error.details.template, diagnosisOutput.changeTemplate.path);
});

function makeProject(name, sourceLines, testLines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-suggest-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name,
    type: "module",
    scripts: {
      test: "node test/status.test.js"
    }
  }, null, 2));
  fs.writeFileSync(path.join(dir, "src", "status.js"), sourceLines.join("\n"));
  fs.writeFileSync(path.join(dir, "test", "status.test.js"), testLines.join("\n"));
  return dir;
}

function makeTypeScriptDiagnosticProject(name, sourceLines, checkerLines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-suggest-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name,
    scripts: {
      test: "node test/typecheck.cjs"
    }
  }, null, 2));
  fs.writeFileSync(path.join(dir, "src", "user.ts"), sourceLines.join("\n"));
  fs.writeFileSync(path.join(dir, "test", "typecheck.cjs"), checkerLines.join("\n"));
  return dir;
}

function run(cwd, args) {
  return spawnSync("node", [cli, ...args], {
    cwd,
    encoding: "utf8"
  });
}
