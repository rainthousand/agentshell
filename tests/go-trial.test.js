import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { discoverTrialProject, exportTrial, trialStatus } from "../src/commands/trial-export.js";

const goAvailable = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;

function writeGoModule(root, moduleName = "example.com/trial") {
  fs.writeFileSync(path.join(root, "go.mod"), `module ${moduleName}\n\ngo 1.22\n`);
}

test("trial status recognizes a Go module as a testable project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-go-trial-"));
  writeGoModule(root);

  const status = trialStatus(root);

  assert.equal(status.status, "no-agentshell-events");
  assert.equal(status.project.root, root);
  assert.equal(status.project.packageName, "example.com/trial");
});

test("trial discovery suggests one direct child Go module", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-go-trial-parent-"));
  const project = path.join(root, "go-project");
  fs.mkdirSync(project);
  writeGoModule(project);

  assert.deepEqual(discoverTrialProject(root), {
    projectRoot: null,
    suggestedProjectRoot: project
  });
});

test("trial export verifies a Go module and writes shareable evidence", { skip: !goAvailable }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-go-trial-export-"));
  const out = path.join(root, "trial.json");
  writeGoModule(root);
  fs.writeFileSync(path.join(root, "calc.go"), "package trial\n\nfunc Add(a, b int) int { return a + b }\n");
  fs.writeFileSync(path.join(root, "calc_test.go"), [
    "package trial",
    "",
    'import "testing"',
    "",
    "func TestAdd(t *testing.T) {",
    '  if Add(2, 3) != 5 { t.Fatal("unexpected sum") }',
    "}",
    ""
  ].join("\n"));

  const result = await exportTrial(root, {
    verify: true,
    rating: 5,
    out,
    packageRoot: process.cwd()
  });

  assert.equal(result.ok, true);
  assert.equal(result.summary.finalVerificationOk, true);
  assert.ok(result.summary.eventCount > 0);
  const bundle = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(bundle.finalVerification.ok, true);
  assert.equal(bundle.evidenceMetadata.userFeedback.rating, 5);
});
