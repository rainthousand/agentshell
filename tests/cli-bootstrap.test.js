import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

function run(...args) {
  return spawnSync(process.execPath, ["src/cli.js", ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

test("lightweight bootstrap preserves version, help, and manual contracts", () => {
  const version = run("--version");
  const help = run("--help");
  const manual = run("manual");

  assert.equal(version.status, 0, version.stderr);
  assert.equal(help.status, 0, help.stderr);
  assert.equal(manual.status, 0, manual.stderr);
  assert.equal(JSON.parse(version.stdout).protocolVersion, "agentshell.version.v1");
  assert.ok(JSON.parse(help.stdout).commands.includes("agentshell start [--compact] [--profile]"));
  assert.equal(JSON.parse(manual.stdout).protocolVersion, "agentshell.manual.v1");
});

test("bootstrap defers the full runtime and still dispatches project commands", () => {
  const source = fs.readFileSync("src/cli.js", "utf8");
  const pwd = run("pwd", "--compact");

  assert.match(source, /await import\("\.\/cli-runtime\.js"\)/);
  assert.doesNotMatch(source, /^import .*cli-runtime/m);
  assert.equal(pwd.status, 0, pwd.stderr);
  assert.equal(JSON.parse(pwd.stdout).protocolVersion, "agentshell.pwd.v1");
});
