import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { buildCodexPluginTrialTemplate } from "../scripts/codex-plugin-trial-template.js";

test("codex plugin trial template builds a fillable Codex run log", () => {
  const report = buildCodexPluginTrialTemplate({
    id: "pm-codex-run",
    fixture: "examples/failing-test-demo"
  });

  assert.equal(report.ok, true);
  assert.equal(report.protocolVersion, "agentshell.codex-plugin-trial-template.v1");
  assert.equal(report.jsonTemplate.id, "pm-codex-run");
  assert.equal(report.jsonTemplate.host, "codex");
  assert.equal(report.jsonTemplate.events.length, 3);
  assert.ok(report.jsonTemplate.events.some((event) => event.command === "agentshell fix test --fast --compact"));
  assert.match(report.markdown, /^# Codex Plugin Real-Run Capture Form/m);
  assert.match(report.markdown, /npm run codex:plugin:collect/);
});

test("codex plugin trial template CLI writes report, JSON, and Markdown", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-codex-plugin-template-"));
  const reportPath = path.join(tempRoot, "template-report.json");
  const jsonPath = path.join(tempRoot, "run-log.json");
  const markdownPath = path.join(tempRoot, "run-log.md");

  const result = spawnSync("node", [
    "scripts/codex-plugin-trial-template.js",
    "--id",
    "codex-template-cli",
    "--fixture",
    "examples/failing-test-demo",
    "--report",
    reportPath,
    "--json",
    jsonPath,
    "--markdown",
    markdownPath
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const stdout = JSON.parse(result.stdout);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const runLog = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const markdown = fs.readFileSync(markdownPath, "utf8");
  assert.deepEqual(report, stdout);
  assert.equal(runLog.id, "codex-template-cli");
  assert.equal(runLog.host, "codex");
  assert.match(markdown, /Fresh Thread Checklist/);
});

test("codex plugin trial template JSON can be scored after filling placeholders", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-codex-plugin-template-score-"));
  const jsonPath = path.join(tempRoot, "run-log.json");
  const template = buildCodexPluginTrialTemplate({ id: "filled-template" }).jsonTemplate;
  template.events[0].stdout = "{\"ok\":true}";
  template.events[0].durationMs = 100;
  template.events[1].stdout = "{\"ok\":true,\"rollbackCommand\":\"agentshell undo op_123\"}";
  template.events[1].durationMs = 200;
  template.events[2].stdout = "{\"ok\":true,\"rollbackCommand\":\"agentshell undo op_123\"}";
  template.events[2].durationMs = 50;
  template.finalVerification.summary = "passed with rollback guidance";
  fs.writeFileSync(jsonPath, JSON.stringify(template, null, 2));

  const result = spawnSync("node", [
    "scripts/codex-plugin-trial-collect.js",
    "--input",
    jsonPath
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.byInterpretation.strong, 1);
});

test("codex plugin trial template schema and package script are exposed", () => {
  const schemaResult = spawnSync("node", ["src/cli.js", "schema", "get", "codex-plugin-trial-template"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(schemaResult.status, 0, schemaResult.stderr);
  const schema = JSON.parse(schemaResult.stdout);
  assert.equal(schema.protocolVersion, "agentshell.schema-get.v1");
  assert.equal(schema.properties.protocolVersion.const, "agentshell.codex-plugin-trial-template.v1");
  assert.equal(schema.$defs.runLogTemplate.properties.host.const, "codex");

  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(packageJson.scripts?.["codex:plugin:template"], "node scripts/codex-plugin-trial-template.js");
});
