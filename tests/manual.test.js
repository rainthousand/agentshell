import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function runManual(...args) {
  return spawnSync(process.execPath, ["src/cli.js", "manual", ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

test("default manual stays within its 500 estimated-token routing budget", () => {
  const result = runManual();

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.protocolVersion, "agentshell.manual.v1");
  assert.equal(output.compact, true);
  assert.equal(output.firstPass.command, "agentshell start --compact");
  assert.ok(output.primaryCommands.some(({ command }) => command === "agentshell fix test --fast --compact"));
  assert.ok(output.primaryCommands.some(({ command }) => command.includes("verify <test|build|lint|format|modules")));
  assert.ok(output.topics.some(({ command }) => command === "agentshell manual --topic repair"));
  assert.equal(output.full, "agentshell manual --full");
  assert.ok(Math.ceil(result.stdout.length / 4) <= 500, `manual used ${Math.ceil(result.stdout.length / 4)} estimated tokens`);
});

test("manual topics and full mode retain detailed on-demand guidance", () => {
  const repair = runManual("--topic", "repair");
  const plugin = runManual("--topic", "plugin");
  const full = runManual("--full");

  assert.equal(repair.status, 0, repair.stderr);
  assert.equal(plugin.status, 0, plugin.stderr);
  assert.equal(full.status, 0, full.stderr);
  assert.ok(JSON.parse(repair.stdout).workflow.includes("agentshell fix test --fast --compact"));
  assert.ok(JSON.parse(plugin.stdout).workflow.includes("agentshell plugin validate --compact"));
  assert.ok(JSON.parse(full.stdout).commandMap.length > 20);
});
