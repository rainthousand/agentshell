import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { compareSkills } from "../scripts/skill-ab-eval.js";

const script = path.resolve("scripts/skill-ab-eval.js");

test("A/B evaluation reports static activation context reduction", () => {
  const current = fixtureSkill("Current skill.", "command\n".repeat(2_000));
  const candidate = fixtureSkill("Candidate skill.", "route\n".repeat(100));
  const report = compareSkills(current, candidate);

  assert.equal(report.ok, true);
  assert.ok(report.comparison.estimatedContextTokens.reduction > 0);
  assert.ok(report.comparison.estimatedContextTokens.reductionPercent > 80);
  assert.equal(report.comparison.estimatedContextTokens.current, report.current.skill.estimatedTokens);
  assert.equal(report.comparison.estimatedContextTokens.candidate, report.candidate.skill.estimatedTokens);
  assert.match(report.estimator.scope, /references.*excluded/i);
});

test("A/B gate fails when the candidate grows or remains over budget", () => {
  const current = fixtureSkill("Current.", "short\n");
  const candidate = fixtureSkill("d".repeat(600), "long\n".repeat(1_500));
  const result = spawnSync(process.execPath, [
    script,
    "--current", current,
    "--candidate", candidate,
    "--gate"
  ], { encoding: "utf8" });

  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.comparison.estimatedContextTokens.reduction < 0);
  assert.equal(report.candidate.ok, false);
});

test("A/B CLI writes a machine-readable report", () => {
  const current = fixtureSkill("Current.", "detail\n".repeat(500));
  const candidate = fixtureSkill("Candidate.", "route\n".repeat(30));
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-skill-ab-output-")), "nested", "report.json");
  const result = spawnSync(process.execPath, [
    script,
    "--current", current,
    "--candidate", candidate,
    "--output", output
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).protocolVersion, "agentshell.skill-ab-eval.v1");
});

function fixtureSkill(description, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-skill-ab-"));
  fs.writeFileSync(path.join(root, "SKILL.md"), `---\nname: fixture\ndescription: ${description}\n---\n# Skill\n\n${body}`);
  return root;
}
