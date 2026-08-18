import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { gitStatus, parsePorcelainV1, parsePorcelainV2 } from "../src/commands/git-status.js";

test("git status reports clean repositories compactly", async () => {
  const dir = initRepo();
  fs.writeFileSync(path.join(dir, "README.md"), "# demo\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "initial"]);

  const result = await gitStatus(dir, { compact: true });
  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.git-status.v1");
  assert.equal(result.compact, true);
  assert.equal(result.branch.name, "main");
  assert.equal(result.summary.clean, true);
  assert.equal(result.summary.dirty, false);
  assert.equal(result.summary.totalFiles, 0);
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.risks, []);
  assert.equal(result.suggestedNextActions[0].command, "agentshell run status --compact");
});

test("git status summarizes staged, unstaged, untracked, renamed, deleted, and risk files", async () => {
  const dir = initRepo();
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "old.js"), "export const value = 1;\n");
  fs.writeFileSync(path.join(dir, "src", "delete-me.js"), "delete me\n");
  fs.writeFileSync(path.join(dir, "package-lock.json"), "{}\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "initial"]);

  git(dir, ["mv", "src/old.js", "src/new.js"]);
  fs.writeFileSync(path.join(dir, "src", "tracked.js"), "tracked\n");
  git(dir, ["add", "src/tracked.js"]);
  fs.appendFileSync(path.join(dir, "package-lock.json"), "{\"changed\":true}\n");
  fs.unlinkSync(path.join(dir, "src", "delete-me.js"));
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist", "bundle.js"), "generated\n");

  const result = await gitStatus(dir, { compact: true, maxFiles: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.summary.dirty, true);
  assert.equal(result.summary.clean, false);
  assert.equal(result.summary.staged, 2);
  assert.equal(result.summary.unstaged, 2);
  assert.equal(result.summary.untracked, 1);
  assert.equal(result.summary.renamed, 1);
  assert.equal(result.summary.deleted, 1);
  assert.equal(result.summary.totalFiles, 5);
  assert.equal(result.summary.listedFiles, 3);
  assert.equal(result.summary.truncated, true);

  const renamed = result.files.find((file) => file.path === "src/new.js");
  assert.equal(renamed.originalPath, "src/old.js");
  assert.equal(renamed.staged, "renamed");

  const lockRisk = result.risks.find((risk) => risk.type === "lockfile");
  assert.equal(lockRisk.severity, "medium");
  assert.deepEqual(lockRisk.files, ["package-lock.json"]);
  const generatedRisk = result.risks.find((risk) => risk.type === "generated");
  assert.deepEqual(generatedRisk.files, ["dist/bundle.js"]);
  assert.ok(result.suggestedNextActions.some((action) => action.command === "agentshell git diff --compact"));
  assert.ok(result.suggestedNextActions.some((action) => action.command.includes("--max-files 100")));
});

test("git status returns clear error outside git repositories", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-git-status-nonrepo-"));
  const result = await gitStatus(dir, { compact: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "NOT_GIT_REPOSITORY");
  assert.match(result.error.message, /not inside a git repository/);
});

test("porcelain parsers cover v1 and v2 status shapes", () => {
  const v1 = parsePorcelainV1([
    "M  src/a.js",
    " M src/b.js",
    "R  src/old.js -> src/new.js",
    "?? scratch.txt",
    ""
  ].join("\n"));
  assert.deepEqual(v1.map((file) => [file.path, file.originalPath, file.staged, file.unstaged]), [
    ["src/a.js", null, "modified", null],
    ["src/b.js", null, null, "modified"],
    ["src/new.js", "src/old.js", "renamed", null],
    ["scratch.txt", null, "untracked", "untracked"]
  ]);

  const v2 = parsePorcelainV2([
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +2 -1",
    "1 .M N... 100644 100644 100644 abc abc src/b.js",
    "2 R. N... 100644 100644 100644 abc abc R100 src/new file.js\tsrc/old file.js",
    "? scratch.txt",
    ""
  ].join("\n"));
  assert.equal(v2.branch.name, "main");
  assert.equal(v2.branch.upstream, "origin/main");
  assert.equal(v2.branch.ahead, 2);
  assert.equal(v2.branch.behind, 1);
  assert.equal(v2.files[1].path, "src/new file.js");
  assert.equal(v2.files[1].originalPath, "src/old file.js");
});

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-git-status-"));
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
