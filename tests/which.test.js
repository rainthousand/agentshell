import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { whichCommand, whichExecutable } from "../src/commands/which.js";

test("which resolves a common tool and returns a compact bounded version", async () => {
  const fixture = executableFixture("node", [
    "#!/bin/sh",
    "printf 'v99.1.0\\nextra detail that should remain bounded\\nignored third line\\n'"
  ]);
  const output = await whichCommand(fixture.root, "node", {
    compact: true,
    pathEnv: fixture.bin,
    env: { ...process.env, PATH: fixture.bin }
  });

  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.which.v1");
  assert.equal(output.compact, true);
  assert.equal(output.executable.path, path.join(fixture.bin, "node"));
  assert.equal(output.summary.found, true);
  assert.equal(output.summary.versionAvailable, true);
  assert.equal(output.version.attempted, true);
  assert.equal(output.version.status, "ok");
  assert.equal(output.version.value, "v99.1.0 | extra detail that should remain bounded");
  assert.ok(output.version.value.length <= 240);
});

test("which skips version execution for tools outside the safe allowlist", async () => {
  const fixture = executableFixture("custom-tool", ["#!/bin/sh", "printf 'should-not-run\\n'"]);
  const output = await whichExecutable(fixture.root, "custom-tool", {
    pathEnv: fixture.bin,
    env: { ...process.env, PATH: fixture.bin }
  });

  assert.equal(output.ok, true);
  assert.equal(output.version.attempted, false);
  assert.equal(output.version.status, "unsupported");
  assert.equal(output.version.value, null);
  assert.match(output.suggestedNextActions[0].reason, /not enabled/);
});

test("which reports missing and invalid executable names as structured failures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-which-missing-"));
  const missingArgument = await whichCommand(root, "", { pathEnv: "" });
  const missingCommand = await whichCommand(root, "no-such-tool", { pathEnv: "" });

  assert.equal(missingArgument.ok, false);
  assert.equal(missingArgument.error.code, "INVALID_ARGUMENT");
  assert.equal(missingCommand.ok, false);
  assert.equal(missingCommand.error.code, "COMMAND_NOT_FOUND");
  assert.deepEqual(missingCommand.error.details, { command: "no-such-tool" });
  assert.ok(missingCommand.error.suggestedNextActions.length > 0);
});

test("which times out a slow common version command", async () => {
  const fixture = executableFixture("node", ["#!/bin/sh", "while :; do :; done"]);
  const output = await whichCommand(fixture.root, "node", {
    pathEnv: fixture.bin,
    env: { ...process.env, PATH: fixture.bin },
    versionTimeoutMs: 50
  });

  assert.equal(output.ok, true);
  assert.equal(output.version.attempted, true);
  assert.equal(output.version.status, "timeout");
  assert.equal(output.version.timedOut, true);
});

test("which schema exposes executable and bounded version contracts", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/which.schema.json", "utf8"));

  assert.equal(schema.title, "AgentShell Which Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.which.v1");
  assert.equal(schema.oneOf[0].properties.version.properties.value.maxLength, 240);
  assert.deepEqual(schema.oneOf[0].properties.version.properties.status.enum, [
    "ok",
    "error",
    "timeout",
    "unsupported"
  ]);
});

function executableFixture(name, lines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-which-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const executable = path.join(bin, name);
  fs.writeFileSync(executable, `${lines.join("\n")}\n`, { mode: 0o755 });
  fs.chmodSync(executable, 0o755);
  return { root, bin, executable };
}
