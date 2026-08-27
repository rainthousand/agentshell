import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readBatch, parseBatchTarget } from "../src/commands/read-batch.js";
import {
  MAX_BATCH_CONTENT_CHARS,
  MAX_BATCH_TARGETS,
  MAX_BATCH_WORK_BYTES,
  MAX_TARGET_CONTENT_CHARS
} from "../src/core/batch-read.js";

test("target parser supports strings and structured objects", () => {
  assert.deepEqual(parseBatchTarget("src/a.js:2:8").target, {
    file: "src/a.js", mode: "lines", value: "2:8"
  });
  assert.deepEqual(parseBatchTarget("src/a.js@around=needle").target, {
    file: "src/a.js", mode: "around", value: "needle"
  });
  assert.deepEqual(parseBatchTarget("src/a.js@head=12").target, {
    file: "src/a.js", mode: "head", value: 12
  });
  assert.deepEqual(parseBatchTarget({ file: "src/a.js", tail: 9 }).target, {
    file: "src/a.js", mode: "tail", value: 9
  });
});

test("batch read preserves order and reports partial failures", async () => {
  const root = fixture();
  const result = await readBatch(root, [
    "a.txt:2:3",
    "missing.txt@head=2",
    { file: "b.txt", around: "green" },
    "not-a-target"
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.results.map((item) => item.index), [0, 1, 2, 3]);
  assert.deepEqual(result.summary, {
    requested: 4,
    succeeded: 2,
    failed: 2,
    contentChars: result.results[0].content.length + result.results[2].content.length,
    contentLimitChars: MAX_BATCH_CONTENT_CHARS,
    workBytes: result.results[0].workBytes + result.results[2].workBytes,
    workBudgetBytes: 3 * 512 * 1024,
    workLimitBytes: MAX_BATCH_WORK_BYTES,
    truncatedResults: 0
  });
  assert.match(result.results[0].content, /2 \| two/);
  assert.equal(result.results[1].error.code, "FILE_NOT_FOUND");
  assert.equal(result.results[2].matchedLine, 2);
  assert.equal(result.results[3].error.code, "INVALID_ARGUMENT");
});

test("batch read reuses traversal, symlink, hash, and large-file protections", async () => {
  const root = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-batch-outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
  fs.writeFileSync(path.join(root, "large.log"), `${"x".repeat(1023)}\n`.repeat(9000));

  const result = await readBatch(root, [
    "../secret.txt@head=1",
    `${path.join(outside, "secret.txt")}@head=1`,
    "link.txt@head=1",
    "large.log:1:2",
    "large.log@head=2"
  ]);

  assert.equal(result.status, "partial");
  assert.equal(result.results[0].error.code, "FILE_OUTSIDE_WORKSPACE");
  assert.equal(result.results[1].error.code, "INVALID_ARGUMENT");
  assert.equal(result.results[2].error.code, "FILE_OUTSIDE_WORKSPACE");
  assert.equal(result.results[3].error.code, "FILE_TOO_LARGE");
  assert.equal(result.results[4].ok, true);
  assert.match(result.results[4].hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.results[4].truncated.value, true);
});

test("request and content budgets are strict", async () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, "wide.txt"), `${"z".repeat(1000)}\n`.repeat(100));

  const empty = await readBatch(root, []);
  const excessive = await readBatch(root, Array.from({ length: MAX_BATCH_TARGETS + 1 }, () => "a.txt@head=1"));
  const result = await readBatch(root, Array.from({ length: 6 }, () => "wide.txt@head=20"));

  assert.equal(empty.ok, false);
  assert.equal(excessive.ok, false);
  assert.equal(result.summary.contentChars, MAX_BATCH_CONTENT_CHARS);
  assert.ok(result.results.every((item) => item.content.length <= MAX_TARGET_CONTENT_CHARS));
  assert.equal(result.results.at(-1).content.length, 0);
  assert.equal(result.results.at(-1).truncated.value, true);
});

test("twenty oversized reads share a strict total work budget", async () => {
  const root = fixture();
  const large = path.join(root, "large.log");
  fs.writeFileSync(large, `${"x".repeat(1023)}\n`.repeat(9000));

  const result = await readBatch(root, Array.from({ length: 20 }, () => "large.log@head=2"));

  assert.equal(result.ok, true);
  assert.equal(result.status, "complete");
  assert.equal(result.summary.workBytes, MAX_BATCH_WORK_BYTES);
  assert.equal(result.summary.workBudgetBytes, MAX_BATCH_WORK_BYTES);
  assert.equal(result.summary.workLimitBytes, MAX_BATCH_WORK_BYTES);
  assert.ok(result.results.every((item) => item.hashScope === "window"));
  assert.ok(result.results.every((item) => item.workBytes <= 512 * 1024));
  assert.equal(result.results.reduce((total, item) => total + item.workBytes, 0), MAX_BATCH_WORK_BYTES);
});

test("all item failures produce a completed failed status", async () => {
  const root = fixture();
  const result = await readBatch(root, ["missing.txt@tail=2", "bad"]);

  assert.equal(result.ok, true);
  assert.equal(result.status, "failed");
  assert.equal(result.summary.succeeded, 0);
  assert.equal(result.summary.failed, 2);
});

test("schema describes bounded ordered batch results", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/read-batch.schema.json", "utf8"));
  const success = schema.oneOf[0];
  assert.equal(success.properties.protocolVersion.const, "agentshell.read-batch.v1");
  assert.equal(success.properties.results.maxItems, MAX_BATCH_TARGETS);
  assert.equal(success.properties.summary.properties.contentChars.maximum, MAX_BATCH_CONTENT_CHARS);
  assert.equal(success.properties.summary.properties.workBytes.maximum, MAX_BATCH_WORK_BYTES);
  assert.equal(success.properties.summary.properties.workBudgetBytes.maximum, MAX_BATCH_WORK_BYTES);
  assert.equal(schema.$defs.result.oneOf[0].properties.content.maxLength, MAX_TARGET_CONTENT_CHARS);
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-batch-read-"));
  fs.writeFileSync(path.join(root, "a.txt"), "one\ntwo\nthree\nfour\n");
  fs.writeFileSync(path.join(root, "b.txt"), "red\ngreen\nblue\n");
  return root;
}
