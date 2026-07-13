import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { runAdapterTrialSuite } from "../scripts/adapter-trial-suite.js";

test("adapter trial suite aggregates trial and collector inputs", () => {
  const report = runAdapterTrialSuite({
    name: "unit-suite",
    trials: [
      {
        id: "strong",
        kind: "trial",
        input: {
          host: "codex",
          commands: [
            "agentshell start --compact",
            "agentshell fix test --fast --compact",
            "agentshell verify test",
            "agentshell run status --compact"
          ],
          finalVerification: {
            ok: true,
            command: "agentshell verify test",
            summary: "passed with rollback guidance"
          }
        }
      },
      {
        id: "weak",
        kind: "collect",
        input: {
          host: "claude",
          commands: [
            { command: "npm test", stdout: "raw logs", durationMs: 100 },
            { command: "cat test/user.test.js", stdout: "file", durationMs: 10 },
            { command: "agentshell diagnose test --compact", stdout: "diagnosis", durationMs: 50 }
          ]
        }
      }
    ]
  });

  assert.equal(report.ok, true);
  assert.equal(report.protocolVersion, "agentshell.adapter-trial-suite.v1");
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.byInterpretation.strong, 1);
  assert.equal(report.summary.byInterpretation.weak, 1);
  assert.equal(report.summary.byHost.codex.total, 1);
  assert.equal(report.summary.byHost.claude.total, 1);
  assert.equal(report.summary.totalNoisyRawCommands, 2);
});

test("adapter trial suite CLI writes JSON and Markdown reports", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-adapter-trial-suite-"));
  const manifestPath = path.join(tempRoot, "suite.json");
  const reportPath = path.join(tempRoot, "report.json");
  const markdownPath = path.join(tempRoot, "report.md");
  fs.writeFileSync(manifestPath, JSON.stringify({
    name: "cli-suite",
    trials: [
      {
        id: "codex",
        kind: "trial",
        input: {
          host: "codex",
          commands: [
            "agentshell start --compact",
            "agentshell fix test --fast --compact",
            "agentshell verify test",
            "agentshell run status --compact"
          ],
          finalVerification: {
            ok: true,
            command: "agentshell verify test",
            summary: "passed with rollback guidance"
          }
        }
      }
    ]
  }, null, 2));

  const result = spawnSync("node", [
    "scripts/adapter-trial-suite.js",
    "--manifest",
    manifestPath,
    "--report",
    reportPath,
    "--markdown",
    markdownPath
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const stdout = JSON.parse(result.stdout);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const markdown = fs.readFileSync(markdownPath, "utf8");
  assert.deepEqual(report, stdout);
  assert.equal(report.summary.total, 1);
  assert.match(markdown, /^# AgentShell Adapter Trial Suite/m);
  assert.match(markdown, /Average score: 100\/100/);
});

test("adapter trial suite sample aggregates strong and weak runs", () => {
  const result = spawnSync("node", [
    "scripts/adapter-trial-suite.js",
    "--manifest",
    "examples/adapter-trial-suite.sample.json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.total, 3);
  assert.equal(report.summary.byInterpretation.strong, 2);
  assert.equal(report.summary.byInterpretation.weak, 1);
  assert.equal(report.summary.byHost.codex.total, 2);
  assert.equal(report.summary.byHost.claude.total, 1);
});

test("adapter trial suite schema and package script are exposed", () => {
  const schemaResult = spawnSync("node", ["src/cli.js", "schema", "get", "adapter-trial-suite"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(schemaResult.status, 0, schemaResult.stderr);
  const schema = JSON.parse(schemaResult.stdout);
  assert.equal(schema.protocolVersion, "agentshell.schema-get.v1");
  assert.equal(schema.properties.protocolVersion.const, "agentshell.adapter-trial-suite.v1");

  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(packageJson.scripts["adapter:trial:suite"], "node scripts/adapter-trial-suite.js");
});

test("adapter trial suite resolves paths from the manifest directory", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-adapter-trial-suite-path-"));
  const trialPath = path.join(tempRoot, "trial.json");
  const manifestPath = path.join(tempRoot, "nested", "suite.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(trialPath, JSON.stringify({
    host: "codex",
    commands: [
      "agentshell start --compact",
      "agentshell fix test --fast --compact",
      "agentshell verify test",
      "agentshell run status --compact"
    ],
    finalVerification: {
      ok: true,
      command: "agentshell verify test",
      summary: "passed with rollback guidance"
    }
  }, null, 2));
  fs.writeFileSync(manifestPath, JSON.stringify({
    name: "path-suite",
    trials: [
      {
        id: "relative-parent",
        path: "../trial.json"
      }
    ]
  }, null, 2));

  const result = spawnSync("node", [
    "scripts/adapter-trial-suite.js",
    "--manifest",
    manifestPath
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.total, 1);
  assert.equal(report.trials[0].score, 100);
});

test("adapter trial suite rejects invalid manifests", () => {
  assert.throws(() => runAdapterTrialSuite({ trials: [] }), /requires at least one trial/);
  assert.throws(() => runAdapterTrialSuite({
    trials: [{ id: "bad-kind", kind: "unknown", input: {} }]
  }), /Unsupported suite entry kind/);
  assert.throws(() => runAdapterTrialSuite({
    trials: [{ id: "missing-input" }]
  }), /require path or input/);
});
