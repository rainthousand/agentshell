import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cli = path.resolve("src/cli.js");

test("benchmark compares raw test output with compact verify output", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-benchmark-"));
  fs.mkdirSync(path.join(dir, "test"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "benchmark-demo",
    type: "module",
    scripts: {
      test: "node test/noisy.js"
    }
  }, null, 2));
  fs.writeFileSync(path.join(dir, "test", "noisy.js"), [
    "for (let i = 0; i < 80; i += 1) console.log(`noise ${i}`)",
    "console.error('Expected benchmark failure')",
    "process.exit(1)",
    ""
  ].join("\n"));

  const result = spawnSync("node", [cli, "benchmark", "test"], {
    cwd: dir,
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.protocolVersion, "agentshell.benchmark.v1");
  assert.equal(output.raw.exitCode, 1);
  assert.equal(output.agentshell.exitCode, 1);
  assert.ok(output.raw.chars > output.agentshell.chars);
  assert.ok(output.reduction.percentSaved > 0);
  assert.match(output.agentshell.logRef, /^log_/);

  const runStatus = spawnSync("node", [cli, "run", "status"], {
    cwd: dir,
    encoding: "utf8"
  });
  assert.equal(runStatus.status, 0);
  const statusOutput = JSON.parse(runStatus.stdout);
  assert.equal(statusOutput.protocolVersion, "agentshell.run-status.v1");
  assert.equal(statusOutput.run, null);
  assert.equal(statusOutput.summary, null);
});
