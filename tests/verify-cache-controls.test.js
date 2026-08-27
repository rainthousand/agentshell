import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verify } from "../src/commands/verify.js";

test("failure cache invalidates when an untracked relevant input is added", async () => {
  const root = fixture();

  const first = await verify(root, "test", { run: false });
  assert.equal(first.ok, false);
  assert.equal(first.cacheHit, false);
  assert.equal(first.cacheStored, true);
  assert.match(first.cacheCreatedAt, /^\d{4}-/);
  assert.match(first.cacheInputDigest, /^sha256:/);
  assert.equal(first.cacheInputFileCount, 3);
  assert.equal(first.cacheReason, "no-compatible-entry");

  const second = await verify(root, "test", { run: false });
  assert.equal(second.cacheHit, true);
  assert.equal(second.cacheReason, "inputs-unchanged");
  assert.equal(executionCount(root), 1);

  fs.writeFileSync(path.join(root, "new-feature.test.js"), "throw new Error('new test input');\n");
  const third = await verify(root, "test", { run: false });
  assert.equal(third.cacheHit, false);
  assert.equal(third.cacheReason, "inputs-changed");
  assert.equal(executionCount(root), 2);
});

test("noCache bypasses reads and writes while preserving the existing entry", async () => {
  const root = fixture();
  await verify(root, "test", { run: false });

  const fresh = await verify(root, "test", { run: false, noCache: true });
  assert.equal(fresh.cacheHit, false);
  assert.equal(fresh.cacheStored, false);
  assert.equal(fresh.cacheReason, "disabled-by-option");
  assert.match(fresh.cacheInputDigest, /^sha256:/);
  assert.equal(executionCount(root), 2);

  const cached = await verify(root, "test", { run: false });
  assert.equal(cached.cacheHit, true);
  assert.equal(executionCount(root), 2);
});

test("cache explain and clear are scoped management actions", async () => {
  const root = fixture();
  await verify(root, "test", { run: false });
  const lintFailure = await verify(root, "lint", { run: false });
  assert.equal(lintFailure.cacheStored, true);

  const explained = await verify(root, "test", { cacheAction: "explain" });
  assert.equal(explained.ok, true);
  assert.equal(explained.protocolVersion, "agentshell.verify-cache.v1");
  assert.equal(explained.action, "explain");
  assert.equal(explained.cacheHit, true);
  assert.match(explained.cacheInputDigest, /^sha256:/);
  assert.match(explained.cacheCreatedAt, /^\d{4}-/);
  assert.equal(explained.cacheInputFileCount, 3);

  const cleared = await verify(root, "test", { cacheAction: "clear" });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.action, "clear");
  assert.equal(cleared.removedEntries, 1);
  assert.equal(cleared.remainingEntries, 1);
  assert.equal(cleared.cacheFile, ".agentshell/test-result-cache.json");

  const afterClear = await verify(root, "test", { run: false });
  assert.equal(afterClear.cacheHit, false);
  assert.equal(executionCount(root), 2);

  const lintAfterClear = await verify(root, "lint", { run: false });
  assert.equal(lintAfterClear.cacheHit, true);
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-cache-controls-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "cache-controls",
    type: "module",
    scripts: {
      test: "node test.js",
      lint: "node lint.js"
    }
  }, null, 2));
  fs.writeFileSync(path.join(root, "test.js"), [
    "import fs from 'node:fs';",
    "const file = new URL('./execution-count.txt', import.meta.url);",
    "const count = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;",
    "fs.writeFileSync(file, String(count + 1));",
    "console.error(new URL(import.meta.url).pathname);",
    "console.error('Expected cached failure');",
    "process.exit(1);",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(root, "lint.js"), [
    "console.error(new URL(import.meta.url).pathname);",
    "console.error('Expected cached lint failure');",
    "process.exit(1);",
    ""
  ].join("\n"));
  return root;
}

function executionCount(root) {
  return Number(fs.readFileSync(path.join(root, "execution-count.txt"), "utf8"));
}
