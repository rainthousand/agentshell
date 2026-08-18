import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { fileInfo, parseFileInfoOptions, summarizeCode } from "../src/commands/file-info.js";

test("file info summarizes tracked JavaScript files without returning source", async () => {
  const dir = initRepo();
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "sample.js"), [
    "import fs from \"node:fs\";",
    "import \"./side-effect.js\";",
    "export function run() { return fs.existsSync(\".\"); }",
    "const hidden = 1;",
    "export { hidden as exposed };"
  ].join("\n"));
  commitFile(dir, "src/sample.js", "add sample js");

  const result = await fileInfo(dir, "src/sample.js", { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.file-info.v1");
  assert.equal(result.compact, true);
  assert.equal(result.path, "src/sample.js");
  assert.equal(result.exists, true);
  assert.equal(result.extension, ".js");
  assert.equal(result.language, "javascript");
  assert.equal(result.lineCount, 5);
  assert.equal(result.binary, false);
  assert.equal(result.generated, false);
  assert.match(result.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.git.tracked, true);
  assert.match(result.git.lastCommit.shortHash, /^[0-9a-f]{7,12}$/);
  assert.equal(result.git.lastCommit.subject, "add sample js");
  assert.ok(result.code.symbols.some((symbol) => symbol.kind === "function" && symbol.name === "run"));
  assert.deepEqual(result.code.exports, ["run", "exposed"]);
  assert.equal(result.code.importCount, 2);
  assert.ok(!JSON.stringify(result).includes("existsSync"));
});

test("file info summarizes TypeScript and Go symbols", async () => {
  const dir = initRepo();
  fs.writeFileSync(path.join(dir, "thing.ts"), [
    "import type { Readable } from \"node:stream\";",
    "export interface Thing { name: string }",
    "export const makeThing = (): Thing => ({ name: \"ok\" });",
    "export { makeThing as createThing };"
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "main.go"), [
    "package demo",
    "import (",
    "  \"fmt\"",
    "  \"strings\"",
    ")",
    "type Runner struct{}",
    "func Run() { fmt.Println(strings.TrimSpace(\" ok \")) }",
    "func helper() {}"
  ].join("\n"));

  const ts = await fileInfo(dir, "thing.ts", { compact: true });
  const go = await fileInfo(dir, "main.go", { compact: true });

  assert.equal(ts.language, "typescript");
  assert.ok(ts.code.symbols.some((symbol) => symbol.kind === "type" && symbol.name === "Thing"));
  assert.ok(ts.code.symbols.some((symbol) => symbol.kind === "variable" && symbol.name === "makeThing"));
  assert.deepEqual(ts.code.exports, ["Thing", "makeThing", "createThing"]);
  assert.equal(ts.code.importCount, 1);

  assert.equal(go.language, "go");
  assert.ok(go.code.symbols.some((symbol) => symbol.kind === "type" && symbol.name === "Runner"));
  assert.ok(go.code.symbols.some((symbol) => symbol.kind === "function" && symbol.name === "Run"));
  assert.deepEqual(go.code.exports, ["Run", "Runner"]);
  assert.equal(go.code.importCount, 2);
});

test("file info flags binary and generated files", async () => {
  const dir = initRepo();
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "logo.bin"), Buffer.from([0, 1, 2, 3, 255]));
  fs.writeFileSync(path.join(dir, "dist", "bundle.min.js"), "export const bundled = true;\n");

  const binary = await fileInfo(dir, "logo.bin", { compact: true });
  const generated = await fileInfo(dir, "dist/bundle.min.js", { compact: true });

  assert.equal(binary.binary, true);
  assert.equal(binary.generated, false);
  assert.equal(binary.lineCount, null);
  assert.equal(binary.code, null);
  assert.equal(generated.binary, false);
  assert.equal(generated.generated, true);
  assert.equal(generated.code, null);
});

test("file info reports missing arg, outside root, and missing path errors", async () => {
  const dir = initRepo();

  const missingArg = parseFileInfoOptions(undefined, { compact: true });
  const outsideRoot = await fileInfo(dir, "../outside.js", { compact: true });
  const missingPath = await fileInfo(dir, "missing.js", { compact: true });

  assert.equal(missingArg.ok, false);
  assert.equal(missingArg.error.code, "INVALID_ARGUMENT");
  assert.equal(outsideRoot.ok, false);
  assert.equal(outsideRoot.error.code, "FILE_OUTSIDE_WORKSPACE");
  assert.equal(missingPath.ok, false);
  assert.equal(missingPath.error.code, "FILE_NOT_FOUND");
  assert.deepEqual(missingPath.error.details, { path: "missing.js", exists: false });
});

test("file info schema exposes the compact response contract", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/file-info.schema.json", "utf8"));

  assert.equal(schema.title, "AgentShell File Info Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.file-info.v1");
  assert.ok(schema.oneOf[0].required.includes("hash"));
  assert.ok(schema.oneOf[0].required.includes("git"));
  assert.deepEqual(schema.$defs.lastCommit.required, ["shortHash", "subject", "relativeAge"]);
  assert.deepEqual(schema.$defs.codeSummary.required, ["symbols", "exports", "importCount"]);
});

test("summarizeCode returns null for unsupported or generated text", () => {
  assert.equal(summarizeCode("hello\n", "markdown"), null);
  assert.equal(summarizeCode("export const value = 1;\n", "javascript", true), null);
});

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-file-info-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "agent@example.com"]);
  git(dir, ["config", "user.name", "AgentShell Test"]);
  return dir;
}

function commitFile(cwd, fileName, message) {
  git(cwd, ["add", fileName]);
  git(cwd, ["commit", "-m", message]);
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result;
}
