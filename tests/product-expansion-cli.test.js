import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cli = path.resolve("src/cli.js");

test("generic exec is available through the public CLI", () => {
  const root = tempProject();
  const run = invoke(root, ["exec", "--compact", "--", process.execPath, "-e", "console.log('ready')"]);

  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.exec.v1");
  assert.equal(result.summary.status, "passed");
  assert.match(result.summary.preview, /ready/);

  const invalid = invoke(root, ["exec", "--compact"]);
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stdout).error.code, "INVALID_ARGUMENT");
});

test("log delta CLI returns only newly appended output", () => {
  const root = tempProject();
  fs.writeFileSync(path.join(root, "service.log"), "service ready\n");

  const first = JSON.parse(invoke(root, ["log", "delta", "service.log", "--compact"]).stdout);
  fs.appendFileSync(path.join(root, "service.log"), "Error: backend unavailable\n");
  const secondRun = invoke(root, ["log", "delta", "service.log", "--compact"]);

  assert.equal(secondRun.status, 0, secondRun.stderr);
  const second = JSON.parse(secondRun.stdout);
  assert.equal(second.cursor.previousOffset, first.cursor.nextOffset);
  assert.equal(second.summary.newBytes, Buffer.byteLength("Error: backend unavailable\n"));
  assert.equal(JSON.stringify(second).includes("service ready"), false);
});

test("coverage ingest CLI accepts a privacy-safe adapter batch", () => {
  const root = tempProject();
  const input = path.join(root, "observations.json");
  fs.writeFileSync(input, JSON.stringify({
    protocolVersion: "agentshell.adapter-command-observation.v1",
    source: "codex",
    observations: [{ eventId: "private-event-id", argv: ["rg", "secret-query", "/private/repo"] }]
  }));

  const run = invoke(root, ["coverage", "ingest", "--input", input]);

  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.recorded, 1);
  const stored = fs.readFileSync(path.join(root, ".agentshell", "command-observations.jsonl"), "utf8");
  assert.doesNotMatch(stored, /private-event-id|secret-query|private\/repo/);
});

test("coverage candidates ranks repeated unsupported command families", () => {
  const root = tempProject();
  const input = path.join(root, "observations.json");
  fs.writeFileSync(input, JSON.stringify({
    protocolVersion: "agentshell.adapter-command-observation.v1",
    source: "codex",
    observations: [
      { eventId: "one", argv: ["kubectl", "get", "pods"] },
      { eventId: "two", argv: ["kubectl", "logs", "api"] }
    ]
  }));
  assert.equal(invoke(root, ["coverage", "ingest", "--input", input]).status, 0);

  const run = invoke(root, ["coverage", "candidates", "--limit", "5"]);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.protocolVersion, "agentshell.adaptive-coverage.v1");
  assert.equal(result.candidates[0].executableFamily, "kubectl");
  assert.equal(JSON.stringify(result).includes("pods"), false);
  assert.equal(JSON.stringify(result).includes("api"), false);
});

test("runtime CLI starts, serves cached metadata, and stops in an isolated directory", () => {
  const root = tempProject();
  const runtimeDir = `/tmp/agentshell-runtime-${process.pid}-${Date.now()}`;
  const flags = ["--runtime-dir", runtimeDir];
  try {
    const started = invoke(root, ["runtime", "start", ...flags]);
    assert.equal(started.status, 0, started.stderr);
    assert.equal(JSON.parse(started.stdout).running, true);

    const first = JSON.parse(invoke(root, ["runtime", "request", ...flags]).stdout);
    const second = JSON.parse(invoke(root, ["runtime", "request", ...flags]).stdout);
    assert.equal(first.source, "daemon");
    assert.equal(first.cache.hit, false);
    assert.equal(second.cache.hit, true);
  } finally {
    invoke(root, ["runtime", "stop", ...flags]);
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

function invoke(root, args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
}

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-expansion-cli-"));
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture","type":"module"}\n');
  return root;
}
