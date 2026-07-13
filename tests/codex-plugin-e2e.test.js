import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("codex e2e report counts doctor setup cost without adding it to core fix flow", () => {
  const result = spawnSync("node", ["scripts/codex-plugin-e2e.js"], {
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);

  assert.equal(output.ok, true);

  for (const flowName of ["legacy", "diagnose", "fix"]) {
    const flow = output[flowName];
    const doctorCommand = flow.commands.find((command) => command.command === "agentshell doctor");

    assert.equal(flow.commands[0].command, "agentshell doctor");
    assert.equal(doctorCommand.status, 0);
    assert.ok(doctorCommand.chars > 0);
    assert.equal(doctorCommand.estimatedTokens, Math.ceil(doctorCommand.chars / 4));
    assert.equal(typeof doctorCommand.durationMs, "number");
    assert.ok(doctorCommand.durationMs >= 0);

    assert.equal(flow.doctor.ok, true);
    assert.ok(["ready", "warning"].includes(flow.doctor.status));
    assert.equal(flow.coreFixFlow.commands.includes("agentshell doctor"), false);
    assert.equal(flow.totals.durationMs, flow.commands.reduce((total, command) => total + command.durationMs, 0));

    for (const command of flow.commands) {
      assert.equal(command.estimatedTokens, Math.ceil(command.chars / 4));
      assert.equal(typeof command.durationMs, "number");
      assert.ok(command.durationMs >= 0);
    }
  }
});
