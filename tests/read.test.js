import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  readFileAround,
  readFileHead,
  readFileRange,
  readFileTail
} from "../src/commands/read.js";

test("read preserves range and around behavior with safety metadata", async () => {
  const root = makeFixture("sample.txt", "alpha\nbeta\ngamma\ndelta\n");

  const range = await readFileRange(root, "sample.txt", "2:3");
  const around = await readFileAround(root, "sample.txt", "gamma");

  assert.equal(range.ok, true);
  assert.equal(range.mode, "lines");
  assert.equal(range.bounded, false);
  assert.deepEqual(range.range, { start: 2, end: 3 });
  assert.match(range.content, /2 \| beta/);
  assert.equal(around.ok, true);
  assert.equal(around.mode, "around");
  assert.equal(around.matchedLine, 3);
});

test("read head and tail return bounded numbered lines", async () => {
  const root = makeFixture("sample.txt", "one\ntwo\nthree\nfour");

  const head = await readFileHead(root, "sample.txt", 2);
  const tail = await readFileTail(root, "sample.txt", 2);

  assert.equal(head.ok, true);
  assert.equal(head.mode, "head");
  assert.equal(head.bounded, true);
  assert.deepEqual(head.range, { start: 1, end: 2 });
  assert.equal(head.content, "1 | one\n2 | two");
  assert.equal(tail.ok, true);
  assert.equal(tail.mode, "tail");
  assert.deepEqual(tail.range, { start: 3, end: 4 });
  assert.equal(tail.content, "3 | three\n4 | four");
});

test("read rejects invalid head and tail counts", async () => {
  const root = makeFixture("sample.txt", "one\ntwo\n");

  const zero = await readFileHead(root, "sample.txt", 0);
  const excessive = await readFileTail(root, "sample.txt", 201);

  assert.equal(zero.ok, false);
  assert.equal(zero.error.code, "INVALID_RANGE");
  assert.equal(excessive.ok, false);
  assert.equal(excessive.error.code, "INVALID_RANGE");
});

test("large files require bounded head or tail reads", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-read-"));
  const file = path.join(root, "large.log");
  const fd = fs.openSync(file, "w");
  try {
    const chunk = Buffer.from(`${"x".repeat(1023)}\n`);
    for (let index = 0; index < 9000; index += 1) fs.writeSync(fd, chunk);
  } finally {
    fs.closeSync(fd);
  }

  const range = await readFileRange(root, "large.log", "1:2");
  const head = await readFileHead(root, "large.log", 2);
  const tail = await readFileTail(root, "large.log", 2);

  assert.equal(range.ok, false);
  assert.equal(range.error.code, "FILE_TOO_LARGE");
  assert.equal(head.ok, true);
  assert.equal(head.truncated.value, true);
  assert.equal(head.totalLines, null);
  assert.equal(tail.ok, true);
  assert.equal(tail.truncated.value, true);
  assert.match(tail.content, /9000 \|/);
});

test("bounded reads retain the whole-file hash beyond the byte window", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-read-"));
  const original = `${"prefix\n".repeat(90000)}first tail\n`;
  const changed = `${"prefix\n".repeat(90000)}second tail\n`;
  fs.writeFileSync(path.join(root, "large-enough.log"), original);
  const first = await readFileHead(root, "large-enough.log", 2);
  fs.writeFileSync(path.join(root, "large-enough.log"), changed);
  const second = await readFileHead(root, "large-enough.log", 2);

  assert.equal(first.content, second.content);
  assert.notEqual(first.hash, second.hash);
});

test("read schema exposes bounded read metadata", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/read.schema.json", "utf8"));
  const success = schema.oneOf[0];

  assert.equal(success.properties.protocolVersion.const, "agentshell.read.v1");
  assert.ok(success.required.includes("mode"));
  assert.ok(success.required.includes("truncated"));
  assert.deepEqual(success.properties.mode.enum, ["lines", "around", "head", "tail"]);
});

function makeFixture(name, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-read-"));
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return root;
}
