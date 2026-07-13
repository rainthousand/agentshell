import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { runPluginActivationSmoke } from "../scripts/plugin-activation-smoke.js";

const root = path.resolve(import.meta.dirname, "..");
const guidance = `
# AgentShell

From the project root, run \`agentshell start --compact\` before broad shell exploration.
Fall back to ordinary shell commands only for unsupported actions.
Run \`agentshell verify test\` again for final verification.
For beta evidence, run \`agentshell trial export --verify --rating 1-5\` before sharing.
`;

test("activation smoke exercises start, verify, and ready trial status through the actual CLI", () => {
  const installed = makePluginFixture(guidance);
  const source = path.join(installed, "source-SKILL.md");
  fs.writeFileSync(source, guidance);

  const report = runPluginActivationSmoke({
    cli: path.join(root, "src", "cli.js"),
    sourceSkill: source,
    installedSkill: installed
  });

  assert.equal(report.ok, true);
  assert.equal(report.protocolVersion, "agentshell.plugin-activation-smoke.v1");
  assert.equal(report.compact, true);
  assert.deepEqual(report.summary, { total: 3, passed: 3, failed: 0 });
  const flow = report.checks.find((check) => check.name === "bounded CLI activation flow");
  assert.deepEqual(flow.steps.map((step) => step.name), ["start", "verify", "trial-status"]);
  assert.ok(flow.steps.every((step) => step.ok));
  assert.equal(flow.evidence.verificationRecorded, true);
  assert.equal(flow.evidence.trialReady, true);
  assert.equal(JSON.stringify(report).includes("TAP version"), false);
  assert.equal(JSON.stringify(report).includes("fixture.test.js"), false);
});

test("activation smoke reports missing source and installed guidance precisely", () => {
  const installed = makePluginFixture("Use AgentShell sometimes.");
  const source = path.join(installed, "source-SKILL.md");
  fs.writeFileSync(source, "Use AgentShell sometimes.\n");

  const report = runPluginActivationSmoke({
    cli: path.join(root, "src", "cli.js"),
    sourceSkill: source,
    installedSkill: installed
  });

  assert.equal(report.ok, false);
  assert.equal(report.summary.failed, 2);
  for (const check of report.checks.filter((entry) => entry.name.includes("skill activation guidance"))) {
    assert.deepEqual(check.guidance, {
      projectRootFirst: false,
      agentShellEarly: false,
      finalVerify: false,
      betaExport: false
    });
    assert.match(check.error, /projectRootFirst/);
  }
});

test("activation smoke bounds a failing command without returning raw test logs", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-activation-failure-"));
  const source = path.join(fixture, "SKILL.md");
  fs.writeFileSync(source, guidance);
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({
    name: "failure-fixture",
    scripts: { test: "node -e \\\"console.error('PRIVATE_RAW_LOG_MARKER'); process.exit(1)\\\"" }
  }));

  const report = runPluginActivationSmoke({
    cli: path.join(root, "src", "cli.js"),
    sourceSkill: source,
    fixture
  });
  const serialized = JSON.stringify(report);

  assert.equal(report.ok, false);
  assert.equal(report.checks[0].steps.at(-1).name, "verify");
  assert.equal(serialized.includes("PRIVATE_RAW_LOG_MARKER"), false);
  assert.equal(serialized.length < 4_000, true);
});

test("activation smoke CLI emits one compact JSON document", () => {
  const source = path.join(makePluginFixture(guidance), "skills", "agentshell", "SKILL.md");
  const result = spawnSync("node", ["scripts/plugin-activation-smoke.js", "--source", source], {
    cwd: root,
    encoding: "utf8"
  });
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.ok, true);
  assert.equal(output.compact, true);
  assert.equal(result.stdout.trim().split("\n").length, 1);
});

function makePluginFixture(skill) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-activation-skill-"));
  const skillDir = path.join(fixture, "skills", "agentshell");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), skill);
  return fixture;
}
