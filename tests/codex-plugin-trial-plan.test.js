import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { buildCodexPluginTrialPlan } from "../scripts/codex-plugin-trial-plan.js";

test("codex plugin trial plan builds run templates and suite manifest", () => {
  const plan = buildCodexPluginTrialPlan({
    name: "trial-plan",
    runs: 3,
    fixture: "examples/failing-test-demo",
    idPrefix: "fresh-thread",
    outDir: "artifacts/fresh-thread-plan"
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.protocolVersion, "agentshell.codex-plugin-trial-plan.v1");
  assert.equal(plan.runCount, 3);
  assert.equal(plan.runs[0].id, "fresh-thread-01");
  assert.equal(plan.suiteManifest.runs.length, 3);
  assert.equal(plan.suiteManifest.runs[0].path, "fresh-thread-01.json");
  assert.equal(plan.files.length, 7);
  assert.match(plan.files[0].content, /"host": "codex"/);
  assert.match(plan.markdown, /Codex Plugin Real-Run Plan/);
});

test("codex plugin trial plan CLI writes templates, manifest, markdown, and report", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-codex-plugin-plan-"));
  const outDir = path.join(tempRoot, "plan");
  const manifestPath = path.join(tempRoot, "suite.json");
  const markdownPath = path.join(tempRoot, "plan.md");
  const reportPath = path.join(tempRoot, "report.json");

  const result = spawnSync("node", [
    "scripts/codex-plugin-trial-plan.js",
    "--name",
    "cli-plan",
    "--runs",
    "2",
    "--id-prefix",
    "codex-check",
    "--out-dir",
    outDir,
    "--manifest",
    manifestPath,
    "--markdown",
    markdownPath,
    "--report",
    reportPath
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const stdout = JSON.parse(result.stdout);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const markdown = fs.readFileSync(markdownPath, "utf8");
  assert.deepEqual(report, stdout);
  assert.equal(report.protocolVersion, "agentshell.codex-plugin-trial-plan.v1");
  assert.equal(manifest.runs.length, 2);
  assert.match(markdown, /codex-check-01/);
  assert.equal(fs.existsSync(path.join(outDir, "codex-check-01.json")), true);
  assert.equal(fs.existsSync(path.join(outDir, "codex-check-01.md")), true);
  assert.equal(fs.existsSync(path.join(outDir, "suite.json")), true);
});

test("codex plugin trial plan generated manifest can be filled and scored by suite", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-codex-plugin-plan-score-"));
  const outDir = path.join(tempRoot, "plan");
  const result = spawnSync("node", [
    "scripts/codex-plugin-trial-plan.js",
    "--runs",
    "1",
    "--id-prefix",
    "filled",
    "--out-dir",
    outDir
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);

  const runPath = path.join(outDir, "filled-01.json");
  const runLog = JSON.parse(fs.readFileSync(runPath, "utf8"));
  runLog.events[0].stdout = "{\"ok\":true}";
  runLog.events[0].durationMs = 100;
  runLog.events[1].stdout = "{\"ok\":true,\"rollbackCommand\":\"agentshell undo op_filled\"}";
  runLog.events[1].durationMs = 200;
  runLog.events[2].stdout = "{\"ok\":true,\"rollbackCommand\":\"agentshell undo op_filled\"}";
  runLog.events[2].durationMs = 50;
  runLog.finalVerification.summary = "passed with rollback guidance";
  fs.writeFileSync(runPath, JSON.stringify(runLog, null, 2));

  const suite = spawnSync("node", [
    "scripts/codex-plugin-trial-suite.js",
    "--manifest",
    path.join(outDir, "suite.json")
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(suite.status, 0, suite.stderr);
  const suiteReport = JSON.parse(suite.stdout);
  assert.equal(suiteReport.protocolVersion, "agentshell.codex-plugin-trial-suite.v1");
  assert.equal(suiteReport.summary.strongRate, 100);
});

test("codex plugin trial plan schema and package script are exposed", () => {
  const schemaResult = spawnSync("node", ["src/cli.js", "schema", "get", "codex-plugin-trial-plan"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(schemaResult.status, 0, schemaResult.stderr);
  const schema = JSON.parse(schemaResult.stdout);
  assert.equal(schema.properties.protocolVersion.const, "agentshell.codex-plugin-trial-plan.v1");
  assert.equal(schema.properties.runCount.maximum, 10);

  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(packageJson.scripts?.["codex:plugin:plan"], "node scripts/codex-plugin-trial-plan.js");
});
