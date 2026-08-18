import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { gitLog, parseGitLog } from "../src/commands/git-log.js";

test("git log summarizes recent commits without patches", async () => {
  const dir = initRepo();
  commitFile(dir, "one.txt", "one\n", "first commit", "2024-01-01T00:00:00Z");
  commitFile(dir, "two.txt", "two\n", "second commit", "2024-01-02T00:00:00Z");
  commitFile(dir, "three.txt", "three\n", "third commit", "2024-01-03T00:00:00Z");

  const result = await gitLog(dir, { compact: true, limit: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.git-log.v1");
  assert.equal(result.compact, true);
  assert.equal(result.summary.requestedLimit, 2);
  assert.equal(result.summary.returnedCommits, 2);
  assert.equal(result.summary.hasCommits, true);
  assert.equal(result.summary.truncated, true);
  assert.deepEqual(result.commits.map((commit) => commit.subject), ["third commit", "second commit"]);
  assert.match(result.commits[0].hash, /^[0-9a-f]{40}$/);
  assert.match(result.commits[0].shortHash, /^[0-9a-f]{7,12}$/);
  assert.equal(result.commits[0].authorName, "AgentShell Test");
  assert.match(result.commits[0].authorDate, /^2024-01-03T00:00:00(?:Z|\+00:00)$/);
  assert.ok(!JSON.stringify(result).includes("diff --git"));
  assert.ok(result.suggestedNextActions.some((action) => action.command === "agentshell git status --compact"));
  assert.ok(result.suggestedNextActions.some((action) => action.command.includes("--limit 50")));
});

test("git log caps limit at 50", async () => {
  const dir = initRepo();
  for (let index = 1; index <= 52; index += 1) {
    commitFile(dir, `${index}.txt`, `${index}\n`, `commit ${index}`, `2024-02-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`);
  }

  const result = await gitLog(dir, { compact: true, limit: 99 });
  assert.equal(result.ok, true);
  assert.equal(result.summary.requestedLimit, 50);
  assert.equal(result.summary.returnedCommits, 50);
  assert.equal(result.summary.truncated, true);
  assert.equal(result.commits.length, 50);
});

test("git log returns a compact empty history for repositories without commits", async () => {
  const dir = initRepo();
  const result = await gitLog(dir, { compact: true });
  assert.equal(result.ok, true);
  assert.equal(result.summary.hasCommits, false);
  assert.equal(result.summary.returnedCommits, 0);
  assert.equal(result.summary.truncated, false);
  assert.deepEqual(result.commits, []);
  assert.equal(result.suggestedNextActions[0].command, "agentshell git status --compact");
});

test("git log returns clear error outside git repositories", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-git-log-nonrepo-"));
  const result = await gitLog(dir, { compact: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "NOT_GIT_REPOSITORY");
  assert.match(result.error.message, /not inside a git repository/);
});

test("parseGitLog handles compact git field separators", () => {
  const output = [
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "aaaaaaa",
    "subject line",
    "Alvin",
    "2024-01-01T00:00:00+00:00",
    "2 days ago"
  ].join("\x1f") + "\x1e";

  assert.deepEqual(parseGitLog(output), [{
    hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    shortHash: "aaaaaaa",
    subject: "subject line",
    authorName: "Alvin",
    authorDate: "2024-01-01T00:00:00+00:00",
    relativeAge: "2 days ago"
  }]);
});

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-git-log-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "agent@example.com"]);
  git(dir, ["config", "user.name", "AgentShell Test"]);
  return dir;
}

function commitFile(cwd, fileName, content, message, date) {
  fs.writeFileSync(path.join(cwd, fileName), content);
  git(cwd, ["add", fileName]);
  git(cwd, ["commit", "-m", message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date
  });
}

function git(cwd, args, env = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}
