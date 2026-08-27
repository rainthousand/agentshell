import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { jobCommand, parseJobArgs } from "../src/commands/job.js";
import { JOB_PROTOCOL_VERSION } from "../src/core/job-manager.js";

test("job command parser requires an explicit argv separator", () => {
  const missing = parseJobArgs("start", ["node", "script.js"]);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "INVALID_ARGUMENT");
  assert.equal(missing.error.details.shellInterpolation, false);

  const parsed = parseJobArgs("start", ["--timeout-ms", "5000", "--", "node", "script.js", "value with spaces"]);
  assert.deepEqual(parsed, {
    ok: true,
    value: {
      argv: ["node", "script.js", "value with spaces"],
      options: { timeoutMs: 5000 }
    }
  });
});

test("job command parser handles status, delta, cancel, and invalid options", () => {
  assert.deepEqual(parseJobArgs("status", ["job-12345678", "--compact"]), { ok: true, value: { jobId: "job-12345678" } });
  assert.deepEqual(parseJobArgs("cancel", ["job-12345678"]), { ok: true, value: { jobId: "job-12345678" } });
  assert.deepEqual(parseJobArgs("delta", ["job-12345678", "--cursor", "abc", "--max-bytes", "4096"]), {
    ok: true,
    value: { jobId: "job-12345678", cursor: "abc", options: { maxBytes: 4096 } }
  });
  assert.equal(parseJobArgs("start", ["--shell", "bash", "--", "echo"]).ok, false);
  assert.equal(parseJobArgs("unknown", []).ok, false);
});

test("job command exposes the four lifecycle actions without public CLI wiring", async (t) => {
  const base = fs.mkdtempSync("/tmp/as-job-command-");
  const root = `${base}/workspace`;
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const started = await jobCommand(root, "start", ["--timeout-ms", "15000", "--", process.execPath, "-e", "console.log('command-ok')"]);
  assert.equal(started.ok, true);
  assert.equal(started.protocolVersion, JOB_PROTOCOL_VERSION);
  const jobId = started.job.jobId;

  let status;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    status = await jobCommand(root, "status", [jobId]);
    if (status.ok && ["completed", "failed"].includes(status.job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (status?.job?.status === "running") await jobCommand(root, "cancel", [jobId]);
  assert.equal(status.ok, true);
  assert.equal(status.job.status, "completed");

  const delta = await jobCommand(root, "delta", [jobId]);
  assert.equal(delta.ok, true);
  assert.match(delta.output.stdout, /command-ok/u);
  const empty = await jobCommand(root, "delta", [jobId, "--cursor", delta.cursor]);
  assert.equal(empty.bytesRead, 0);
  const cancelled = await jobCommand(root, "cancel", [jobId]);
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.cancelled, false);
});

test("job schema fixes protocol version and lifecycle states", () => {
  const schema = JSON.parse(fs.readFileSync(new URL("../schemas/job.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.$defs.base.properties.protocolVersion.const, JOB_PROTOCOL_VERSION);
  assert.equal(schema.$defs.base.properties.schemaVersion.const, 1);
  assert.deepEqual(schema.$defs.base.properties.action.enum, ["start", "status", "delta", "cancel"]);
  assert.equal(schema.$defs.job.properties.status.enum.includes("timed_out"), true);
});

test("separate public CLI processes never report short-lived jobs as lost", async (t) => {
  const base = fs.mkdtempSync("/tmp/as-job-cli-race-");
  const root = `${base}/workspace`;
  fs.mkdirSync(root);
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const cli = path.join(packageRoot, "src", "cli.js");
  const env = { ...process.env, AGENTSHELL_PACKAGE_ROOT: packageRoot };
  const jobIds = [];
  t.after(() => {
    for (const jobId of jobIds) runCli(cli, root, env, ["job", "cancel", jobId]);
    fs.rmSync(base, { recursive: true, force: true });
  });

  for (let iteration = 0; iteration < 6; iteration += 1) {
    const started = runCli(cli, root, env, [
      "job", "start", "--timeout-ms", "15000", "--",
      process.execPath, "-e", `console.log('ready-${iteration}')`
    ]);
    assert.equal(started.ok, true);
    const jobId = started.job.jobId;
    jobIds.push(jobId);
    let terminal = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const status = runCli(cli, root, env, ["job", "status", jobId]);
      assert.notEqual(status.job?.status, "lost", `iteration ${iteration} reported lost on poll ${attempt}`);
      if (["completed", "failed", "cancelled", "timed_out"].includes(status.job?.status)) {
        terminal = status;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(terminal?.job?.status, "completed");
    assert.equal(terminal.job.exitCode, 0);
  }
});

function runCli(cli, cwd, env, args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 10_000,
    shell: false,
    windowsHide: true
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
