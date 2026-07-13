import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cli = path.resolve("src/cli.js");

test("fix test previews and applies a supported failing test fix", () => {
  const previewDir = makeDemo();
  const preview = run(previewDir, ["fix", "test", "--dry-run", "--compact"]);
  assert.equal(preview.status, 0);
  const previewOutput = JSON.parse(preview.stdout);
  assert.equal(previewOutput.ok, true);
  assert.equal(previewOutput.protocolVersion, "agentshell.fix.v1");
  assert.equal(previewOutput.compact, true);
  assert.equal(previewOutput.dryRun, true);
  assert.equal(Object.hasOwn(previewOutput, "policy"), false);
  assert.equal(previewOutput.status, "previewed");
  assert.equal(previewOutput.preview.strategy, "missing-object-property");
  assert.equal(previewOutput.verification, null);
  assert.equal(Object.hasOwn(previewOutput, "suggestion"), false);
  assert.match(fs.readFileSync(path.join(previewDir, "src", "user.js"), "utf8"), /name: input\.name/);

  const applyDir = makeDemo();
  const fixed = run(applyDir, ["fix", "test", "--compact"]);
  assert.equal(fixed.status, 0);
  const fixedOutput = JSON.parse(fixed.stdout);
  assert.equal(fixedOutput.ok, true);
  assert.equal(fixedOutput.protocolVersion, "agentshell.fix.v1");
  assert.equal(fixedOutput.compact, true);
  assert.equal(fixedOutput.dryRun, false);
  assert.equal(Object.hasOwn(fixedOutput, "policy"), false);
  assert.equal(fixedOutput.status, "passed");
  assert.equal(fixedOutput.verification.ok, true);
  assert.equal(fixedOutput.verification.cacheHit, false);
  assert.match(fixedOutput.verification.cacheKey, /^sha256:/);
  assert.equal(fixedOutput.target.file, "src/user.js");
  assert.deepEqual(fixedOutput.changedFiles, ["src/user.js"]);
  assert.match(fixedOutput.rollbackCommand, /^agentshell undo op_/);
  assert.match(fixedOutput.suggestedNextActions[0].command, /^agentshell undo op_/);
  assert.match(fs.readFileSync(path.join(applyDir, "src", "user.js"), "utf8"), /id: `user_\$\{input\.email\}`/);

  const status = run(applyDir, ["run", "status", "--compact"]);
  assert.equal(status.status, 0);
  const statusOutput = JSON.parse(status.stdout);
  assert.equal(statusOutput.summary.status, "passed");
  assert.equal(statusOutput.summary.commandCount, 1);
});

test("fix test policy modes select preview or apply behavior", () => {
  const safeDir = makeDemo();
  const safe = run(safeDir, ["fix", "test", "--safe", "--compact"]);
  assert.equal(safe.status, 0);
  const safeOutput = JSON.parse(safe.stdout);
  assert.equal(safeOutput.ok, true);
  assert.equal(safeOutput.policy, "safe");
  assert.equal(safeOutput.dryRun, true);
  assert.equal(safeOutput.status, "previewed");
  assert.equal(safeOutput.preview.strategy, "missing-object-property");
  assert.equal(safeOutput.verification, null);
  assert.match(safeOutput.suggestedNextActions[0].command, /--fast --compact/);
  assert.match(fs.readFileSync(path.join(safeDir, "src", "user.js"), "utf8"), /name: input\.name/);

  const fastDir = makeDemo();
  const fast = run(fastDir, ["fix", "test", "--fast", "--compact"]);
  assert.equal(fast.status, 0);
  const fastOutput = JSON.parse(fast.stdout);
  assert.equal(fastOutput.ok, true);
  assert.equal(fastOutput.policy, "fast");
  assert.equal(fastOutput.dryRun, false);
  assert.equal(fastOutput.status, "passed");
  assert.equal(fastOutput.verification.ok, true);
  assert.match(fs.readFileSync(path.join(fastDir, "src", "user.js"), "utf8"), /id: `user_\$\{input\.email\}`/);
});

test("fix test --profile reports one-command repair phase timing", () => {
  const dir = makeDemo();
  const result = run(dir, ["fix", "test", "--fast", "--compact", "--profile"]);
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.profile.totalMs >= 0, true);
  assert.equal(typeof output.profile.subprocessMs, "number");
  const phaseNames = output.profile.phases.map((phase) => phase.name);
  assert.ok(phaseNames.includes("diagnose-test"));
  assert.ok(phaseNames.includes("suggest-apply"));
  assert.ok(phaseNames.includes("verify-final"));
});

test("fix test rejects conflicting policy modes", () => {
  const dir = makeDemo();
  const result = run(dir, ["fix", "test", "--fast", "--safe", "--compact"]);
  assert.equal(result.status, 2);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.error.code, "INVALID_ARGUMENT");
  assert.match(output.error.message, /Choose one fix policy/);
});

test("fix test reports unsupportedReason when no safe automatic fix is available", () => {
  const dir = makeUnsupportedDemo();

  const fixed = run(dir, ["fix", "test", "--compact"]);
  assert.equal(fixed.status, 1);
  const fixedOutput = JSON.parse(fixed.stdout);
  assert.equal(fixedOutput.ok, false);
  assert.equal(fixedOutput.error.code, "FIX_SUGGESTION_UNAVAILABLE");
  assert.equal(fixedOutput.error.details.unsupportedReason, "unsupported-pattern");
  assert.equal(fixedOutput.error.details.suggestionError.code, "SUGGESTION_UNAVAILABLE");
  assert.equal(fixedOutput.error.details.suggestionError.details.unsupportedReason, "unsupported-pattern");
  assert.match(fixedOutput.error.suggestedNextActions[0].command, /change fill .* <fill\.json> --apply/);
});

function makeDemo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-fix-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "fix-demo",
    type: "module",
    scripts: {
      test: "node test/user.test.js"
    }
  }, null, 2));
  fs.writeFileSync(path.join(dir, "src", "user.js"), [
    "export function createUser(input) {",
    "  return {",
    "    name: input.name,",
    "    email: input.email",
    "  };",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "test", "user.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { createUser } from '../src/user.js';",
    "const user = createUser({ name: 'Ada', email: 'ada@example.com' });",
    "assert.ok(user.id, 'Expected user.id to be present');",
    ""
  ].join("\n"));
  return dir;
}

function makeUnsupportedDemo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-fix-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "fix-unsupported-demo",
    type: "module",
    scripts: {
      test: "node test/math.test.js"
    }
  }, null, 2));
  fs.writeFileSync(path.join(dir, "src", "math.js"), [
    "export function total() {",
    "  return 2 + 2;",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "test", "math.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { total } from '../src/math.js';",
    "assert.equal(total(), 5);",
    ""
  ].join("\n"));
  return dir;
}

function run(cwd, args) {
  return spawnSync("node", [cli, ...args], {
    cwd,
    encoding: "utf8"
  });
}
