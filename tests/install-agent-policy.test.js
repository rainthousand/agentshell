import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { installAgentPolicy } from "../scripts/install-agent-policy.js";

test("agent policy installer preserves existing AGENTS content", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-policy-"));
  const target = path.join(dir, "AGENTS.md");
  fs.writeFileSync(target, "# Existing\n\nKeep this.\n");

  const report = installAgentPolicy(target);
  const text = fs.readFileSync(target, "utf8");

  assert.equal(report.ok, true);
  assert.equal(report.changed, true);
  assert.match(text, /# Existing/);
  assert.match(text, /Keep this\./);
  assert.match(text, /<!-- agentshell-policy:start -->/);
  assert.match(text, /agentshell start --compact/);
  assert.match(text, /<!-- agentshell-policy:end -->/);
});

test("agent policy installer updates only its managed block", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-policy-update-"));
  const target = path.join(dir, "AGENTS.md");
  fs.writeFileSync(target, [
    "Before",
    "",
    "<!-- agentshell-policy:start -->",
    "old policy",
    "<!-- agentshell-policy:end -->",
    "",
    "After",
    ""
  ].join("\n"));

  installAgentPolicy(target);
  const text = fs.readFileSync(target, "utf8");

  assert.match(text, /^Before/m);
  assert.doesNotMatch(text, /old policy/);
  assert.match(text, /agentshell fix test --fast --compact/);
  assert.match(text, /After/);
});

test("managed policy activates AgentShell from the real project root", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-policy-activation-"));
  const target = path.join(dir, "AGENTS.md");

  installAgentPolicy(target);
  const text = fs.readFileSync(target, "utf8");

  assert.match(text, /project root/);
  assert.match(text, /never blindly run project commands from `\$HOME`/);
  assert.match(text, /agentshell start --compact/);
  assert.match(text, /resolve the newest version under .*plugins\/cache\/personal\/agentshell\//);
  assert.match(text, /agentshell verify test --compact/);
  assert.match(text, /agentshell trial status/);
  assert.match(text, /agentshell trial export --verify --rating 1-5/);
  assert.match(text, /Keep MCP deferred/);
});

test("agent policy installer dry run reports without writing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-policy-dry-"));
  const target = path.join(dir, "AGENTS.md");
  fs.writeFileSync(target, "Existing\n");

  const report = installAgentPolicy(target, { dryRun: true });
  const text = fs.readFileSync(target, "utf8");

  assert.equal(report.status, "would-update");
  assert.equal(report.changed, true);
  assert.equal(text, "Existing\n");
});

test("agent policy installer CLI prints JSON report", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-policy-cli-"));
  const target = path.join(dir, "AGENTS.md");
  const result = spawnSync("node", [
    "scripts/install-agent-policy.js",
    "--target",
    target,
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.protocolVersion, "agentshell.agent-policy-install.v1");
  assert.equal(report.status, "updated");
  assert.match(fs.readFileSync(target, "utf8"), /AgentShell Default Policy/);
});

test("agent policy installer CLI prints friendly human report", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-policy-human-"));
  const target = path.join(dir, "AGENTS.md");
  const result = spawnSync("node", [
    "scripts/install-agent-policy.js",
    "--target",
    target
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /AgentShell Codex policy/);
  assert.match(result.stdout, /Configured:/);
  assert.match(result.stdout, /No manual paste step is needed/);
});

test("agent policy installer CLI dry run explains that nothing changed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-policy-human-dry-"));
  const target = path.join(dir, "AGENTS.md");
  fs.writeFileSync(target, "Existing\n");
  const result = spawnSync("node", [
    "scripts/install-agent-policy.js",
    "--target",
    target,
    "--dry-run"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Preview only/);
  assert.match(result.stdout, /No file was changed/);
  assert.equal(fs.readFileSync(target, "utf8"), "Existing\n");
});

test("codex user installer includes global agent policy step", () => {
  const result = spawnSync("node", ["scripts/install-for-codex-user.js", "--dry-run", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.steps.some((step) => step.name === "agent-policy"));
  const policy = report.steps.find((step) => step.name === "agent-policy");
  assert.equal(policy.command, "node scripts/install-agent-policy.js --json");
});
