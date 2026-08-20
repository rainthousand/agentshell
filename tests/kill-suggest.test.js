import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { killSuggest } from "../src/commands/kill-suggest.js";

test("kill suggest emits a SIGTERM command without executing a subprocess for PID targets", async () => {
  let called = false;
  const result = await killSuggest(process.cwd(), {
    pid: 4242,
    runCommand() {
      called = true;
      throw new Error("must not execute");
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.kill-suggest.v1");
  assert.deepEqual(result.target, { type: "pid", value: 4242 });
  assert.equal(result.summary.executed, false);
  assert.equal(result.summary.highestRisk, "medium");
  assert.equal(result.suggestions[0].command, "kill -TERM 4242");
  assert.equal(called, false);
});

test("kill suggest resolves port owners but never invokes kill", async () => {
  const calls = [];
  const result = await killSuggest(process.cwd(), {
    port: 4320,
    platform: "darwin",
    runCommand(command, args) {
      calls.push([command, args]);
      return {
        status: 0,
        stdout: "p777\ncnode\nf20u\nPTCP\nn*:4320\nTST=LISTEN\n",
        stderr: ""
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.summary.matchedProcesses, 1);
  assert.equal(result.summary.executed, false);
  assert.equal(result.suggestions[0].command, "kill -TERM 777");
  assert.equal(result.suggestions[0].risk, "low");
  assert.deepEqual(calls.map(([command]) => command), ["lsof"]);
});

test("kill suggest marks critical targets and validates PID or port selection", async () => {
  const critical = await killSuggest(process.cwd(), { pid: 1 });
  assert.equal(critical.ok, true);
  assert.equal(critical.summary.highestRisk, "critical");
  assert.match(critical.suggestions[0].reason, /must not be terminated/);

  for (const options of [
    {},
    { pid: 10, port: 3000 },
    { pid: -1 },
    { port: 65536 }
  ]) {
    const invalid = await killSuggest(process.cwd(), options);
    assert.equal(invalid.ok, false);
  }
});

test("kill suggest returns no command when a port has no owner", async () => {
  const result = await killSuggest(process.cwd(), {
    port: 4999,
    platform: "linux",
    runCommand() {
      return { status: 0, stdout: "", stderr: "" };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.summary.suggestionCount, 0);
  assert.equal(result.summary.highestRisk, "none");
  assert.deepEqual(result.suggestions, []);
});

test("kill suggest schema guarantees suggestions are non-executing SIGTERM previews", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/kill-suggest.schema.json", "utf8"));
  assert.equal(schema.title, "AgentShell Kill Suggest Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.kill-suggest.v1");
  assert.equal(schema.$defs.summary.properties.executed.const, false);
  assert.equal(schema.$defs.suggestion.properties.signal.const, "SIGTERM");
});
