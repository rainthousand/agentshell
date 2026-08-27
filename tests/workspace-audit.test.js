import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { workspaceAudit } from "../src/commands/workspace-audit.js";
import { classifyRiskFiles, parseCurrentBranch, parseNumstat, parsePorcelainStatus } from "../src/core/workspace-audit.js";

test("workspace audit summarizes staged, unstaged, untracked, diff, and risk categories", async () => {
  const changed = initRepo("changed");
  const clean = initRepo("clean");
  fs.writeFileSync(path.join(changed, "service.yaml"), "enabled: true\n");
  git(changed, ["add", "service.yaml"]);
  git(changed, ["commit", "-m", "add config"]);

  fs.appendFileSync(path.join(changed, "service.yaml"), "mode: test\n");
  fs.writeFileSync(path.join(changed, "api.proto"), "syntax = \"proto3\";\n");
  git(changed, ["add", "api.proto"]);
  fs.writeFileSync(path.join(changed, "package-lock.json"), "{}\n");
  fs.writeFileSync(path.join(changed, "service.pb.go"), "package service\n");
  const beforeAudit = git(changed, ["status", "--porcelain=v1", "-z"]).stdout;

  const result = await workspaceAudit([changed, clean], { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.workspace-audit.v1");
  assert.equal(result.limits.maxConcurrentGitProcesses, 4);
  assert.equal(result.summary.repositoryCount, 2);
  assert.equal(result.summary.changedTotal, 4);
  assert.equal(result.summary.staged, 1);
  assert.equal(result.summary.unstaged, 1);
  assert.equal(result.summary.untracked, 2);
  assert.equal(result.summary.detachedRepositories, 0);
  assert.equal(result.summary.riskFiles, 4);
  assert.deepEqual(result.summary.riskCategories, {
    generated: 1,
    lockfile: 1,
    protocol: 1,
    configuration: 1
  });
  assert.equal(result.summary.additions, 2);
  assert.equal(result.summary.deletions, 0);
  assert.equal(result.repositories[1].status.clean, true);
  assert.deepEqual(result.repositories[0].branch, { current: "main", detached: false, truncated: false });
  assert.equal(git(changed, ["status", "--porcelain=v1", "-z"]).stdout, beforeAudit);
});

test("workspace audit reports diff-check problems without exposing paths, files, or output", async () => {
  const first = initRepo("first-private");
  const second = initRepo("second-private");
  fs.appendFileSync(path.join(first, "README.md"), "trailing whitespace   \napi_key=secret-value\n");

  const result = await workspaceAudit([first, second]);
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.summary.diffCheckProblems, 1);
  assert.equal(result.repositories[0].diff.check.passed, false);
  assert.equal(result.privacy.workspacePathsExposed, false);
  assert.equal(result.privacy.fileNamesExposed, false);
  assert.equal(result.privacy.rawDiffExposed, false);
  assert.doesNotMatch(serialized, /README\.md|secret-value|api_key/);
  assert.doesNotMatch(serialized, new RegExp(escapeRegex(path.dirname(first))));
});

test("workspace audit preserves input order and returns bounded stable summaries", async () => {
  const alpha = initRepo("alpha");
  const beta = initRepo("beta");
  git(beta, ["checkout", "--detach"]);
  const first = await workspaceAudit([beta, alpha]);
  const second = await workspaceAudit([beta, alpha]);

  assert.deepEqual(first, second);
  assert.deepEqual(first.repositories.map((entry) => entry.rootId), ["root-1", "root-2"]);
  assert.deepEqual(first.repositories.map((entry) => entry.name), ["beta", "alpha"]);
  assert.deepEqual(first.repositories[0].branch, { current: null, detached: true, truncated: false });
  assert.equal(first.summary.detachedRepositories, 1);
  assert.ok(JSON.stringify(first).length < 5000);
  assert.ok(first.suggestedNextActions.length <= 3);
});

test("workspace audit reuses safe explicit-root validation and accepts up to 32 roots", async () => {
  const roots = Array.from({ length: 32 }, (_, index) => initRepo(`repo-${index}`));
  assert.equal((await workspaceAudit([roots[0]])).error.code, "TOO_FEW_ROOTS");
  assert.equal((await workspaceAudit([...roots, initRepo("extra")])).error.code, "TOO_MANY_ROOTS");
  assert.equal((await workspaceAudit([roots[0], roots[0]])).error.code, "DUPLICATE_ROOT");
  assert.equal((await workspaceAudit([os.homedir(), roots[1]])).error.code, "DANGEROUS_ROOT");

  const result = await workspaceAudit(roots);
  assert.equal(result.ok, true);
  assert.equal(result.summary.repositoryCount, 32);
});

test("workspace audit bounds all git subprocesses with one shared limiter", async () => {
  const roots = Array.from({ length: 8 }, (_, index) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `agentshell-audit-limit-${index}-`));
    return root;
  });
  let active = 0;
  let maximumActive = 0;
  let callCount = 0;
  const runProcess = async (args, cwd) => {
    callCount += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    const isTopLevel = args[1] === "rev-parse";
    const isBranch = args[1] === "branch";
    return {
      exitCode: 0,
      timedOut: false,
      truncated: false,
      spawnError: null,
      stdout: isTopLevel ? `${cwd}\n` : (isBranch ? "main\n" : ""),
      stderr: ""
    };
  };

  const result = await workspaceAudit(roots, { maxConcurrency: 3, runProcess });

  assert.equal(result.ok, true);
  assert.equal(result.limits.maxConcurrentGitProcesses, 3);
  assert.equal(maximumActive, 3);
  assert.equal(callCount, roots.length * 7);
  assert.deepEqual(result.repositories.map((entry) => entry.rootId), roots.map((_, index) => `root-${index + 1}`));
});

test("workspace audit clamps concurrency to a safe range", async () => {
  const first = initRepo("first-limit");
  const second = initRepo("second-limit");
  assert.equal((await workspaceAudit([first, second], { maxConcurrency: 0 })).limits.maxConcurrentGitProcesses, 1);
  assert.equal((await workspaceAudit([first, second], { maxConcurrency: 99 })).limits.maxConcurrentGitProcesses, 8);
  assert.equal((await workspaceAudit([first, second], { maxConcurrency: "invalid" })).limits.maxConcurrentGitProcesses, 4);
});

test("workspace audit returns structured failures for non-root repositories", async () => {
  const repo = initRepo("repo");
  const nested = path.join(repo, "nested");
  fs.mkdirSync(nested);
  const second = initRepo("second");

  const result = await workspaceAudit([nested, second]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "WORKSPACE_AUDIT_FAILED");
  assert.equal(result.error.details.failedRepositoryCount, 1);
  assert.deepEqual(result.error.details.failedRepositories[0], {
    rootId: "root-1",
    name: "nested",
    code: "NOT_GIT_ROOT",
    timedOut: false
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(escapeRegex(repo)));
});

test("workspace audit parsers handle renames, binary numstat, and exclusive risk classes", () => {
  const status = parsePorcelainStatus("R  new.go\0old.go\0?? scratch.txt\0 M tracked.go\0");
  assert.deepEqual(status, {
    changedTotal: 3,
    staged: 1,
    unstaged: 1,
    untracked: 1,
    conflicted: 0,
    files: ["new.go", "scratch.txt", "tracked.go"]
  });
  assert.deepEqual(parseNumstat("4\t2\ta.go\0-\t-\tasset.bin\0"), {
    files: 2,
    additions: 4,
    deletions: 2,
    binaryFiles: 1
  });
  assert.deepEqual(classifyRiskFiles(["generated/api.pb.go", "package-lock.json", "openapi.yaml", "config/app.yaml", "src/app.js"]), {
    riskFileCount: 4,
    categories: { generated: 1, lockfile: 1, protocol: 1, configuration: 1 }
  });
  assert.deepEqual(parseCurrentBranch("feature/audit\n"), {
    current: "feature/audit",
    detached: false,
    truncated: false
  });
  assert.deepEqual(parseCurrentBranch(""), { current: null, detached: true, truncated: false });
  assert.deepEqual(parseCurrentBranch(`feature/${"x".repeat(200)}`), {
    current: `feature/${"x".repeat(152)}`,
    detached: false,
    truncated: true
  });
});

test("workspace audit schema exposes bounded success and shared failure contracts", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/workspace-audit.schema.json", "utf8"));
  assert.equal(schema.title, "AgentShell Workspace Audit Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.workspace-audit.v1");
  assert.equal(schema.oneOf[0].properties.repositories.maxItems, 32);
  assert.equal(schema.oneOf[0].properties.limits.properties.maxConcurrentGitProcesses.maximum, 8);
  assert.equal(schema.oneOf[1].$ref, "common.schema.json#/$defs/failure");
});

function initRepo(name) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-workspace-audit-"));
  const repo = path.join(parent, name);
  fs.mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "agent@example.com"]);
  git(repo, ["config", "user.name", "AgentShell Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), `# ${name}\n`);
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
