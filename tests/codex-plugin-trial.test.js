import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { runCodexPluginTrial } from "../scripts/codex-plugin-trial.js";

test("codex plugin trial compares raw and AgentShell-guided runs", () => {
  const report = runCodexPluginTrial();

  assert.equal(report.ok, true);
  assert.equal(report.protocolVersion, "agentshell.codex-plugin-trial.v1");
  assert.equal(report.summary.total, 2);
  assert.ok(report.trials.some((trial) => trial.id === "codex-raw-baseline" && trial.interpretation === "weak"));
  assert.ok(report.trials.some((trial) => trial.id === "codex-plugin-agentshell" && trial.interpretation === "strong"));
});

test("codex plugin trial CLI prints parseable JSON", () => {
  const result = spawnSync("node", ["scripts/codex-plugin-trial.js"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.codex-plugin-trial.v1");
  assert.equal(output.summary.total, 2);
});

test("codex plugin trial schema is exposed through schema get", () => {
  const result = spawnSync("node", ["src/cli.js", "schema", "get", "codex-plugin-trial"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const schema = JSON.parse(result.stdout);
  assert.equal(schema.protocolVersion, "agentshell.schema-get.v1");
  assert.equal(schema.properties.protocolVersion.const, "agentshell.codex-plugin-trial.v1");
  assert.ok(schema.properties.purpose);
  assert.ok(schema.properties.recommendation);
  assert.ok(schema.$defs.metrics.properties.agentShellCommandCount);
});

test("package exposes codex plugin trial script", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(packageJson.scripts?.["codex:plugin:trial"], "node scripts/codex-plugin-trial.js");
});
