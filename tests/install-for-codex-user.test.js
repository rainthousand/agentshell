import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

test("friendly Codex installer exposes help", () => {
  const result = spawnSync("node", ["scripts/install-for-codex-user.js", "--help"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /npm run install:codex/);
  assert.match(result.stdout, /--channel stable\|beta/);
  assert.match(result.stdout, /never uploads usage data/);
  assert.match(result.stdout, /After success, open a new Codex thread/);
});

test("friendly Codex installer dry run reports the full install sequence", () => {
  const result = spawnSync("node", ["scripts/install-for-codex-user.js", "--dry-run", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.protocolVersion, "agentshell.codex-user-install.v1");
  assert.equal(output.ok, true);
  assert.equal(output.dryRun, true);
  assert.equal(output.channel, "stable");
  assert.equal(output.release.status, "would-resolve");
  assert.equal(output.privacy.dataUploaded, false);
  assert.deepEqual(output.steps.map((step) => step.name), [
    "node-version",
    "codex-version",
    "setup-codex",
    "agent-policy"
  ]);
  assert.ok(output.steps.every((step) => step.status === "dry-run"));
  assert.ok(output.steps.every((step) => !("durationMs" in step)));
});

test("friendly Codex installer dry run keeps human output clearly non-installing", () => {
  const result = spawnSync("node", ["scripts/install-for-codex-user.js", "--dry-run"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Preview only/);
  assert.match(result.stdout, /No files, downloads, links, or Codex settings were changed/);
  assert.match(result.stdout, /Run `npm run install:codex` without `--dry-run` to install/);
});

test("friendly Codex installer gives next steps when Codex CLI is missing", () => {
  const result = spawnSync(process.execPath, ["scripts/install-for-codex-user.js"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, PATH: "" }
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Install needs attention/);
  assert.match(result.stdout, /Failed command: codex --version/);
  assert.match(result.stdout, /Install or open Codex first/);
});

test("friendly Codex installer reports option errors without a stack trace", () => {
  const result = spawnSync("node", ["scripts/install-for-codex-user.js", "--wat"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Install option error: Unknown argument: --wat/);
  assert.doesNotMatch(result.stderr, /at parseArgs/);
});

test("package exposes friendly Codex installer", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(packageJson.scripts?.["install:codex"], "node scripts/install-for-codex-user.js");
  assert.equal(packageJson.scripts?.["install:agent-policy"], "node scripts/install-agent-policy.js");
  assert.equal(packageJson.scripts?.["update:codex"], "node scripts/install-for-codex-user.js --action update");
  assert.equal(packageJson.scripts?.["uninstall:codex"], "node scripts/install-for-codex-user.js --action uninstall");
  assert.equal(packageJson.scripts?.["doctor:codex"], "node scripts/plugin-lifecycle.js doctor");
});

test("friendly Codex lifecycle exposes update, uninstall, and doctor plans", () => {
  for (const action of ["update", "uninstall", "doctor"]) {
    const result = spawnSync("node", ["scripts/install-for-codex-user.js", "--action", action, "--dry-run", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.action, action);
    assert.ok(report.steps.some((step) => step.name === "setup-codex"));
  }
});

test("friendly Codex installer supports beta and explicit local source plans", () => {
  const beta = spawnSync("node", ["scripts/install-for-codex-user.js", "--channel", "beta", "--dry-run", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(beta.status, 0, beta.stderr);
  assert.equal(JSON.parse(beta.stdout).channel, "beta");

  const local = spawnSync("node", ["scripts/install-for-codex-user.js", "--source", ".", "--dry-run", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(local.status, 0, local.stderr);
  const report = JSON.parse(local.stdout);
  assert.equal(report.source.type, "local");
  assert.equal(report.release.status, "local-source");
});

test("friendly Codex installer rejects invalid release channels", () => {
  const result = spawnSync("node", ["scripts/install-for-codex-user.js", "--channel", "nightly", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.match(report.error, /stable or beta/);
  assert.equal(report.privacy.dataUploaded, false);
});
