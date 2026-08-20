import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { errorsFromCommand } from "../src/commands/errors-from-command.js";
import { readLog } from "../src/core/store.js";

test("errors from-command executes a failing command and returns compact error summary", async () => {
  const root = tempProject();
  const result = await errorsFromCommand(root, ["--", process.execPath, "-e", "console.error('TypeError: nope'); process.exit(7)"], { compact: true });

  assert.equal(result.ok, false);
  assert.equal(result.protocolVersion, "agentshell.errors-from-command.v1");
  assert.equal(result.exitCode, 7);
  assert.equal(result.summary.errorCount, 1);
  assert.match(result.summary.mainError, /nope/);
  assert.ok(result.logRef.startsWith("log_"));
  assert.match(readLog(root, result.logRef).stderr, /TypeError: nope/);
});

test("errors from-command reports success without raw stdout in response", async () => {
  const root = tempProject();
  const result = await errorsFromCommand(root, ["--", process.execPath, "-e", "console.log('hello')"], { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.errorCount, 0);
  assert.equal(Object.hasOwn(result, "stdout"), false);
});

test("errors from-command schema is parseable", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "errors-from-command.schema.json"), "utf8"));
  assert.equal(schema.properties.protocolVersion.const, "agentshell.errors-from-command.v1");
});

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-errors-from-command-"));
}
