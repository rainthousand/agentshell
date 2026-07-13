import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cli = path.resolve("src/cli.js");

test("diagnose test returns compact failure context and implementation reads", () => {
  const dir = createDiagnoseProject();

  const result = spawnSync("node", [cli, "diagnose", "test"], {
    cwd: dir,
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.diagnose.v1");
  assert.equal(output.status, "failed");
  assert.equal(output.verificationOk, false);
  assert.equal(output.verification.protocolVersion, "agentshell.verify.v1");
  assert.ok(output.verification.relatedFiles.includes("test/user.test.js"));
  assert.equal(output.fixPlan.confidence, "medium");
  assert.equal(output.fixPlan.target.file, "src/user.js");
  assert.deepEqual(output.fixPlan.target.range, { start: 2, end: 2 });
  assert.match(output.fixPlan.target.expectedHash, /^sha256:/);
  assert.match(output.fixPlan.target.intent, /`id`/);
  assert.equal(output.changeTemplate.replacementRequired, true);
  assert.match(output.changeTemplate.path, /\.agentshell\/change-templates\/change_/);
  const template = JSON.parse(fs.readFileSync(path.join(dir, output.changeTemplate.path), "utf8"));
  assert.equal(template.edits[0].file, "src/user.js");
  assert.equal(template.edits[0].expectedHash, output.fixPlan.target.expectedHash);
  assert.equal(template.edits[0].replacement, "");
  assert.ok(output.focusedReads.some((read) => read.file === "test/user.test.js"));
  assert.ok(output.symbols.includes("createUser"));
  assert.ok(output.implementationReads.some((read) => read.file === "src/user.js"));
  assert.match(output.implementationReads.find((read) => read.file === "src/user.js").content, /createUser/);
});

test("diagnose test --compact omits focused and implementation content", () => {
  const dir = createDiagnoseProject();

  const result = spawnSync("node", [cli, "diagnose", "test", "--compact"], {
    cwd: dir,
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.diagnose.v1");
  assert.equal(output.compact, true);
  assert.equal(output.focusedReads[0].file, "test/user.test.js");
  assert.equal(output.focusedReads[0].content, undefined);
  assert.equal(output.fixPlan.target.file, "src/user.js");
  assert.equal(output.fixPlan.nextCommand, "agentshell change <change.json>");
  assert.ok(output.changeTemplate.path);
  assert.equal(output.changeTemplate.nextCommand, undefined);
  assert.deepEqual(output.symbols, []);
  assert.deepEqual(output.symbolMatches, []);
  assert.match(output.focusedReads[0].hash, /^sha256:/);
  assert.equal(output.implementationReads[0].file, "src/user.js");
  assert.equal(output.implementationReads[0].content, undefined);
  assert.match(output.implementationReads[0].hash, /^sha256:/);
  assert.deepEqual(output.implementationReads[0].range, { start: 1, end: 4 });

  const cached = spawnSync("node", [cli, "diagnose", "test", "--compact"], {
    cwd: dir,
    encoding: "utf8"
  });
  assert.equal(cached.status, 0);
  const cachedOutput = JSON.parse(cached.stdout);
  assert.equal(cachedOutput.verification.cacheHit, true);
  assert.equal(cachedOutput.verification.cacheKey, output.verification.cacheKey);
});

test("diagnose test --compact --profile reports phase timing", () => {
  const dir = createDiagnoseProject();

  const result = spawnSync("node", [cli, "diagnose", "test", "--compact", "--profile"], {
    cwd: dir,
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.diagnose.v1");
  assert.equal(output.profile.totalMs >= 0, true);
  assert.equal(typeof output.profile.subprocessMs, "number");
  const phaseNames = output.profile.phases.map((phase) => phase.name);
  assert.ok(phaseNames.includes("verify-test"));
  assert.ok(phaseNames.includes("focused-reads"));
  assert.ok(phaseNames.includes("fix-plan"));
  assert.equal(phaseNames.includes("symbol-search"), false);
});

test("diagnose test skips generic reads when deterministic TypeScript fix plan is available", () => {
  const dir = createTypeScriptDiagnoseProject();

  const result = spawnSync("node", [cli, "diagnose", "test", "--compact", "--profile"], {
    cwd: dir,
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.fixPlan.target.file, "src/user.ts");
  assert.deepEqual(output.focusedReads, []);
  assert.deepEqual(output.implementationReads, []);
  const phaseNames = output.profile.phases.map((phase) => phase.name);
  assert.ok(phaseNames.includes("deterministic-fix-plan"));
  assert.equal(phaseNames.includes("focused-reads"), false);
  assert.equal(phaseNames.includes("symbol-search"), false);
  assert.equal(phaseNames.includes("fix-plan"), false);
});

test("diagnose test prefers local imports from related tests for implementation reads", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-diagnose-imports-"));
  fs.mkdirSync(path.join(dir, "source"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.mkdirSync(path.join(dir, "examples"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "diagnose-imports-demo",
    type: "module",
    scripts: {
      test: "node test/chalk.test.js"
    }
  }, null, 2));
  fs.writeFileSync(path.join(dir, "source", "index.js"), [
    "export default function chalk(...strings) {",
    "  return strings.join('');",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "test", "chalk.test.js"), [
    "import assert from 'node:assert/strict';",
    "import chalk from '../source/index.js';",
    "assert.equal(chalk('hello', 'there'), 'hello there');",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "examples", "rainbow.js"), [
    "export function test() {",
    "  return 'example';",
    "}",
    ""
  ].join("\n"));

  const result = spawnSync("node", [cli, "diagnose", "test", "--compact"], {
    cwd: dir,
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.fixPlan.target.file, "source/index.js");
  assert.equal(output.implementationReads[0].file, "source/index.js");
});

function createDiagnoseProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-diagnose-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "diagnose-demo",
    type: "module",
    scripts: {
      test: "node test/user.test.js"
    }
  }, null, 2));
  fs.writeFileSync(path.join(dir, "src", "user.js"), [
    "export function createUser(input) {",
    "  return { name: input.name, email: input.email };",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "test", "user.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { createUser } from '../src/user.js';",
    "",
    "const user = createUser({ name: 'Ada', email: 'ada@example.com' });",
    "assert.ok(user.id, 'Expected user.id to be present');",
    ""
  ].join("\n"));
  return dir;
}

function createTypeScriptDiagnoseProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-diagnose-ts-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "diagnose-ts-demo",
    type: "module",
    scripts: {
      test: "node test/typecheck.cjs"
    }
  }, null, 2));
  fs.writeFileSync(path.join(dir, "src", "user.ts"), [
    "interface User {",
    "  id: string;",
    "  name: string;",
    "}",
    "",
    "const user: User = {",
    "  name: \"Ada\"",
    "};",
    "",
    "console.log(user);",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "test", "typecheck.cjs"), [
    "console.error(\"src/user.ts(6,7): error TS2741: Property 'id' is missing in type '{ name: string; }' but required in type 'User'.\");",
    "process.exit(1);",
    ""
  ].join("\n"));
  return dir;
}
