import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cli = path.resolve("src/cli.js");

test("verify stores logs by reference and history records the operation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-verify-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "verify-demo",
    type: "module",
    scripts: {
      test: "node test.js"
    }
  }, null, 2));
  fs.writeFileSync(path.join(dir, "test.js"), [
    "console.log('before failure')",
    "console.error('Expected useful error')",
    "process.exit(1)",
    ""
  ].join("\n"));

  const verify = run(dir, ["verify", "test"]);
  assert.equal(verify.status, 1);
  const verifyOutput = JSON.parse(verify.stdout);
  assert.equal(verifyOutput.ok, false);
  assert.equal(verifyOutput.protocolVersion, "agentshell.verify.v1");
  assert.match(verifyOutput.logRef, /^log_/);
  assert.equal(verifyOutput.summary.mainError, "Expected useful error");
  assert.equal(Object.hasOwn(verifyOutput, "logTail"), false);

  const verifyWithTail = run(dir, ["verify", "test", "--tail", "5"]);
  assert.equal(verifyWithTail.status, 1);
  const verifyWithTailOutput = JSON.parse(verifyWithTail.stdout);
  assert.match(verifyWithTailOutput.logTail, /Expected useful error/);

  const log = run(dir, ["log", "get", verifyOutput.logRef, "--tail", "10"]);
  assert.equal(log.status, 0);
  const logOutput = JSON.parse(log.stdout);
  assert.equal(logOutput.ok, true);
  assert.match(logOutput.combined, /Expected useful error/);

  const history = run(dir, ["history"]);
  assert.equal(history.status, 0);
  const historyOutput = JSON.parse(history.stdout);
  assert.ok(historyOutput.operations.some((operation) => (
    operation.type === "verify" && operation.logRef === verifyOutput.logRef
  )));

  const metrics = run(dir, ["metrics"]);
  assert.equal(metrics.status, 0);
  const metricsOutput = JSON.parse(metrics.stdout);
  assert.equal(metricsOutput.ok, true);
  assert.ok(metricsOutput.totals.agentShellOutputChars > 0);
  assert.ok(metricsOutput.totals.verifyRawOutputChars > 0);
  assert.ok(metricsOutput.byCommand.verify.count >= 2);

  const compactMetrics = run(dir, ["metrics", "--compact"]);
  assert.equal(compactMetrics.status, 0);
  const compactOutput = JSON.parse(compactMetrics.stdout);
  assert.equal(compactOutput.ok, true);
  assert.equal(compactOutput.compact, true);
  assert.equal(Object.hasOwn(compactOutput, "recentEvents"), false);
  assert.equal(Object.hasOwn(compactOutput, "byCommand"), false);
  assert.ok(compactOutput.topCommands.some((entry) => entry.command === "verify"));
  assert.ok(compactMetrics.stdout.length < metrics.stdout.length);
});

test("verify reuses cached identical failures and invalidates when related files change", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-verify-cache-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "verify-cache-demo",
    type: "module",
    scripts: {
      test: "node test.js"
    }
  }, null, 2));
  writeCachedFailureTest(dir, "Expected cached failure in test.js");

  const first = run(dir, ["verify", "test"]);
  assert.equal(first.status, 1, first.stderr || first.stdout);
  const firstOutput = JSON.parse(first.stdout);
  assert.equal(firstOutput.cacheHit, false);
  assert.match(firstOutput.cacheKey, /^sha256:/);
  assert.equal(readCount(dir), 1);

  const second = run(dir, ["verify", "test"]);
  assert.equal(second.status, 1);
  const secondOutput = JSON.parse(second.stdout);
  assert.equal(secondOutput.protocolVersion, "agentshell.verify.v1");
  assert.equal(secondOutput.cacheHit, true);
  assert.equal(secondOutput.cacheKey, firstOutput.cacheKey);
  assert.equal(secondOutput.logRef, firstOutput.logRef);
  assert.equal(readCount(dir), 1);

  writeCachedFailureTest(dir, "Expected changed failure in test.js");
  const third = run(dir, ["verify", "test"]);
  assert.equal(third.status, 1);
  const thirdOutput = JSON.parse(third.stdout);
  assert.equal(thirdOutput.cacheHit, false);
  assert.notEqual(thirdOutput.cacheKey, firstOutput.cacheKey);
  assert.equal(readCount(dir), 2);
});

test("verify uses a cached related test file before the full test command", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-verify-related-"));
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "verify-related-demo",
    type: "module",
    scripts: {
      test: "jest"
    }
  }, null, 2));
  writeFakeJest(dir);
  writeRelatedFailureTest(dir, "Expected first related failure");
  fs.writeFileSync(path.join(dir, "test", "other.test.js"), [
    "import fs from 'node:fs';",
    "fs.appendFileSync(new URL('../other-count.txt', import.meta.url), 'x');",
    ""
  ].join("\n"));

  const first = run(dir, ["verify", "test"]);
  assert.equal(first.status, 1, first.stderr || first.stdout);
  const firstOutput = JSON.parse(first.stdout);
  assert.equal(firstOutput.protocolVersion, "agentshell.verify.v1");
  assert.equal(firstOutput.command, "npm run test");
  assert.equal(firstOutput.cacheHit, false);
  assert.ok(firstOutput.relatedFiles.includes("test/related.test.js"), JSON.stringify(firstOutput, null, 2));
  const otherCountBeforeFocusedRun = readOtherCount(dir);

  writeRelatedFailureTest(dir, "Expected changed related failure");
  const second = run(dir, ["verify", "test"]);
  assert.equal(second.status, 1);
  const secondOutput = JSON.parse(second.stdout);
  assert.equal(secondOutput.verificationMode, "related-test-file");
  assert.equal(secondOutput.fullCommand, "npm run test");
  assert.equal(secondOutput.relatedTestFile, "test/related.test.js");
  assert.equal(secondOutput.relatedTestFileSource, "cache");
  assert.equal(secondOutput.command, "npm run test -- 'test/related.test.js'");
  assert.equal(readOtherCount(dir), otherCountBeforeFocusedRun);
});

function run(cwd, args) {
  return spawnSync("node", [cli, ...args], {
    cwd,
    encoding: "utf8"
  });
}

function writeCachedFailureTest(dir, message) {
  fs.writeFileSync(path.join(dir, "test.js"), [
    "import fs from 'node:fs';",
    "const countFile = new URL('./count.txt', import.meta.url);",
    "const current = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;",
    "fs.writeFileSync(countFile, String(current + 1));",
    `console.error(${JSON.stringify(message)});`,
    "process.exit(1);",
    ""
  ].join("\n"));
}

function readCount(dir) {
  return Number(fs.readFileSync(path.join(dir, "count.txt"), "utf8"));
}

function writeRelatedFailureTest(dir, message) {
  fs.writeFileSync(path.join(dir, "test", "related.test.js"), [
    "console.error(new URL(import.meta.url).pathname);",
    `console.error(${JSON.stringify(message)});`,
    "process.exit(1);",
    ""
  ].join("\n"));
}

function readOtherCount(dir) {
  if (!fs.existsSync(path.join(dir, "other-count.txt"))) return 0;
  return fs.readFileSync(path.join(dir, "other-count.txt"), "utf8").length;
}

function writeFakeJest(dir) {
  const file = path.join(dir, "node_modules", ".bin", "jest");
  fs.writeFileSync(file, [
    "#!/usr/bin/env node",
    "const { spawnSync } = require('node:child_process');",
    "const files = process.argv.slice(2);",
    "const targets = files.length ? files : ['test/related.test.js', 'test/other.test.js'];",
    "let failed = false;",
    "for (const target of targets) {",
    "  const result = spawnSync(process.execPath, [target], { stdio: 'inherit' });",
    "  if (result.status !== 0) failed = true;",
    "}",
    "process.exit(failed ? 1 : 0);",
    ""
  ].join("\n"));
  fs.chmodSync(file, 0o755);
}
