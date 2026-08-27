import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { gitInfo } from "../src/core/git.js";

test("git info preserves the first character of tracked and untracked paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-git-info-"));
  run(root, ["init"]);
  run(root, ["config", "user.email", "agentshell@example.invalid"]);
  run(root, ["config", "user.name", "AgentShell Test"]);
  fs.writeFileSync(path.join(root, "README.md"), "initial\n");
  run(root, ["add", "README.md"]);
  run(root, ["commit", "-m", "initial"]);

  fs.writeFileSync(path.join(root, "README.md"), "changed\n");
  fs.writeFileSync(path.join(root, "TODO.md"), "new\n");

  const info = gitInfo(root);
  assert.equal(info.available, true);
  assert.equal(info.dirty, true);
  assert.deepEqual(info.changedFiles.sort(), ["README.md", "TODO.md"]);
});

function run(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}
