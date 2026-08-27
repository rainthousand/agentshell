import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  DEFAULT_SKILL_BUDGET,
  analyzeSkill,
  estimateTokens,
  parseSkillSource
} from "../scripts/skill-performance.js";

const script = path.resolve("scripts/skill-performance.js");

test("skill analysis measures frontmatter, body, files, and references", () => {
  const root = fixtureSkill({
    description: "Compact project inspection.",
    body: "# Demo\n\nRead [core](references/core.md).\n"
  });
  fs.mkdirSync(path.join(root, "references"));
  fs.writeFileSync(path.join(root, "references", "core.md"), "# Core\n\nDetails.\n");

  const report = analyzeSkill(root);

  assert.equal(report.ok, true);
  assert.equal(report.skill.frontmatter.present, true);
  assert.equal(report.skill.frontmatter.metadata.name, "fixture");
  assert.equal(report.skill.frontmatter.metadata.description, "Compact project inspection.");
  assert.ok(report.skill.frontmatter.estimatedTokens > 0);
  assert.ok(report.skill.body.estimatedTokens > 0);
  assert.equal(report.references.count, 1);
  assert.deepEqual(report.references.linkedPaths, ["references/core.md"]);
  assert.deepEqual(report.references.missingLinkedPaths, []);
  assert.equal(report.references.files[0].path, "references/core.md");
  assert.deepEqual(report.budget, DEFAULT_SKILL_BUDGET);
});

test("default budget passes a thin skill", () => {
  const root = fixtureSkill({ description: "Focused workflow.", body: "# Skill\n\nUse the compact command.\n" });
  const report = analyzeSkill(root);

  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map((check) => check.status), ["pass", "pass"]);
});

test("AgentShell main skill stays a small routing index with linked references", () => {
  const report = analyzeSkill("skills/agentshell");

  assert.equal(report.ok, true);
  assert.ok(report.skill.estimatedTokens <= 800, `main skill is ${report.skill.estimatedTokens} estimated tokens`);
  assert.ok(report.references.count >= 8);
  assert.deepEqual(report.references.missingLinkedPaths, []);
  assert.ok(report.references.linkedPaths.includes("references/safety-and-fallback.md"));
});

test("budget reports main skill and description failures", () => {
  const root = fixtureSkill({ description: "d".repeat(600), body: `# Skill\n\n${"body ".repeat(1_400)}\n` });
  const report = analyzeSkill(root);

  assert.equal(report.ok, false);
  assert.deepEqual(report.checks.map((check) => check.status), ["fail", "fail"]);
  assert.ok(report.skill.estimatedTokens > 1_200);
  assert.ok(report.skill.frontmatter.descriptionEstimatedTokens > 120);
});

test("frontmatter parser supports folded descriptions and estimator is deterministic", () => {
  const parsed = parseSkillSource("---\nname: demo\ndescription: >\n  First line\n  second line\n---\n# Body\n");

  assert.equal(parsed.metadata.description, "First line second line");
  assert.equal(parsed.body, "# Body\n");
  assert.equal(estimateTokens("12345"), 2);
});

test("CLI gate returns non-zero for a budget violation", () => {
  const root = fixtureSkill({ description: "ok", body: "x".repeat(5_000) });
  const reportMode = spawnSync(process.execPath, [script, "--skill", root], { encoding: "utf8" });
  const gateMode = spawnSync(process.execPath, [script, "--skill", root, "--gate"], { encoding: "utf8" });

  assert.equal(reportMode.status, 0, reportMode.stderr);
  assert.equal(gateMode.status, 1, gateMode.stderr);
  assert.equal(JSON.parse(gateMode.stdout).ok, false);
});

function fixtureSkill({ description, body }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-skill-performance-"));
  fs.writeFileSync(path.join(root, "SKILL.md"), `---\nname: fixture\ndescription: ${description}\n---\n${body}`);
  return root;
}
