import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cli = path.join(process.cwd(), "src", "cli.js");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-doctor-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runDoctor(cwd) {
  const result = spawnSync("node", [cli, "doctor"], {
    cwd,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function checkByName(output, name) {
  const check = output.checks.find((entry) => entry.name === name);
  assert.ok(check, `missing doctor check: ${name}`);
  return check;
}

test("doctor reports a workspace without package.json or git metadata", () => {
  withTempDir((dir) => {
    const realDir = fs.realpathSync(dir);
    const output = runDoctor(dir);

    assert.equal(output.ok, true);
    assert.equal(output.protocolVersion, "agentshell.doctor.v1");
    assert.equal(output.status, "warning");
    assert.equal(output.workspace.root, realDir);
    assert.equal(output.workspace.name, path.basename(dir));
    assert.equal(output.package.found, false);
    assert.equal(output.package.manager, null);
    assert.deepEqual(output.package.scripts, {
      test: null,
      build: null,
      lint: null
    });
    assert.equal(output.git.available, false);
    assert.equal(output.state.writable, true);
    assert.equal(output.state.fallbackUsed, false);
    assert.deepEqual(output.activeRun, {
      present: false,
      runId: null,
      status: null,
      updatedAt: null,
      commandCount: 0,
      nodeCount: 0,
      nextBestAction: null,
      rollbackCommand: null,
      error: null
    });

    assert.deepEqual(
      {
        packageJson: checkByName(output, "package-json").ok,
        testScript: checkByName(output, "test-script").ok,
        activeRun: checkByName(output, "active-run").ok,
        git: checkByName(output, "git").ok,
        stateDir: checkByName(output, "state-dir").ok
      },
      {
        packageJson: false,
        testScript: false,
        activeRun: true,
        git: false,
        stateDir: true
      }
    );
    assert.match(checkByName(output, "package-json").message, /No package\.json found/);
    assert.match(checkByName(output, "test-script").message, /No npm-style test script found/);
    assert.match(checkByName(output, "active-run").message, /No active AgentShell run/);
    assert.match(checkByName(output, "git").message, /Git metadata is not available/);
    assert.ok(output.suggestedNextActions.some((action) => action.command === "agentshell understand"));
  });
});

test("doctor reports package metadata when no test script is configured", () => {
  withTempDir((dir) => {
    const realDir = fs.realpathSync(dir);
    fs.writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "doctor-no-test", scripts: { build: "node build.js" } }, null, 2)}\n`
    );

    const output = runDoctor(dir);

    assert.equal(output.status, "warning");
    assert.equal(output.workspace.root, realDir);
    assert.equal(output.workspace.name, "doctor-no-test");
    assert.equal(output.package.found, true);
    assert.equal(output.package.manager, "npm");
    assert.deepEqual(output.package.scripts, {
      test: null,
      build: "node build.js",
      lint: null
    });
    assert.equal(checkByName(output, "package-json").ok, true);
    assert.equal(checkByName(output, "test-script").ok, false);
    assert.match(checkByName(output, "test-script").message, /No npm-style test script found/);
    assert.equal(output.git.available, false);
    assert.ok(output.suggestedNextActions.some((action) => action.command === "agentshell understand"));
    assert.ok(!output.suggestedNextActions.some((action) => action.command === "agentshell verify test"));
  });
});

test("doctor reports configured test scripts and unavailable git independently", () => {
  withTempDir((dir) => {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "doctor-with-test", scripts: { test: "node --test" } }, null, 2)}\n`
    );

    const output = runDoctor(dir);

    assert.equal(output.status, "warning");
    assert.equal(output.package.found, true);
    assert.equal(output.package.scripts.test, "node --test");
    assert.equal(output.git.available, false);
    assert.equal(checkByName(output, "test-script").ok, true);
    assert.match(checkByName(output, "test-script").message, /npm run test/);
    assert.ok(output.suggestedNextActions.some((action) => action.command === "agentshell verify test"));
  });
});

test("doctor reports state fallback without requiring chmod setup", () => {
  withTempDir((dir) => {
    const realDir = fs.realpathSync(dir);
    fs.writeFileSync(path.join(dir, ".agentshell"), "not a directory\n");

    const output = runDoctor(dir);

    assert.equal(output.state.writable, true);
    assert.equal(output.state.preferredPath, path.join(realDir, ".agentshell"));
    assert.equal(output.state.fallbackUsed, true);
    assert.notEqual(path.resolve(output.state.path), path.resolve(output.state.preferredPath));
    assert.equal(checkByName(output, "state-dir").ok, true);
    assert.match(checkByName(output, "state-dir").message, /AgentShell state is writable/);
    assert.ok(
      output.suggestedNextActions.some(
        (action) =>
          action.command === "agentshell doctor" &&
          action.reason.includes("Make the workspace .agentshell directory writable")
      )
    );
  });
});

test("doctor reports active run status and suggests status or clear", () => {
  withTempDir((dir) => {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "doctor-active-run", scripts: { test: "node --test" } }, null, 2)}\n`
    );
    fs.mkdirSync(path.join(dir, ".agentshell"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".agentshell", "active-run.json"),
      `${JSON.stringify({
        id: "run_doctor_active",
        status: "failing",
        startedAt: "2026-07-08T00:00:00.000Z",
        updatedAt: "2026-07-08T00:01:00.000Z",
        nodes: [
          {
            type: "diagnose",
            ok: true,
            verificationOk: false,
            logRef: "log_doctor",
            fixPlan: {
              confidence: "medium",
              target: null,
              nextCommand: null
            },
            createdAt: "2026-07-08T00:00:10.000Z"
          }
        ],
        commandStats: [
          {
            command: "node",
            args: ["--test"],
            ok: false,
            outputChars: 120,
            estimatedTokens: 30,
            createdAt: "2026-07-08T00:00:20.000Z"
          }
        ]
      }, null, 2)}\n`
    );

    const output = runDoctor(dir);

    assert.equal(output.activeRun.present, true);
    assert.equal(output.activeRun.runId, "run_doctor_active");
    assert.equal(output.activeRun.status, "failing");
    assert.equal(output.activeRun.updatedAt, "2026-07-08T00:01:00.000Z");
    assert.equal(output.activeRun.commandCount, 1);
    assert.equal(output.activeRun.nodeCount, 1);
    assert.equal(output.activeRun.nextBestAction, "agentshell diagnose test --compact");
    assert.equal(output.activeRun.rollbackCommand, null);
    assert.equal(output.activeRun.error, null);
    assert.match(checkByName(output, "active-run").message, /Active AgentShell run run_doctor_active is failing/);
    assert.ok(output.suggestedNextActions.some((action) => action.command === "agentshell run status --compact"));
    assert.ok(output.suggestedNextActions.some((action) => action.command === "agentshell run clear"));
  });
});
