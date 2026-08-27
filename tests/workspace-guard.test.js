import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { workspaceGuard } from "../src/commands/workspace-guard.js";

test("workspace guard summarizes multiple repositories without exposing paths", async () => {
  const clean = initRepo("clean");
  const dirty = initRepo("dirty");
  fs.appendFileSync(path.join(dirty, "README.md"), "dirty\n");
  fs.writeFileSync(path.join(dirty, "scratch.txt"), "untracked\n");

  const result = await workspaceGuard([clean, dirty], { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.workspace-guard.v1");
  assert.equal(result.summary.repositoryCount, 2);
  assert.equal(result.summary.cleanRepositories, 1);
  assert.equal(result.summary.dirtyRepositories, 1);
  assert.equal(result.summary.changedFiles, 2);
  assert.equal(result.summary.untrackedFiles, 1);
  assert.equal(result.summary.branchesAligned, true);
  assert.deepEqual(result.repositories.map((entry) => entry.rootId), ["root-1", "root-2"]);
  assert.equal(result.repositories[0].branch.current, "main");
  assert.equal(result.repositories[0].branch.ahead, null);
  assert.equal(result.repositories[0].branch.behind, null);
  assert.equal(result.privacy.workspacePathsExposed, false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(escapeRegex(path.dirname(clean))));
});

test("workspace guard reports available ahead and behind counts", async () => {
  const repo = initRepo("tracked");
  git(repo, ["branch", "upstream"]);
  fs.writeFileSync(path.join(repo, "main.txt"), "main\n");
  git(repo, ["add", "main.txt"]);
  git(repo, ["commit", "-m", "main change"]);
  git(repo, ["checkout", "upstream"]);
  fs.writeFileSync(path.join(repo, "upstream.txt"), "upstream\n");
  git(repo, ["add", "upstream.txt"]);
  git(repo, ["commit", "-m", "upstream change"]);
  git(repo, ["checkout", "main"]);
  git(repo, ["branch", "--set-upstream-to=upstream"]);
  const second = initRepo("second");

  const result = await workspaceGuard([repo, second]);

  assert.equal(result.ok, true);
  assert.equal(result.repositories[0].branch.trackingAvailable, true);
  assert.equal(result.repositories[0].branch.ahead, 1);
  assert.equal(result.repositories[0].branch.behind, 1);
  assert.equal(result.summary.aheadCommits, 1);
  assert.equal(result.summary.behindCommits, 1);
});

test("workspace guard rejects too few, too many, duplicate, and dangerous roots", async () => {
  const first = initRepo("first");
  const second = initRepo("second");
  const third = initRepo("third");

  assert.equal((await workspaceGuard([first])).error.code, "TOO_FEW_ROOTS");
  assert.equal((await workspaceGuard([first, second, third], { maxRoots: 2 })).error.code, "TOO_MANY_ROOTS");
  assert.equal((await workspaceGuard([first, first])).error.code, "DUPLICATE_ROOT");
  assert.equal((await workspaceGuard([os.homedir(), second])).error.code, "DANGEROUS_ROOT");
  assert.equal((await workspaceGuard([path.parse(process.cwd()).root, second])).error.code, "DANGEROUS_ROOT");
});

test("workspace guard resolves symlinks and requires exact git roots", async () => {
  const repo = initRepo("repo");
  const second = initRepo("second");
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-guard-link-")), "repo-link");
  fs.symlinkSync(repo, link, "dir");

  assert.equal((await workspaceGuard([repo, link])).error.code, "DUPLICATE_ROOT");

  const nested = path.join(repo, "nested");
  fs.mkdirSync(nested);
  const nestedResult = await workspaceGuard([nested, second]);
  assert.equal(nestedResult.ok, false);
  assert.equal(nestedResult.error.code, "NOT_GIT_ROOT");

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-guard-plain-"));
  assert.equal((await workspaceGuard([plain, second])).error.code, "NOT_GIT_ROOT");
});

test("workspace guard schema exposes success and shared failure contracts", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/workspace-guard.schema.json", "utf8"));
  assert.equal(schema.title, "AgentShell Workspace Guard Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.workspace-guard.v1");
  assert.ok(schema.oneOf[0].properties.repositories.items.required.includes("branch"));
  assert.equal(schema.oneOf[1].$ref, "common.schema.json#/$defs/failure");
});

function initRepo(name) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-workspace-guard-"));
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
