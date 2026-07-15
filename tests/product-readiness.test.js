import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildProductReadinessReport } from "../scripts/product-readiness.js";

test("product readiness report passes for the current source tree", () => {
  const report = buildProductReadinessReport();

  assert.equal(report.ok, true);
  assert.equal(report.protocolVersion, "agentshell.product-readiness.v1");
  assert.equal(report.mode, "standard");
  assert.equal(report.status, "ready");
  assert.equal(report.summary.blockingFailed, 0);
  assert.ok(report.checks.some((check) => check.id === "manual-topics" && check.status === "pass"));
  assert.ok(report.checks.some((check) => check.id === "deferred-mcp" && check.severity === "warning"));
});

test("product readiness heavy dry run includes release candidate checks", () => {
  const report = buildProductReadinessReport(process.cwd(), { heavy: true, dryRun: true });

  assert.equal(report.ok, true);
  assert.equal(report.mode, "heavy-dry-run");
  assert.ok(report.checks.some((check) => check.id === "benchmark-suite-ci" && check.details.dryRun === true));
  assert.ok(report.checks.some((check) => check.id === "release-artifacts" && check.details.command === "npm run release:artifacts"));
  assert.ok(report.checks.some((check) => check.id === "codex-plugin-trial"));
  assert.ok(report.checks.some((check) => check.id === "strategy-intake"));
});

test("product readiness CLI prints parseable JSON and markdown", () => {
  const json = spawnSync("node", ["scripts/product-readiness.js"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const markdown = spawnSync("node", ["scripts/product-readiness.js", "--markdown"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(json.status, 0, json.stderr);
  assert.equal(markdown.status, 0, markdown.stderr);
  const output = JSON.parse(json.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.mode, "standard");
  assert.match(markdown.stdout, /^# AgentShell Product Readiness/m);
});

test("product readiness blocks when a required product entry point is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-readiness-"));
  copyMinimalTree(process.cwd(), dir);
  fs.rmSync(path.join(dir, "docs", "quickstart.md"));

  const report = buildProductReadinessReport(dir);

  assert.equal(report.ok, false);
  assert.equal(report.status, "blocked");
  const files = report.checks.find((check) => check.id === "required-files");
  assert.equal(files.status, "fail");
  assert.ok(files.details.missing.includes("docs/quickstart.md"));
});

function copyMinimalTree(sourceRoot, targetRoot) {
  const entries = [
    "README.md",
    "package.json",
    "src/commands/manual.js",
    "src/commands/schema.js",
    "schemas",
    "skills",
    "scripts",
    "docs",
    "examples/failing-test-demo/package.json",
    "examples/noisy-test-demo/package.json",
    "examples/adapter-trial-suite.sample.json"
  ];
  for (const entry of entries) {
    copyPath(path.join(sourceRoot, entry), path.join(targetRoot, entry));
  }
}

function copyPath(source, target) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const child of fs.readdirSync(source)) {
      copyPath(path.join(source, child), path.join(target, child));
    }
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}
