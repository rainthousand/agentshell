import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { pwd, workingDirectory } from "../src/commands/pwd.js";

test("pwd reports project and git roots from a nested working directory", async () => {
  const root = initRepo();
  const nested = path.join(root, "src", "commands");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");

  const result = await pwd(nested, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.pwd.v1");
  assert.equal(result.compact, true);
  assert.equal(result.summary.cwd, nested);
  assert.equal(result.summary.insideGitRepository, true);
  assert.equal(result.summary.atGitRoot, false);
  assert.equal(result.summary.atProjectRoot, false);
  assert.equal(result.summary.manifest, "package.json");
  assert.deepEqual(result.git, { root, relation: "descendant", relativePath: "src/commands" });
  assert.deepEqual(result.project, { root, manifest: "package.json", relation: "descendant", relativePath: "src/commands" });
});

test("pwd marks a project root and handles directories without manifests or git", async () => {
  const projectRoot = initRepo();
  fs.writeFileSync(path.join(projectRoot, "go.mod"), "module example.com/demo\n");
  const atRoot = await workingDirectory(projectRoot, { compact: true });

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-pwd-plain-"));
  const outside = await pwd(plain, { compact: true });

  assert.equal(atRoot.summary.atGitRoot, true);
  assert.equal(atRoot.summary.atProjectRoot, true);
  assert.equal(atRoot.summary.manifest, "go.mod");
  assert.equal(atRoot.git.relation, "root");
  assert.equal(atRoot.project.relation, "root");
  assert.equal(outside.summary.insideGitRepository, false);
  assert.equal(outside.git, null);
  assert.equal(outside.project, null);
  assert.ok(outside.suggestedNextActions.some((action) => action.command === "agentshell ls --compact"));
});

test("pwd schema exposes git and project relations", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/pwd.schema.json", "utf8"));
  assert.equal(schema.title, "AgentShell Working Directory Response");
  assert.equal(schema.properties.protocolVersion.const, "agentshell.pwd.v1");
  assert.deepEqual(schema.$defs.location.properties.relation.enum, ["root", "descendant"]);
  assert.ok(schema.required.includes("suggestedNextActions"));
});

function initRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-pwd-"));
  const result = spawnSync("git", ["init", "-b", "main"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return root;
}
