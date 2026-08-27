import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { logDelta, parseLogDeltaOptions } from "../src/commands/log-delta.js";
import { readIncrementalBytes } from "../src/core/incremental-log.js";

test("log delta reads only bytes appended after the persisted cursor", async () => {
  const root = fixture("service.log", "server ready on :3000\nold harmless line\n");

  const first = await logDelta(root, "service.log", { compact: true });
  assert.equal(first.ok, true);
  assert.equal(first.protocolVersion, "agentshell.log-delta.v1");
  assert.equal(first.cursor.previousOffset, 0);
  assert.ok(first.statusChanges.some((entry) => entry.kind === "ready"));

  fs.appendFileSync(path.join(root, "service.log"), "Error: database unavailable\n    at connect (src/db.js:8:2)\nretrying in 1s\n");
  const second = await logDelta(root, "service.log", { compact: true });

  assert.equal(second.cursor.previousOffset, first.cursor.nextOffset);
  assert.equal(second.summary.newBytes, Buffer.byteLength("Error: database unavailable\n    at connect (src/db.js:8:2)\nretrying in 1s\n"));
  assert.ok(second.errors.some((entry) => entry.message.includes("database unavailable") && entry.file === "src/db.js"));
  assert.ok(second.statusChanges.some((entry) => entry.kind === "retrying"));
  assert.equal(JSON.stringify(second).includes("old harmless line"), false);

  const idle = await logDelta(root, "service.log", { compact: true });
  assert.equal(idle.summary.noChanges, true);
  assert.equal(idle.summary.newBytes, 0);
  assert.deepEqual(idle.errors, []);
  assert.deepEqual(idle.statusChanges, []);
});

test("log delta detects copy-truncation and resumes at byte zero", async () => {
  const root = fixture("watch.log", `${"previous output\n".repeat(20)}server ready\n`);
  const first = await logDelta(root, "watch.log", {});
  assert.ok(first.cursor.nextOffset > 100);

  fs.writeFileSync(path.join(root, "watch.log"), "fatal: watcher failed\n");
  const result = await logDelta(root, "watch.log", {});

  assert.equal(result.cursor.resetReason, "truncation");
  assert.equal(result.cursor.previousOffset, 0);
  assert.ok(result.statusChanges.some((entry) => entry.kind === "failed"));
});

test("log delta detects rotation by file identity", async () => {
  const root = fixture("container.log", "container healthy\n");
  await logDelta(root, "container.log", {});

  fs.renameSync(path.join(root, "container.log"), path.join(root, "container.log.1"));
  fs.writeFileSync(path.join(root, "container.log"), "container restarted and ready\n");
  const result = await logDelta(root, "container.log", {});

  assert.equal(result.cursor.resetReason, "rotation");
  assert.equal(result.cursor.previousOffset, 0);
  assert.ok(result.statusChanges.some((entry) => entry.kind === "ready"));
});

test("incremental reader strictly caps bytes and advances without rereading", () => {
  const root = fixture("large.log", "abcdefghijklmnopqrstuvwxyz");
  const file = path.join(root, "large.log");

  const first = readIncrementalBytes(root, file, { maxBytes: 10 });
  const second = readIncrementalBytes(root, file, { maxBytes: 10, cursor: first.cursor });
  const third = readIncrementalBytes(root, file, { maxBytes: 10, cursor: second.cursor });

  assert.equal(first.buffer.toString(), "abcdefghij");
  assert.equal(first.capped, true);
  assert.equal(first.moreAvailable, true);
  assert.equal(second.buffer.toString(), "klmnopqrst");
  assert.equal(second.previousOffset, 10);
  assert.equal(third.buffer.toString(), "uvwxyz");
  assert.equal(third.nextOffset, 26);
  assert.equal(third.moreAvailable, false);
});

test("incremental reader preserves UTF-8 characters split at a byte cap", () => {
  const root = fixture("unicode.log", "ab你c");
  const file = path.join(root, "unicode.log");

  const first = readIncrementalBytes(root, file, { maxBytes: 4 });
  const second = readIncrementalBytes(root, file, { maxBytes: 4, cursor: first.cursor });

  assert.equal(first.buffer.toString("utf8"), "ab");
  assert.equal(first.nextOffset, 2);
  assert.equal(second.buffer.toString("utf8"), "你c");
  assert.equal(second.nextOffset, Buffer.byteLength("ab你c"));
  assert.equal(`${first.buffer.toString("utf8")}${second.buffer.toString("utf8")}`, "ab你c");
});

test("consumer-scoped cursors do not let one agent consume another agent's bytes", () => {
  const root = fixture("agents.log", "first\nsecond\n");
  const file = path.join(root, "agents.log");

  const alpha = readIncrementalBytes(root, file, { maxBytes: 6, consumerId: "agent-alpha" });
  const beta = readIncrementalBytes(root, file, { maxBytes: 6, consumerId: "agent-beta" });
  const alphaNext = readIncrementalBytes(root, file, { maxBytes: 7, consumerId: "agent-alpha" });

  assert.equal(alpha.buffer.toString(), "first\n");
  assert.equal(beta.buffer.toString(), "first\n");
  assert.equal(alphaNext.buffer.toString(), "second\n");
  assert.notEqual(alpha.cursorId, beta.cursorId);
});

test("stateless reads advance only when the caller returns the explicit cursor", () => {
  const root = fixture("explicit.log", "abcdefghijkl");
  const file = path.join(root, "explicit.log");

  const first = readIncrementalBytes(root, file, { maxBytes: 4 });
  const repeated = readIncrementalBytes(root, file, { maxBytes: 4 });
  const next = readIncrementalBytes(root, file, { maxBytes: 4, cursor: first.cursor });

  assert.equal(first.buffer.toString(), "abcd");
  assert.equal(repeated.buffer.toString(), "abcd");
  assert.equal(next.buffer.toString(), "efgh");
  assert.equal(next.previousOffset, 4);
});

test("concurrent processes serialize updates for one consumer cursor", async () => {
  const root = fixture("parallel.log", "abcdefghijklmnopqrst");
  const file = path.join(root, "parallel.log");
  const moduleUrl = new URL("../src/core/incremental-log.js", import.meta.url).href;
  const source = `import { readIncrementalBytes } from ${JSON.stringify(moduleUrl)}; const value = readIncrementalBytes(process.argv[1], process.argv[2], { maxBytes: 5, consumerId: "shared-agent" }); process.stdout.write(value.buffer.toString("utf8"));`;

  const chunks = await Promise.all(Array.from({ length: 4 }, () => runNode(source, [root, file])));

  assert.deepEqual(chunks.sort(), ["abcde", "fghij", "klmno", "pqrst"]);
});

test("cursor keys and persisted records do not leak source paths or contents", async () => {
  const root = fixture("private/customer-secret.log", "Error: private payload\n");
  const result = await logDelta(root, "private/customer-secret.log", {});
  const directory = path.join(root, ".agentshell", "log-cursors");
  const files = fs.readdirSync(directory);
  const stored = fs.readFileSync(path.join(directory, files[0]), "utf8");

  assert.match(result.cursor.id, /^log_[0-9a-f]{24}$/);
  assert.match(files[0], /^log_[0-9a-f]{24}\.json$/);
  assert.equal(stored.includes(root), false);
  assert.equal(stored.includes("customer-secret.log"), false);
  assert.equal(stored.includes("private payload"), false);
  assert.deepEqual(Object.keys(JSON.parse(stored)).sort(), ["id", "identity", "offset", "updatedAt", "version"]);
});

test("log delta reset removes cursor and next read starts over", async () => {
  const root = fixture("test.log", "tests completed successfully\n");
  const first = await logDelta(root, "test.log", {});
  const reset = await logDelta(root, "test.log", { reset: true });
  const reread = await logDelta(root, "test.log", {});

  assert.equal(reset.action, "reset");
  assert.equal(reset.cursor.id, first.cursor.id);
  assert.equal(reset.cursor.wasPresent, true);
  assert.equal(reread.cursor.previousOffset, 0);
  assert.equal(reread.summary.newBytes, first.summary.newBytes);
});

test("log delta recovers a corrupt local cursor", async () => {
  const root = fixture("dev.log", "server started\n");
  const first = await logDelta(root, "dev.log", {});
  const cursorFile = path.join(root, ".agentshell", "log-cursors", `${first.cursor.id}.json`);
  fs.writeFileSync(cursorFile, "{broken");

  const recovered = await logDelta(root, "dev.log", {});
  assert.equal(recovered.cursor.recovered, true);
  assert.equal(recovered.cursor.previousOffset, 0);
  assert.equal(recovered.summary.newBytes, Buffer.byteLength("server started\n"));
});

test("log delta rejects unsafe paths, non-files, and invalid limits", async () => {
  const root = fixture("valid.log", "ok\n");
  fs.mkdirSync(path.join(root, "logs"));
  const outside = path.join(os.tmpdir(), `agentshell-outside-${process.pid}.log`);
  fs.writeFileSync(outside, "secret\n");
  fs.symlinkSync(outside, path.join(root, "outside.log"));

  assert.equal((await logDelta(root, "missing.log", {})).error.code, "FILE_NOT_FOUND");
  assert.equal((await logDelta(root, "logs", {})).error.code, "NOT_A_FILE");
  assert.equal((await logDelta(root, "../outside.log", {})).error.code, "FILE_OUTSIDE_WORKSPACE");
  assert.equal((await logDelta(root, "outside.log", {})).error.code, "FILE_OUTSIDE_WORKSPACE");
  assert.equal(parseLogDeltaOptions("valid.log", { maxBytes: 0 }).error.code, "INVALID_ARGUMENT");
  assert.equal(parseLogDeltaOptions(undefined, {}).error.code, "INVALID_ARGUMENT");
  fs.rmSync(outside, { force: true });
});

test("status summaries are bounded, deduplicated, and avoid false failed status", async () => {
  const lines = ["0 tests failed", ...Array.from({ length: 30 }, (_, index) => `worker ${index} restarting`)];
  const root = fixture("status.log", `${lines.join("\n")}\n`);
  const result = await logDelta(root, "status.log", {});

  assert.equal(result.statusChanges.length, 16);
  assert.equal(result.statusChanges.some((entry) => entry.kind === "failed"), false);
  assert.ok(result.statusChanges.every((entry) => entry.message.length <= 180));
});

test("log delta schema and documentation expose the stable bounded contract", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/log-delta.schema.json", "utf8"));
  const docs = fs.readFileSync("docs/incremental-log.md", "utf8");

  assert.equal(schema.title, "AgentShell Incremental Log Delta Response");
  assert.equal(schema.$defs.readResult.properties.protocolVersion.const, "agentshell.log-delta.v1");
  assert.equal(schema.$defs.source.properties.maxBytes.maximum, 1048576);
  assert.equal(schema.$defs.readResult.properties.errors.maxItems, 12);
  assert.equal(schema.$defs.readResult.properties.statusChanges.maxItems, 16);
  assert.match(docs, /do not persist the workspace path, log path/);
  assert.match(docs, /rotation/);
  assert.match(docs, /truncation/);
});

function fixture(name, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-log-delta-"));
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return root;
}

function runNode(source, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source, ...args], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `child exited ${code}`)));
  });
}
