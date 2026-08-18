import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { filesChanged } from "../src/commands/files-changed.js";

test("files changed reports clean repositories compactly", async () => {
  const root = makeGitFixture({ "README.md": "# demo\n" });

  const result = await filesChanged(root, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.files-changed.v1");
  assert.equal(result.compact, true);
  assert.equal(result.summary.clean, true);
  assert.equal(result.summary.dirty, false);
  assert.equal(result.summary.totalFiles, 0);
  assert.equal(result.summary.returnedFiles, 0);
  assert.equal(result.summary.truncated, false);
  assert.deepEqual(result.files, []);
  assert.equal(result.suggestedNextActions[0].command, "agentshell run status --compact");
});

test("files changed summarizes typed staged, unstaged, untracked, category, and risk", async () => {
  const root = makeGitFixture({
    "src/app.js": "export const value = 1;\n",
    "package.json": "{\"scripts\":{\"test\":\"node --test\"}}\n",
    "package-lock.json": "{}\n",
    "docs/guide.md": "# Guide\n",
    "assets/logo.png": "png\n",
    ".github/workflows/ci.yml": "name: ci\n"
  });

  fs.writeFileSync(path.join(root, "src", "app.test.js"), "test('ok', () => {});\n");
  git(root, ["add", "src/app.test.js"]);
  fs.appendFileSync(path.join(root, "src", "app.js"), "export const next = 2;\n");
  fs.appendFileSync(path.join(root, "package.json"), "{\"changed\":true}\n");
  fs.appendFileSync(path.join(root, "package-lock.json"), "{\"changed\":true}\n");
  fs.appendFileSync(path.join(root, "docs", "guide.md"), "More docs\n");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "bundle.min.js"), "generated\n", { flag: "w" });
  fs.writeFileSync(path.join(root, "SECURITY.md"), "# Security\n");
  fs.writeFileSync(path.join(root, "assets", "banner.svg"), "<svg />\n");
  fs.writeFileSync(path.join(root, ".github", "dependabot.yml"), "version: 2\n");

  const result = await filesChanged(root, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.summary.clean, false);
  assert.equal(result.summary.dirty, true);
  assert.equal(result.summary.totalFiles, 9);
  assert.equal(result.summary.returnedFiles, 9);
  assert.equal(result.summary.truncated, false);
  assert.equal(result.summary.staged, 1);
  assert.equal(result.summary.unstaged, 4);
  assert.equal(result.summary.untracked, 4);
  assert.equal(result.summary.categories.test, 1);
  assert.equal(result.summary.categories.source, 1);
  assert.equal(result.summary.categories.config, 2);
  assert.equal(result.summary.categories.lockfile, 1);
  assert.equal(result.summary.categories.docs, 2);
  assert.equal(result.summary.categories.asset, 1);
  assert.equal(result.summary.categories.generated, 1);
  assert.equal(result.summary.risks.high, 2);
  assert.equal(result.summary.risks.medium, 2);
  assert.equal(result.summary.risks.low, 5);

  const byPath = new Map(result.files.map((file) => [file.path, file]));
  assert.deepEqual(byPath.get("src/app.test.js"), {
    path: "src/app.test.js",
    status: "added",
    staged: true,
    unstaged: false,
    untracked: false,
    category: "test",
    risk: "low"
  });
  assert.deepEqual(byPath.get("src/app.js"), {
    path: "src/app.js",
    status: "modified",
    staged: false,
    unstaged: true,
    untracked: false,
    category: "source",
    risk: "low"
  });
  assert.equal(byPath.get("package.json").category, "config");
  assert.equal(byPath.get("package.json").risk, "high");
  assert.equal(byPath.get("package-lock.json").category, "lockfile");
  assert.equal(byPath.get("package-lock.json").risk, "medium");
  assert.equal(byPath.get("dist/bundle.min.js").category, "generated");
  assert.equal(byPath.get("dist/bundle.min.js").risk, "low");
  assert.equal(byPath.get("SECURITY.md").category, "docs");
  assert.equal(byPath.get("SECURITY.md").risk, "high");
  assert.equal(byPath.get(".github/dependabot.yml").category, "config");
  assert.equal(byPath.get(".github/dependabot.yml").risk, "medium");
  assert.equal(byPath.get("assets/banner.svg").category, "asset");
  assert.equal(JSON.stringify(result).includes("@@"), false);
  assert.ok(result.suggestedNextActions.some((action) => action.command === "agentshell git status --compact"));
  assert.ok(result.suggestedNextActions.some((action) => action.command === "agentshell git diff --compact"));
});

test("files changed truncates compact output while preserving total summary", async () => {
  const root = makeGitFixture({ "README.md": "# demo\n" });
  for (let index = 0; index < 45; index += 1) {
    const file = path.join(root, "src", `file-${index}.js`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `export const value${index} = ${index};\n`);
  }

  const compact = await filesChanged(root, { compact: true });
  const full = await filesChanged(root, { compact: false });

  assert.equal(compact.ok, true);
  assert.equal(compact.summary.totalFiles, 45);
  assert.equal(compact.summary.returnedFiles, 40);
  assert.equal(compact.summary.truncated, true);
  assert.equal(compact.files.length, 40);
  assert.ok(compact.suggestedNextActions.some((action) => action.command === "agentshell files changed"));
  assert.equal(full.summary.returnedFiles, 45);
  assert.equal(full.summary.truncated, false);
});

test("files changed returns clear error outside git repositories", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-files-changed-nonrepo-"));

  const result = await filesChanged(root, { compact: true });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "NOT_GIT_REPOSITORY");
  assert.match(result.error.message, /not inside a git repository/i);
});

test("files changed exposes a parseable JSON schema contract", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/files-changed.schema.json", "utf8"));

  assert.equal(schema.title, "AgentShell Files Changed Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.files-changed.v1");
  assert.ok(schema.oneOf[0].required.includes("summary"));
  assert.ok(schema.oneOf[0].required.includes("files"));
  assert.ok(schema.oneOf[0].properties.summary.required.includes("returnedFiles"));
  assert.ok(schema.oneOf[0].properties.summary.required.includes("truncated"));
  assert.ok(schema.$defs.file.required.includes("category"));
  assert.ok(schema.$defs.file.required.includes("risk"));
});

function makeGitFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-files-changed-"));
  git(root, ["init", "-b", "main"]);
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
