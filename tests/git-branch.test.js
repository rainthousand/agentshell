import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { gitBranch, parseTrack, remoteHostHint } from "../src/commands/git-branch.js";

test("git branch summarizes current branch, upstream counts, branches, and redacted remotes", async () => {
  const root = initRepo();
  fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "initial"]);
  git(root, ["remote", "add", "origin", "git@github.com:rainthousand/agentshell-private.git"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(root, ["config", "branch.main.remote", "origin"]);
  git(root, ["config", "branch.main.merge", "refs/heads/main"]);
  fs.writeFileSync(path.join(root, "next.md"), "next\n");
  git(root, ["add", "next.md"]);
  git(root, ["commit", "-m", "ahead"]);
  git(root, ["switch", "-c", "feature/demo"]);
  git(root, ["switch", "main"]);

  const result = await gitBranch(root, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.git-branch.v1");
  assert.equal(result.compact, true);
  assert.equal(result.current.name, "main");
  assert.equal(result.current.detached, false);
  assert.equal(result.current.upstream, "origin/main");
  assert.equal(result.current.ahead, 1);
  assert.equal(result.current.behind, 0);
  assert.equal(result.summary.localBranchCount, 2);
  assert.equal(result.summary.remoteCount, 1);
  assert.equal(result.summary.hasUpstream, true);
  assert.ok(result.branches.some((branch) => branch.name === "main" && branch.current));
  assert.ok(result.branches.some((branch) => branch.name === "feature/demo" && !branch.current));
  assert.deepEqual(result.remotes, [{ name: "origin", host: "github.com", provider: "github" }]);
  assert.equal(JSON.stringify(result).includes("rainthousand/agentshell-private"), false);
  assert.ok(result.suggestedNextActions.some((action) => action.command === "agentshell git status --compact"));
});

test("git branch truncates local branch lists and suggests a wider query", async () => {
  const root = initRepo();
  fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "initial"]);
  git(root, ["branch", "alpha"]);
  git(root, ["branch", "beta"]);

  const result = await gitBranch(root, { compact: true, maxBranches: 1 });

  assert.equal(result.ok, true);
  assert.equal(result.summary.localBranchCount, 3);
  assert.equal(result.summary.returnedBranchCount, 1);
  assert.equal(result.summary.truncatedBranches, true);
  assert.ok(result.suggestedNextActions.some((action) => action.command.includes("--max-branches 100")));
});

test("git branch handles detached HEAD and non git repositories", async () => {
  const root = initRepo();
  fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "initial"]);
  const commit = git(root, ["rev-parse", "HEAD"]).stdout.trim();
  git(root, ["checkout", commit]);

  const detached = await gitBranch(root, { compact: true });
  assert.equal(detached.ok, true);
  assert.equal(detached.current.name, null);
  assert.equal(detached.current.detached, true);
  assert.equal(detached.summary.detached, true);
  assert.equal(detached.suggestedNextActions[0].command, "git switch -");

  const notGit = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-git-branch-nonrepo-"));
  const error = await gitBranch(notGit, { compact: true });
  assert.equal(error.ok, false);
  assert.equal(error.error.code, "NOT_GIT_REPOSITORY");
});

test("git branch helpers parse track text and remote host hints", () => {
  assert.deepEqual(parseTrack("[ahead 3, behind 2]"), { ahead: 3, behind: 2 });
  assert.deepEqual(parseTrack("[behind 4]"), { ahead: 0, behind: 4 });
  assert.deepEqual(remoteHostHint("https://gitlab.example.com/team/repo.git"), {
    host: "gitlab.example.com",
    provider: "gitlab"
  });
  assert.deepEqual(remoteHostHint("/tmp/agentshell-local-repo"), {
    host: null,
    provider: "local"
  });
});

test("git branch exposes a parseable JSON schema contract", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/git-branch.schema.json", "utf8"));

  assert.equal(schema.title, "AgentShell Git Branch Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.git-branch.v1");
  assert.ok(schema.oneOf[0].required.includes("current"));
  assert.ok(schema.oneOf[0].required.includes("branches"));
  assert.ok(schema.$defs.remote.required.includes("provider"));
});

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-git-branch-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "agent@example.com"]);
  git(dir, ["config", "user.name", "AgentShell Test"]);
  return dir;
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result;
}
