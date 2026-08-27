import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  appendRunCommandStats,
  appendRunNode,
  createRun,
  readActiveRun
} from "../src/core/store.js";
import { operationIdsForRun, operationIdsForVerification } from "../src/core/attribution.js";

const cli = path.resolve("src/cli.js");

test("run attribution keeps real operation ids in stable first-seen order", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-attribution-store-"));
  const created = createRun(root, { type: "diagnose", ok: true, operationId: "op_verify_initial" });

  appendRunNode(root, created.id, { type: "change", ok: true, operationId: "op_change" });
  appendRunNode(root, created.id, { type: "verify", ok: true, operationId: "op_verify_initial" });
  appendRunCommandStats(root, created.id, {
    command: "fix",
    args: [],
    ok: true,
    outputChars: 10,
    estimatedTokens: 3,
    operationIds: ["op_verify_final", "op_change", "", null]
  });

  assert.deepEqual(readActiveRun(root).operationIds, [
    "op_verify_initial",
    "op_change",
    "op_verify_final"
  ]);
});

test("run attribution derives ids from operation-bearing records, not stale metadata", () => {
  assert.deepEqual(operationIdsForRun({
    operationIds: ["op_not_backed_by_a_record"],
    nodes: [{ type: "verify", operationId: "op_real" }],
    commandStats: [{ operationIds: ["op_real", "op_second"] }]
  }), ["op_real", "op_second"]);
});

test("related and full verification ids preserve execution order without inventing ids", () => {
  assert.deepEqual(operationIdsForVerification({
    operationId: "op_full",
    relatedTestFileVerification: { operationId: "op_related" }
  }), ["op_related", "op_full"]);
  assert.deepEqual(operationIdsForVerification({ operationId: "op_full" }), ["op_full"]);
  assert.deepEqual(operationIdsForVerification({}), []);
});

test("compact fix attributes both executed verifications and exposes the run chain", () => {
  const root = createFixProject();
  const fixed = run(root, ["fix", "test", "--fast", "--compact"]);
  assert.equal(fixed.status, 0, fixed.stderr);
  const output = JSON.parse(fixed.stdout);
  const initialVerificationId = output.operationIds[0];
  const finalVerificationId = output.operationIds.at(-1);

  assert.match(initialVerificationId, /^op_/);
  assert.match(finalVerificationId, /^op_/);
  assert.notEqual(initialVerificationId, finalVerificationId);
  assert.deepEqual(output.operationIds, [initialVerificationId, finalVerificationId]);

  const operations = readJsonLines(path.join(root, ".agentshell", "history.jsonl"));
  const verifyIds = operations.filter((operation) => operation.type === "verify").map((operation) => operation.id);
  assert.deepEqual(verifyIds, [initialVerificationId, finalVerificationId]);

  const events = readJsonLines(path.join(root, ".agentshell", "events.jsonl"));
  const fixEvent = events.findLast((event) => event.command === "fix");
  assert.deepEqual(fixEvent.operationIds, [initialVerificationId, finalVerificationId]);

  const status = run(root, ["run", "status", "--compact"]);
  assert.equal(status.status, 0, status.stderr);
  const summary = JSON.parse(status.stdout).summary;
  assert.deepEqual(summary.verificationOperationIds, [initialVerificationId, finalVerificationId]);
  assert.equal(summary.diagnosis.operationId, initialVerificationId);
  assert.equal(summary.latestVerify.operationId, finalVerificationId);
  assert.ok(summary.operationIds.includes(summary.latestChange.operationId));
});

test("failed compact fix still attributes its executed diagnosis verification", () => {
  const root = createUnsupportedFixProject();
  const fixed = run(root, ["fix", "test", "--fast", "--compact"]);
  assert.equal(fixed.status, 1);
  const output = JSON.parse(fixed.stdout);
  const operationId = output.diagnosis.verification.operationId;

  assert.match(operationId, /^op_/);
  const fixEvent = readJsonLines(path.join(root, ".agentshell", "events.jsonl"))
    .findLast((event) => event.command === "fix");
  assert.deepEqual(fixEvent.operationIds, [operationId]);
  assert.equal(readJsonLines(path.join(root, ".agentshell", "history.jsonl"))[0].id, operationId);
});

function createFixProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-attribution-fix-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "attribution-fix",
    type: "module",
    scripts: { test: "node test/user.test.js" }
  }, null, 2));
  fs.writeFileSync(path.join(root, "src", "user.js"), [
    "export function createUser(input) {",
    "  return {",
    "    name: input.name,",
    "    email: input.email",
    "  };",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(root, "test", "user.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { createUser } from '../src/user.js';",
    "const user = createUser({ name: 'Ada', email: 'ada@example.com' });",
    "assert.ok(user.id, 'Expected user.id to be present');",
    ""
  ].join("\n"));
  return root;
}

function createUnsupportedFixProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-attribution-unsupported-"));
  fs.writeFileSync(path.join(root, "go.mod"), "module example.com/attribution\n\ngo 1.22\n");
  fs.writeFileSync(path.join(root, "value.go"), "package attribution\n\nfunc Value() int { return 1 }\n");
  fs.writeFileSync(path.join(root, "value_test.go"), [
    "package attribution",
    "import \"testing\"",
    "func TestValue(t *testing.T) {",
    "  if Value() != 2 { t.Fatalf(\"expected 2, got %d\", Value()) }",
    "}",
    ""
  ].join("\n"));
  return root;
}

function run(cwd, args) {
  return spawnSync("node", [cli, ...args], { cwd, encoding: "utf8" });
}

function readJsonLines(file) {
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}
