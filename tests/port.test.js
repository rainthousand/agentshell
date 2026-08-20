import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { parseLsofOutput, parseSsOutput, portList } from "../src/commands/port.js";

const LSOF_OUTPUT = [
  "p101",
  "cnode",
  "f20u",
  "PTCP",
  "n*:3000",
  "TST=LISTEN",
  "f21u",
  "PTCP",
  "n127.0.0.1:50000->127.0.0.1:443",
  "TST=ESTABLISHED",
  "p202",
  "cpython3",
  "f9u",
  "PUDP",
  "n127.0.0.1:5353",
  ""
].join("\n");

test("lsof parser returns TCP listeners and UDP sockets but excludes established connections", () => {
  const entries = parseLsofOutput(LSOF_OUTPUT);
  assert.deepEqual(entries, [
    { pid: 101, command: "node", protocol: "tcp", address: "*", port: 3000, state: "LISTEN", listen: true },
    { pid: 202, command: "python3", protocol: "udp", address: "127.0.0.1", port: 5353, state: "UNCONN", listen: true }
  ]);
});

test("ss parser reads Linux TCP and UDP listeners", () => {
  const entries = parseSsOutput([
    "tcp LISTEN 0 511 127.0.0.1:4320 0.0.0.0:* users:((\"node\",pid=321,fd=20))",
    "udp UNCONN 0 0 0.0.0.0:5353 0.0.0.0:* users:((\"python3\",pid=654,fd=5))",
    ""
  ].join("\n"));
  assert.deepEqual(entries.map((entry) => [entry.pid, entry.command, entry.protocol, entry.port, entry.listen]), [
    [321, "node", "tcp", 4320, true],
    [654, "python3", "udp", 5353, true]
  ]);
});

test("port list filters by port and uses injectable platform tooling", async () => {
  const calls = [];
  const result = await portList(process.cwd(), {
    platform: "darwin",
    port: 3000,
    runCommand(command, args) {
      calls.push([command, args]);
      return { status: 0, stdout: LSOF_OUTPUT, stderr: "" };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.port-list.v1");
  assert.equal(result.summary.filterPort, 3000);
  assert.equal(result.summary.matchedSockets, 1);
  assert.equal(result.ports[0].pid, 101);
  assert.equal(result.ports[0].listen, true);
  assert.equal(calls[0][0], "lsof");
  assert.ok(result.suggestedNextActions[0].command.includes("kill suggest --port 3000"));
});

test("port list validates filters and reports missing tools", async () => {
  const invalid = await portList(process.cwd(), { port: 0 });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "INVALID_PORT");

  const missing = await portList(process.cwd(), {
    platform: "linux",
    runCommand() {
      return { error: { code: "ENOENT" }, status: null, stdout: "", stderr: "" };
    }
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "PORT_TOOL_NOT_AVAILABLE");
});

test("port schema exposes listener and process metadata", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/port.schema.json", "utf8"));
  assert.equal(schema.title, "AgentShell Port List Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.port-list.v1");
  assert.ok(schema.$defs.port.required.includes("listen"));
  assert.ok(schema.$defs.port.required.includes("pid"));
});
