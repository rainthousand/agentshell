import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { parsePsOutput, ps } from "../src/commands/ps.js";

const PS_OUTPUT = [
  "    1     0 root     Ss   12-01:00:00 /sbin/launchd /sbin/launchd",
  "  101     1 didi     S       00:10:12 /usr/local/bin/node node server.js --token secret-value",
  "  202   101 didi     S+         02:01 /usr/bin/python3 python3 -m pytest tests",
  "  303     1 didi     S       01:20:00 /Applications/Safari Safari",
  ""
].join("\n");

test("ps returns a bounded list of likely development processes without raw arguments", async () => {
  const calls = [];
  const result = await ps(process.cwd(), {
    compact: true,
    limit: 1,
    runCommand(command, args) {
      calls.push([command, args]);
      return { status: 0, stdout: PS_OUTPUT, stderr: "" };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.ps.v1");
  assert.equal(result.summary.scannedProcesses, 4);
  assert.equal(result.summary.matchedProcesses, 2);
  assert.equal(result.summary.returnedProcesses, 1);
  assert.equal(result.summary.truncated, true);
  assert.equal(result.processes[0].command, "node");
  assert.equal(result.processes[0].category, "runtime");
  assert.equal("args" in result.processes[0], false);
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
  assert.deepEqual(calls[0][0], "ps");
});

test("ps parser classifies agent, test, and unrelated processes", () => {
  const parsed = parsePsOutput([
    "  10 1 didi S 00:01 /opt/agentshell agentshell dashboard",
    "  11 1 didi S 00:02 /usr/bin/java java -jar app.jar",
    "  12 1 didi S 00:03 /bin/zsh zsh",
    "  13 1 didi S 00:04 /Applications/Go /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ""
  ].join("\n"));

  assert.deepEqual(parsed.map((entry) => entry.category), ["agent", "runtime", null, null]);
  assert.deepEqual(parsed.slice(0, 3).map((entry) => entry.command), ["agentshell", "java", "zsh"]);
});

test("ps reports unavailable process tooling", async () => {
  const result = await ps(process.cwd(), {
    runCommand() {
      return { error: { code: "ENOENT" }, status: null, stdout: "", stderr: "" };
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PS_NOT_AVAILABLE");
});

test("ps schema exposes the compact response contract", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/ps.schema.json", "utf8"));
  assert.equal(schema.title, "AgentShell Process List Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.ps.v1");
  assert.ok(schema.oneOf[0].required.includes("processes"));
  assert.ok(schema.$defs.process.required.includes("category"));
});
