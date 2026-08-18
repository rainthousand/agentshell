import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { gitDiff } from "../src/commands/git-diff.js";

test("git diff returns compact unstaged file and hunk summaries without raw diff", async () => {
  const root = makeGitFixture({
    "src/app.js": [
      "export function answer() {",
      "  return 41;",
      "}",
      ""
    ].join("\n"),
    "package-lock.json": "{}\n"
  });
  fs.writeFileSync(path.join(root, "src", "app.js"), [
    "export function answer() {",
    "  const value = 42;",
    "  return value;",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(root, "package-lock.json"), "{\n  \"lockfileVersion\": 3\n}\n");

  const result = await gitDiff(root, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.git-diff.v1");
  assert.equal(result.compact, true);
  assert.equal(result.mode, "unstaged");
  assert.equal(result.summary.fileCount, 2);
  assert.equal(result.summary.hasChanges, true);
  assert.equal(result.summary.insertions, 5);
  assert.equal(result.summary.deletions, 2);
  assert.match(result.diffRef, /^diff_/);
  assert.equal(result.files.length, 2);
  assert.deepEqual(
    result.files.map((file) => file.path).sort(),
    ["package-lock.json", "src/app.js"]
  );
  const app = result.files.find((file) => file.path === "src/app.js");
  assert.equal(app.changeType, "modified");
  assert.equal(app.insertions, 2);
  assert.equal(app.deletions, 1);
  assert.equal(app.hunks.length, 1);
  assert.equal(app.hunks[0].oldStart, 2);
  assert.equal(app.hunks[0].newStart, 2);
  assert.equal(result.risks.some((risk) => risk.code === "lockfile-change"), true);
  assert.equal(JSON.stringify(result).includes("return 41"), false);
  assert.ok(result.suggestedNextActions.some((action) => action.command.includes("agentshell log get")));
});

test("git diff supports staged scope independently from unstaged changes", async () => {
  const root = makeGitFixture({
    "src/app.js": "console.log('old');\n",
    "src/extra.js": "console.log('extra old');\n"
  });
  fs.writeFileSync(path.join(root, "src", "app.js"), "console.log('staged');\n");
  git(root, ["add", "src/app.js"]);
  fs.writeFileSync(path.join(root, "src", "extra.js"), "console.log('unstaged');\n");

  const staged = await gitDiff(root, { compact: true, staged: true });
  const unstaged = await gitDiff(root, { compact: true });

  assert.equal(staged.ok, true);
  assert.equal(staged.mode, "staged");
  assert.deepEqual(staged.files.map((file) => file.path), ["src/app.js"]);
  assert.equal(unstaged.ok, true);
  assert.equal(unstaged.mode, "unstaged");
  assert.deepEqual(unstaged.files.map((file) => file.path), ["src/extra.js"]);
});

test("git diff reports empty diffs and non git repositories clearly", async () => {
  const clean = makeGitFixture({ "README.md": "hello\n" });
  const empty = await gitDiff(clean, { compact: true });

  assert.equal(empty.ok, true);
  assert.equal(empty.summary.hasChanges, false);
  assert.equal(empty.summary.fileCount, 0);
  assert.equal(empty.diffRef, null);
  assert.equal(empty.files.length, 0);

  const notGit = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-not-git-"));
  const error = await gitDiff(notGit, { compact: true });

  assert.equal(error.ok, false);
  assert.equal(error.error.code, "NOT_GIT_REPOSITORY");
  assert.match(error.error.message, /not inside a git repository/i);
});

test("git diff exposes a parseable JSON schema contract", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/git-diff.schema.json", "utf8"));

  assert.equal(schema.title, "AgentShell Git Diff Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.git-diff.v1");
  assert.ok(schema.oneOf[0].required.includes("diffRef"));
  assert.ok(schema.$defs.file.required.includes("changeType"));
  assert.ok(schema.$defs.file.required.includes("hunks"));
});

function makeGitFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-git-diff-"));
  git(root, ["init"]);
  git(root, ["config", "user.email", "agent@example.com"]);
  git(root, ["config", "user.name", "AgentShell Test"]);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}
