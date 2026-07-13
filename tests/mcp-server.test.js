import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cliArgsForTool, handleRequest } from "../src/mcp/server.js";

test("MCP server handles initialize and tools/list JSON-RPC requests", () => {
  const result = spawnSync("node", ["bin/agentshell-mcp"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    ].join("\n")
  });

  assert.equal(result.status, 0);
  const responses = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(responses.length, 2);
  assert.equal(responses[0].result.serverInfo.name, "agentshell-mcp");
  assert.deepEqual(responses[0].result.capabilities.tools, {});
  assert.ok(responses[1].result.tools.some((tool) => tool.name === "agentshell_manual"));
  assert.ok(responses[1].result.tools.some((tool) => tool.name === "agentshell_find"));
});

test("MCP tools/call maps agentshell_manual to the CLI payload", () => {
  const result = spawnSync("node", ["bin/agentshell-mcp"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: `${JSON.stringify({
      jsonrpc: "2.0",
      id: "manual",
      method: "tools/call",
      params: {
        name: "agentshell_manual",
        arguments: {}
      }
    })}\n`
  });

  assert.equal(result.status, 0);
  const response = JSON.parse(result.stdout.trim());
  assert.equal(response.id, "manual");
  assert.equal(response.result.structuredContent.ok, true);
  assert.equal(response.result.structuredContent.protocolVersion, "agentshell.manual.v1");
  assert.equal(response.result.structuredContent.name, "AgentShell");
  assert.match(response.result.content[0].text, /agentshell read <file>/);
});

test("MCP request handler returns JSON-RPC errors for invalid tool arguments", async () => {
  const response = await handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "agentshell_read",
      arguments: {
        file: "package.json",
        lines: "1:2",
        around: "name"
      }
    }
  });

  assert.equal(response.error.code, -32603);
  assert.match(response.error.message, /exactly one/);
});

test("MCP tool argument mapper builds AgentShell command payloads", () => {
  assert.deepEqual(cliArgsForTool("agentshell_find", { query: "protocolVersion" }), [
    "find",
    "protocolVersion"
  ]);
  assert.deepEqual(cliArgsForTool("agentshell_fix_test", { policy: "safe" }), [
    "fix",
    "test",
    "--safe",
    "--compact"
  ]);
  assert.deepEqual(cliArgsForTool("agentshell_run_status", {}), [
    "run",
    "status",
    "--compact"
  ]);
});
