import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("real project eval default manifest reports runnable, baseline, missing, and skipped fixtures", () => {
  const result = spawnSync("node", ["scripts/real-project-eval.js"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.manifest.endsWith(path.join("examples", "real-projects.json")), true);
  assert.equal(output.runs, 1);
  assert.equal(output.mode, "full");
  assert.equal(output.concurrency, 1);
  assert.equal(output.armConcurrency, 1);
  assert.equal(output.summary.total, 20);
  assert.equal(output.summary.pass, 18);
  assert.equal(output.summary.fail, 0);
  assert.equal(output.summary.skipped, 1);
  assert.equal(output.summary.missing, 1);
  assert.equal(output.summary.runnable, 18);
  assert.deepEqual(output.summary.skippedArms, {
    total: 0,
    raw: 0,
    split: 0,
    fix: 0
  });

  const runnable = output.projects.find((project) => project.id === "checked-in-runnable-fixture");
  assert.equal(runnable.status, "pass");
  assert.equal(runnable.availability, "runnable");
  assert.equal(runnable.arms.raw.commands[0].name, "raw:test");
  assert.equal(typeof runnable.arms.raw.success, "boolean");
  assert.equal(typeof runnable.arms.raw.commands[0].status, "number");
  assert.equal(runnable.arms.split.success, true);
  assert.deepEqual(runnable.arms.split.commands.map((command) => command.name), [
    "split:diagnose",
    "split:change-suggest",
    "split:verify"
  ]);
  assert.equal(runnable.arms.fix.success, true);
  assert.equal(runnable.arms.fix.commands[0].name, "fix:test");
  assert.equal(typeof runnable.evaluation.tokens, "number");
  assert.equal(typeof runnable.evaluation.durationMs, "number");
  assert.equal(typeof runnable.evaluation.success, "boolean");
  assert.equal(runnable.evaluation.safety, "checked");
  assert.equal(runnable.evaluation.generalization, "covered");
  assert.equal(runnable.classification.expectedFailureClass, "missing-object-property");
  assert.equal(runnable.classification.repairAttempted, true);
  assert.equal(runnable.classification.repairSucceeded, true);
  assert.deepEqual(runnable.classification.unsupportedReasons, []);
  assert.equal(output.summary.arms.raw.total, 18);
  assert.equal(typeof output.summary.arms.raw.success, "number");
  assert.equal(typeof output.summary.arms.raw.tokens, "number");
  assert.equal(typeof output.summary.arms.raw.durationMs, "number");
  assert.equal(output.summary.arms.raw.runs, 18);
  assert.equal(typeof output.summary.arms.raw.successRuns, "number");
  assert.equal(output.summary.arms.split.total, 17);
  assert.equal(output.summary.arms.split.success, 17);
  assert.equal(output.summary.arms.fix.total, 17);
  assert.equal(output.summary.arms.fix.success, 17);
  assert.equal(output.summary.failureClasses["missing-object-property"].repairSucceeded, 1);
  assert.equal(output.summary.failureClasses["import-path"].pass, 1);
  assert.equal(output.summary.unsupported.totalProjects, 0);
  assert.equal(output.summary.evaluation.safety.checked, 17);
  assert.equal(output.summary.evaluation.safety["not-applicable"], 1);
  assert.equal(output.summary.evaluation.generalization.covered, 17);

  const baseline = output.projects.find((project) => project.id === "healthy-node-baseline");
  assert.equal(baseline.status, "pass");
  assert.equal(baseline.availability, "runnable");
  assert.equal(baseline.skipRepairArms, true);
  assert.deepEqual(Object.keys(baseline.arms), ["raw"]);
  assert.equal(baseline.arms.raw.success, true);
  assert.equal(baseline.armsConfig.raw.enabled, true);
  assert.equal(baseline.armsConfig.split.enabled, false);
  assert.equal(baseline.armsConfig.fix.enabled, false);
  assert.equal(baseline.evaluation.success, true);
  assert.equal(baseline.evaluation.safety, "not-applicable");
  assert.equal(baseline.evaluation.generalization, "not-applicable");

  const importPath = output.projects.find((project) => project.id === "import-path-typo-real-project");
  assert.equal(importPath.status, "pass");
  assert.equal(importPath.availability, "runnable");
  assert.equal(importPath.expectedFailureClass, "import-path");
  assert.equal(importPath.arms.raw.success, false);
  assert.equal(importPath.arms.split.success, true);
  assert.equal(importPath.arms.fix.success, true);

  const typescriptDiagnostic = output.projects.find((project) => project.id === "typescript-diagnostic-real-project");
  assert.equal(typescriptDiagnostic.status, "pass");
  assert.equal(typescriptDiagnostic.availability, "runnable");
  assert.equal(typescriptDiagnostic.expectedFailureClass, "typescript-missing-property");
  assert.equal(typescriptDiagnostic.arms.raw.success, false);
  assert.equal(typescriptDiagnostic.arms.split.success, true);
  assert.equal(typescriptDiagnostic.arms.fix.success, true);

  const typescriptPropertySuggestion = output.projects.find((project) => project.id === "typescript-property-suggestion-real-project");
  assert.equal(typescriptPropertySuggestion.status, "pass");
  assert.equal(typescriptPropertySuggestion.availability, "runnable");
  assert.equal(typescriptPropertySuggestion.expectedFailureClass, "typescript-property-suggestion");
  assert.equal(typescriptPropertySuggestion.arms.raw.success, false);
  assert.equal(typescriptPropertySuggestion.arms.split.success, true);
  assert.equal(typescriptPropertySuggestion.arms.fix.success, true);

  const typescriptPrimitiveLiteral = output.projects.find((project) => project.id === "typescript-primitive-literal-real-project");
  assert.equal(typescriptPrimitiveLiteral.status, "pass");
  assert.equal(typescriptPrimitiveLiteral.availability, "runnable");
  assert.equal(typescriptPrimitiveLiteral.expectedFailureClass, "typescript-primitive-literal-mismatch");
  assert.equal(typescriptPrimitiveLiteral.arms.raw.success, false);
  assert.equal(typescriptPrimitiveLiteral.arms.split.success, true);
  assert.equal(typescriptPrimitiveLiteral.arms.fix.success, true);

  const literalReplacement = output.projects.find((project) => project.id === "literal-replacement-real-project");
  assert.equal(literalReplacement.status, "pass");
  assert.equal(literalReplacement.availability, "runnable");
  assert.equal(literalReplacement.expectedFailureClass, "literal-replacement");
  assert.equal(literalReplacement.arms.raw.success, false);
  assert.equal(literalReplacement.arms.split.success, true);
  assert.equal(literalReplacement.arms.fix.success, true);

  const deepEqualArrayElements = output.projects.find((project) => project.id === "deep-equal-array-elements-real-project");
  assert.equal(deepEqualArrayElements.status, "pass");
  assert.equal(deepEqualArrayElements.availability, "runnable");
  assert.equal(deepEqualArrayElements.expectedFailureClass, "deep-equal-array-elements");
  assert.equal(deepEqualArrayElements.arms.raw.success, false);
  assert.equal(deepEqualArrayElements.arms.split.success, true);
  assert.equal(deepEqualArrayElements.arms.fix.success, true);

  const deepEqualMissingProperty = output.projects.find((project) => project.id === "deep-equal-missing-property-real-project");
  assert.equal(deepEqualMissingProperty.status, "pass");
  assert.equal(deepEqualMissingProperty.availability, "runnable");
  assert.equal(deepEqualMissingProperty.expectedFailureClass, "deep-equal-missing-property");
  assert.equal(deepEqualMissingProperty.arms.raw.success, false);
  assert.equal(deepEqualMissingProperty.arms.split.success, true);
  assert.equal(deepEqualMissingProperty.arms.fix.success, true);

  const deepEqualArrayRemoval = output.projects.find((project) => project.id === "deep-equal-array-removal-real-project");
  assert.equal(deepEqualArrayRemoval.status, "pass");
  assert.equal(deepEqualArrayRemoval.availability, "runnable");
  assert.equal(deepEqualArrayRemoval.expectedFailureClass, "deep-equal-array-removal");
  assert.equal(deepEqualArrayRemoval.arms.raw.success, false);
  assert.equal(deepEqualArrayRemoval.arms.split.success, true);
  assert.equal(deepEqualArrayRemoval.arms.fix.success, true);

  const deepEqualExtraPropertyRemoval = output.projects.find((project) => project.id === "deep-equal-extra-property-removal-real-project");
  assert.equal(deepEqualExtraPropertyRemoval.status, "pass");
  assert.equal(deepEqualExtraPropertyRemoval.availability, "runnable");
  assert.equal(deepEqualExtraPropertyRemoval.expectedFailureClass, "deep-equal-extra-property-removal");
  assert.equal(deepEqualExtraPropertyRemoval.arms.raw.success, false);
  assert.equal(deepEqualExtraPropertyRemoval.arms.split.success, true);
  assert.equal(deepEqualExtraPropertyRemoval.arms.fix.success, true);

  const deepEqualArrayPrimitiveReplacement = output.projects.find((project) => project.id === "deep-equal-array-primitive-replacement-real-project");
  assert.equal(deepEqualArrayPrimitiveReplacement.status, "pass");
  assert.equal(deepEqualArrayPrimitiveReplacement.availability, "runnable");
  assert.equal(deepEqualArrayPrimitiveReplacement.expectedFailureClass, "deep-equal-array-primitive-replacement");
  assert.equal(deepEqualArrayPrimitiveReplacement.arms.raw.success, false);
  assert.equal(deepEqualArrayPrimitiveReplacement.arms.split.success, true);
  assert.equal(deepEqualArrayPrimitiveReplacement.arms.fix.success, true);

  const arrayLength = output.projects.find((project) => project.id === "array-length-real-project");
  assert.equal(arrayLength.status, "pass");
  assert.equal(arrayLength.availability, "runnable");
  assert.equal(arrayLength.expectedFailureClass, "array-length");
  assert.equal(arrayLength.arms.raw.success, false);
  assert.equal(arrayLength.arms.split.success, true);
  assert.equal(arrayLength.arms.fix.success, true);

  const stringCaseTransform = output.projects.find((project) => project.id === "string-case-transform-real-project");
  assert.equal(stringCaseTransform.status, "pass");
  assert.equal(stringCaseTransform.availability, "runnable");
  assert.equal(stringCaseTransform.expectedFailureClass, "string-case-transform");
  assert.equal(stringCaseTransform.arms.raw.success, false);
  assert.equal(stringCaseTransform.arms.split.success, true);
  assert.equal(stringCaseTransform.arms.fix.success, true);

  const joinSeparatorLiteral = output.projects.find((project) => project.id === "join-separator-literal-real-project");
  assert.equal(joinSeparatorLiteral.status, "pass");
  assert.equal(joinSeparatorLiteral.availability, "runnable");
  assert.equal(joinSeparatorLiteral.expectedFailureClass, "join-separator-literal");
  assert.equal(joinSeparatorLiteral.arms.raw.success, false);
  assert.equal(joinSeparatorLiteral.arms.split.success, true);
  assert.equal(joinSeparatorLiteral.arms.fix.success, true);

  const truthyReturn = output.projects.find((project) => project.id === "truthy-return-real-project");
  assert.equal(truthyReturn.status, "pass");
  assert.equal(truthyReturn.availability, "runnable");
  assert.equal(truthyReturn.expectedFailureClass, "truthy-return");
  assert.equal(truthyReturn.arms.raw.success, false);
  assert.equal(truthyReturn.arms.split.success, true);
  assert.equal(truthyReturn.arms.fix.success, true);

  const missingNamedExport = output.projects.find((project) => project.id === "missing-named-export-real-project");
  assert.equal(missingNamedExport.status, "pass");
  assert.equal(missingNamedExport.availability, "runnable");
  assert.equal(missingNamedExport.expectedFailureClass, "missing-named-export");
  assert.equal(missingNamedExport.arms.raw.success, false);
  assert.equal(missingNamedExport.arms.split.success, true);
  assert.equal(missingNamedExport.arms.fix.success, true);

  const typescriptLiteralMismatch = output.projects.find((project) => project.id === "typescript-literal-mismatch-real-project");
  assert.equal(typescriptLiteralMismatch.status, "pass");
  assert.equal(typescriptLiteralMismatch.availability, "runnable");
  assert.equal(typescriptLiteralMismatch.expectedFailureClass, "typescript-literal-mismatch");
  assert.equal(typescriptLiteralMismatch.arms.raw.success, false);
  assert.equal(typescriptLiteralMismatch.arms.split.success, true);
  assert.equal(typescriptLiteralMismatch.arms.fix.success, true);

  const missing = output.projects.find((project) => project.id === "sample-missing-local-project");
  assert.equal(missing.status, "missing");
  assert.equal(missing.availability, "missing");
  assert.equal(missing.reason, "repo-path-not-found");
  assert.equal(missing.evaluation.success, null);

  const skipped = output.projects.find((project) => project.id === "sample-skipped-external-project");
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.availability, "skipped");
  assert.equal(skipped.reason, "example-manifest-placeholder");
});

test("real project eval reports pass, missing, and skipped counts from an explicit manifest", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-real-project-eval-"));
  const passingProject = path.join(tempRoot, "passing-project");
  fs.mkdirSync(passingProject);
  fs.writeFileSync(path.join(passingProject, "package.json"), JSON.stringify({
    type: "module",
    scripts: {
      test: "node -e \"process.exit(0)\""
    }
  }));

  const manifestPath = path.join(tempRoot, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    projects: [
      {
        id: "passing-project",
        repoPath: passingProject,
        testCommand: "npm test",
        skipRepairArms: true,
        expectedFailureClass: "literal-replacement",
        allowedStrategies: ["split", "fix"],
        metrics: ["tokens", "durationMs", "success"]
      },
      {
        id: "missing-project",
        repoPath: path.join(tempRoot, "missing-project"),
        testCommand: "npm test",
        expectedFailureClass: "missing-object-property",
        allowedStrategies: ["fix"],
        metrics: ["success"]
      },
      {
        id: "skipped-project",
        repoPath: path.join(tempRoot, "skipped-project"),
        skip: true,
        skipReason: "fixture-skip",
        testCommand: "npm test",
        expectedFailureClass: "literal-replacement",
        allowedStrategies: ["fix"],
        metrics: ["tokens", "durationMs", "success", "safety", "generalization"]
      }
    ]
  }));

  const result = spawnSync("node", ["scripts/real-project-eval.js", "--manifest", manifestPath], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.summary.total, 3);
  assert.equal(output.summary.pass, 1);
  assert.equal(output.summary.fail, 0);
  assert.equal(output.summary.skipped, 1);
  assert.equal(output.summary.missing, 1);
  assert.equal(output.summary.runnable, 1);

  const passing = output.projects.find((project) => project.id === "passing-project");
  assert.equal(passing.status, "pass");
  assert.equal(passing.availability, "runnable");
  assert.equal(passing.commands.length, 1);
  assert.equal(passing.commands[0].name, "raw:test");
  assert.equal(passing.commands[0].tokens, Math.ceil(passing.commands[0].chars / 4));
  assert.deepEqual(Object.keys(passing.arms), ["raw"]);
  assert.equal(passing.arms.raw.success, true);
  assert.equal(passing.armsConfig.split.enabled, false);
  assert.equal(passing.armsConfig.fix.enabled, false);
  assert.equal(passing.evaluation.tokens, passing.commands[0].tokens);
  assert.equal(passing.evaluation.durationMs, passing.commands[0].durationMs);
  assert.equal(passing.evaluation.success, true);
  assert.equal(passing.evaluation.safety, "not-applicable");
  assert.equal(passing.evaluation.generalization, "unknown");

  const missing = output.projects.find((project) => project.id === "missing-project");
  assert.equal(missing.status, "missing");
  assert.equal(missing.availability, "missing");
  assert.equal(missing.reason, "repo-path-not-found");
  assert.equal(missing.evaluation.tokens, null);

  const skipped = output.projects.find((project) => project.id === "skipped-project");
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.availability, "skipped");
  assert.equal(skipped.reason, "fixture-skip");
});

test("real project eval runs projects concurrently when requested", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-real-project-eval-"));
  const markersPath = path.join(tempRoot, "markers.jsonl");
  const projects = ["slow-a", "slow-b"].map((id) => {
    const projectPath = path.join(tempRoot, id);
    fs.mkdirSync(projectPath);
    fs.writeFileSync(path.join(projectPath, "test.js"), [
      "const fs = require('node:fs');",
      `const markersPath = ${JSON.stringify(markersPath)};`,
      `const id = ${JSON.stringify(id)};`,
      "fs.appendFileSync(markersPath, JSON.stringify({ id, event: 'start', at: Date.now() }) + '\\n');",
      "setTimeout(() => {",
      "  fs.appendFileSync(markersPath, JSON.stringify({ id, event: 'end', at: Date.now() }) + '\\n');",
      "}, 450);",
      ""
    ].join("\n"));
    return {
      id,
      repoPath: projectPath,
      testCommand: "node test.js",
      skipRepairArms: true
    };
  });

  const manifestPath = path.join(tempRoot, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    projects
  }));

  const result = spawnSync("node", [
    "scripts/real-project-eval.js",
    "--manifest",
    manifestPath,
    "--concurrency",
    "2"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.concurrency, 2);
  assert.deepEqual(output.projects.map((project) => project.id), ["slow-a", "slow-b"]);

  const markers = fs.readFileSync(markersPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const starts = markers.filter((marker) => marker.event === "start");
  const ends = markers.filter((marker) => marker.event === "end");
  assert.equal(starts.length, 2);
  assert.equal(ends.length, 2);
  assert.equal(Math.max(...starts.map((marker) => marker.at)) < Math.min(...ends.map((marker) => marker.at)), true);
});

test("real project eval fix-first skips raw and split after a successful fix arm", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-real-project-eval-"));
  const repairProject = path.join(tempRoot, "fix-first-project");
  fs.mkdirSync(path.join(repairProject, "src"), { recursive: true });
  fs.mkdirSync(path.join(repairProject, "test"), { recursive: true });
  fs.writeFileSync(path.join(repairProject, "package.json"), JSON.stringify({
    type: "module",
    scripts: {
      test: "node test/user.test.js"
    }
  }, null, 2));
  fs.writeFileSync(path.join(repairProject, "src", "user.js"), [
    "export function createUser(input) {",
    "  return {",
    "    name: input.name,",
    "    email: input.email",
    "  };",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(repairProject, "test", "user.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { createUser } from '../src/user.js';",
    "const user = createUser({ name: 'Ada', email: 'ada@example.com' });",
    "assert.ok(user.id, 'Expected user.id to be present');",
    ""
  ].join("\n"));

  const manifestPath = path.join(tempRoot, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    projects: [{
      id: "fix-first-project",
      repoPath: repairProject,
      testCommand: "npm test",
      allowedStrategies: ["raw", "split", "fix"]
    }]
  }));

  const result = spawnSync("node", [
    "scripts/real-project-eval.js",
    "--manifest",
    manifestPath,
    "--mode",
    "fix-first"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const project = output.projects[0];
  assert.equal(output.mode, "fix-first");
  assert.equal(project.status, "pass");
  assert.deepEqual(Object.keys(project.arms), ["fix"]);
  assert.deepEqual(project.skippedArms, [
    { name: "raw", reason: "fix-succeeded" },
    { name: "split", reason: "fix-succeeded" }
  ]);
  assert.equal(project.arms.fix.success, true);
  assert.deepEqual(project.commands.map((command) => command.name), ["fix:test"]);
  assert.equal(output.summary.arms.raw, undefined);
  assert.equal(output.summary.arms.split, undefined);
  assert.equal(output.summary.arms.fix.total, 1);
  assert.deepEqual(output.summary.skippedArms, {
    total: 2,
    raw: 1,
    split: 1,
    fix: 0
  });
});

test("real project eval fix-first backfills other enabled arms when fix fails", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-real-project-eval-"));
  const unsupportedProject = path.join(tempRoot, "fix-first-unsupported-project");
  fs.mkdirSync(path.join(unsupportedProject, "test"), { recursive: true });
  fs.writeFileSync(path.join(unsupportedProject, "package.json"), JSON.stringify({
    type: "module",
    scripts: {
      test: "node test/fail.test.js"
    }
  }, null, 2));
  fs.writeFileSync(path.join(unsupportedProject, "test", "fail.test.js"), [
    "console.error('unsupported external service failure');",
    "process.exit(1);",
    ""
  ].join("\n"));

  const manifestPath = path.join(tempRoot, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    projects: [{
      id: "fix-first-unsupported-project",
      repoPath: unsupportedProject,
      testCommand: "npm test",
      allowedStrategies: ["raw", "fix"]
    }]
  }));

  const result = spawnSync("node", [
    "scripts/real-project-eval.js",
    "--manifest",
    manifestPath,
    "--mode",
    "fix-first"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const project = output.projects[0];
  assert.equal(output.mode, "fix-first");
  assert.equal(output.ok, false);
  assert.equal(project.status, "fail");
  assert.equal(project.reason, "fix-arm-unsuccessful");
  assert.deepEqual(Object.keys(project.arms), ["raw", "fix"]);
  assert.deepEqual(project.skippedArms, []);
  assert.equal(project.arms.raw.success, false);
  assert.equal(project.arms.fix.success, false);
  assert.equal(output.summary.arms.raw.total, 1);
  assert.equal(output.summary.arms.fix.total, 1);
});

test("real project eval runs arms concurrently when requested", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-real-project-eval-"));
  const markersPath = path.join(tempRoot, "arm-markers.jsonl");
  const projectPath = path.join(tempRoot, "arm-concurrent-project");
  fs.mkdirSync(projectPath);
  fs.writeFileSync(path.join(projectPath, "setup.cjs"), [
    "const fs = require('node:fs');",
    `const markersPath = ${JSON.stringify(markersPath)};`,
    "const arm = process.env.npm_lifecycle_event || process.env.AGENTSHELL_REAL_PROJECT_EVAL || 'setup';",
    "fs.appendFileSync(markersPath, JSON.stringify({ arm, event: 'start', at: Date.now() }) + '\\n');",
    "setTimeout(() => {",
    "  fs.appendFileSync(markersPath, JSON.stringify({ arm, event: 'end', at: Date.now() }) + '\\n');",
    "}, 450);",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(projectPath, "test.js"), "console.log('pass');\n");
  fs.writeFileSync(path.join(projectPath, "package.json"), JSON.stringify({
    type: "module",
    scripts: {
      test: "node test.js"
    }
  }, null, 2));

  const manifestPath = path.join(tempRoot, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    projects: [{
      id: "arm-concurrent-project",
      repoPath: projectPath,
      setupCommand: "node setup.cjs",
      testCommand: "npm test",
      allowedStrategies: ["raw", "split", "fix"]
    }]
  }));

  const result = spawnSync("node", [
    "scripts/real-project-eval.js",
    "--manifest",
    manifestPath,
    "--arm-concurrency",
    "3"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.armConcurrency, 3);
  assert.equal(output.projects[0].effectiveArmConcurrency, 3);
  assert.deepEqual(Object.keys(output.projects[0].arms), ["raw", "split", "fix"]);

  const markers = fs.readFileSync(markersPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const starts = markers.filter((marker) => marker.event === "start");
  const ends = markers.filter((marker) => marker.event === "end");
  assert.equal(starts.length, 3);
  assert.equal(ends.length, 3);
  assert.equal(Math.max(...starts.map((marker) => marker.at)) < Math.min(...ends.map((marker) => marker.at)), true);
});

test("real project eval runs split and fix arms in isolated copies", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-real-project-eval-"));
  const repairProject = path.join(tempRoot, "repair-project");
  fs.mkdirSync(path.join(repairProject, "src"), { recursive: true });
  fs.mkdirSync(path.join(repairProject, "test"), { recursive: true });
  fs.writeFileSync(path.join(repairProject, "package.json"), JSON.stringify({
    type: "module",
    scripts: {
      test: "node test/user.test.js"
    }
  }, null, 2));
  fs.writeFileSync(path.join(repairProject, "src", "user.js"), [
    "export function createUser(input) {",
    "  return {",
    "    name: input.name,",
    "    email: input.email",
    "  };",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(repairProject, "test", "user.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { createUser } from '../src/user.js';",
    "const user = createUser({ name: 'Ada', email: 'ada@example.com' });",
    "assert.ok(user.id, 'Expected user.id to be present');",
    ""
  ].join("\n"));

  const manifestPath = path.join(tempRoot, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    projects: [{
      id: "repair-project",
      repoPath: repairProject,
      testCommand: "npm test",
      allowedStrategies: ["raw", "split", "fix"]
    }]
  }));

  const result = spawnSync("node", ["scripts/real-project-eval.js", "--manifest", manifestPath], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const project = output.projects[0];
  assert.equal(project.status, "pass");
  assert.equal(project.arms.raw.success, false);
  assert.equal(project.arms.split.success, true);
  assert.equal(project.arms.fix.success, true);
  assert.equal(output.summary.arms.raw.success, 0);
  assert.equal(output.summary.arms.split.success, 1);
  assert.equal(output.summary.arms.fix.success, 1);
  assert.match(fs.readFileSync(path.join(repairProject, "src", "user.js"), "utf8"), /email: input\.email/);
  assert.doesNotMatch(fs.readFileSync(path.join(repairProject, "src", "user.js"), "utf8"), /id: `user_/);
});

test("real project eval excludes generated directories from isolated copies", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-real-project-eval-"));
  const projectRoot = path.join(tempRoot, "generated-dir-project");
  fs.mkdirSync(path.join(projectRoot, "test"), { recursive: true });
  for (const directory of ["artifacts", "coverage", "dist"]) {
    fs.mkdirSync(path.join(projectRoot, directory), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, directory, "generated.txt"), "generated\n");
  }
  fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({
    type: "module",
    scripts: {
      test: "node test/generated-dirs.test.js"
    }
  }, null, 2));
  fs.writeFileSync(path.join(projectRoot, "test", "generated-dirs.test.js"), [
    "import assert from 'node:assert/strict';",
    "import fs from 'node:fs';",
    "for (const directory of ['artifacts', 'coverage', 'dist']) {",
    "  assert.equal(fs.existsSync(directory), false, `${directory} should not be copied`);",
    "}",
    ""
  ].join("\n"));

  const manifestPath = path.join(tempRoot, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    projects: [{
      id: "generated-dir-project",
      repoPath: projectRoot,
      testCommand: "npm test",
      skipRepairArms: true,
      allowedStrategies: ["raw"]
    }]
  }));

  const result = spawnSync("node", ["scripts/real-project-eval.js", "--manifest", manifestPath], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.projects[0].status, "pass");
  assert.equal(output.projects[0].arms.raw.success, true);
});

test("real project eval applies manifest mutations only inside isolated arms", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-real-project-eval-"));
  const repairProject = path.join(tempRoot, "mutation-project");
  fs.mkdirSync(path.join(repairProject, "src"), { recursive: true });
  fs.mkdirSync(path.join(repairProject, "test"), { recursive: true });
  fs.writeFileSync(path.join(repairProject, "package.json"), JSON.stringify({
    type: "module",
    scripts: {
      test: "node test/math.test.js"
    }
  }, null, 2));
  fs.writeFileSync(path.join(repairProject, "src", "math.js"), [
    "export function answer() {",
    "  return 42;",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(repairProject, "test", "math.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { answer } from '../src/math.js';",
    "assert.equal(answer(), 42);",
    ""
  ].join("\n"));

  const manifestPath = path.join(tempRoot, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    projects: [{
      id: "mutation-project",
      repoPath: repairProject,
      testCommand: "npm test",
      expectedFailureClass: "literal-replacement",
      allowedStrategies: ["raw", "fix"],
      mutations: [{
        path: "src/math.js",
        replace: "return 42;",
        with: "return 41;"
      }]
    }]
  }));

  const result = spawnSync("node", ["scripts/real-project-eval.js", "--manifest", manifestPath], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const project = output.projects[0];
  assert.equal(project.status, "pass");
  assert.equal(project.arms.raw.success, false);
  assert.equal(project.arms.fix.success, true);
  assert.deepEqual(project.arms.raw.commands.map((command) => command.name), [
    "raw:mutate",
    "raw:test"
  ]);
  assert.deepEqual(project.arms.fix.commands.map((command) => command.name), [
    "fix:mutate",
    "fix:test"
  ]);
  assert.match(project.arms.raw.commands[0].command, /apply manifest mutations/);
  assert.match(fs.readFileSync(path.join(repairProject, "src", "math.js"), "utf8"), /return 42;/);
  assert.doesNotMatch(fs.readFileSync(path.join(repairProject, "src", "math.js"), "utf8"), /return 41;/);
});

test("real project eval can link setup directories into isolated arms", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-real-project-eval-"));
  const linkedProject = path.join(tempRoot, "linked-project");
  fs.mkdirSync(path.join(linkedProject, "node_modules", "local-pkg"), { recursive: true });
  fs.mkdirSync(path.join(linkedProject, "test"), { recursive: true });
  fs.writeFileSync(path.join(linkedProject, "package.json"), JSON.stringify({
    type: "module",
    scripts: {
      test: "node test/link.test.js"
    }
  }, null, 2));
  fs.writeFileSync(path.join(linkedProject, "node_modules", "local-pkg", "package.json"), JSON.stringify({
    type: "module",
    main: "index.js"
  }));
  fs.writeFileSync(path.join(linkedProject, "node_modules", "local-pkg", "index.js"), [
    "export const linkedValue = 7;",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(linkedProject, "test", "link.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { linkedValue } from 'local-pkg';",
    "assert.equal(linkedValue, 7);",
    ""
  ].join("\n"));

  const manifestPath = path.join(tempRoot, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    projects: [{
      id: "linked-project",
      repoPath: linkedProject,
      testCommand: "npm test",
      skipRepairArms: true,
      setupLinks: [{
        source: "node_modules",
        target: "node_modules"
      }]
    }]
  }));

  const result = spawnSync("node", [
    "scripts/real-project-eval.js",
    "--manifest",
    manifestPath,
    "--arm-concurrency",
    "3"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const project = output.projects[0];
  assert.equal(output.armConcurrency, 3);
  assert.equal(project.effectiveArmConcurrency, 1);
  assert.equal(project.status, "pass");
  assert.equal(project.arms.raw.success, true);
  assert.deepEqual(project.arms.raw.commands.map((command) => command.name), [
    "raw:setup-link",
    "raw:test"
  ]);
  assert.equal(project.arms.raw.commands[0].command, "apply setup links");
  assert.equal(fs.existsSync(path.join(linkedProject, "node_modules", "local-pkg", "index.js")), true);
});

test("real project eval fails a project when enabled repair arms do not repair", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-real-project-eval-"));
  const unsupportedProject = path.join(tempRoot, "unsupported-project");
  fs.mkdirSync(path.join(unsupportedProject, "test"), { recursive: true });
  fs.writeFileSync(path.join(unsupportedProject, "package.json"), JSON.stringify({
    type: "module",
    scripts: {
      test: "node test/fail.test.js"
    }
  }, null, 2));
  fs.writeFileSync(path.join(unsupportedProject, "test", "fail.test.js"), [
    "console.error('unsupported external service failure');",
    "process.exit(1);",
    ""
  ].join("\n"));

  const manifestPath = path.join(tempRoot, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    projects: [{
      id: "unsupported-project",
      repoPath: unsupportedProject,
      testCommand: "npm test",
      allowedStrategies: ["raw", "fix"]
    }]
  }));

  const result = spawnSync("node", ["scripts/real-project-eval.js", "--manifest", manifestPath], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const project = output.projects[0];
  assert.equal(output.ok, false);
  assert.equal(project.status, "fail");
  assert.equal(project.reason, "fix-arm-unsuccessful");
  assert.equal(project.arms.raw.success, false);
  assert.equal(project.arms.fix.success, false);
  assert.equal(project.evaluation.safety, "failed");
  assert.equal(project.evaluation.generalization, "unsupported");
  assert.deepEqual(project.classification.unsupportedReasons, ["no-change-template"]);
  assert.equal(project.classification.repairAttempted, true);
  assert.equal(project.classification.repairSucceeded, false);
  assert.equal(output.summary.unsupported.totalProjects, 1);
  assert.equal(output.summary.unsupported.totalArms, 1);
  assert.equal(output.summary.unsupported.reasons["no-change-template"], 1);
  assert.equal(output.summary.unsupported.projects[0].id, "unsupported-project");
  assert.match(output.summary.unsupported.projects[0].suggestedNextActions[0].command, /diagnose test --compact|log get|run status --compact/);
  assert.equal(output.summary.fail, 1);
});

test("real project eval writes report and compact artifacts without raw logs in stdout", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-real-project-eval-"));
  const noisyProject = path.join(tempRoot, "noisy-project");
  fs.mkdirSync(noisyProject);
  fs.writeFileSync(path.join(noisyProject, "package.json"), JSON.stringify({
    type: "module",
    scripts: {
      test: "node -e \"console.log('x'.repeat(5000)); console.error('compact stderr')\""
    }
  }));

  const manifestPath = path.join(tempRoot, "manifest.json");
  const reportPath = path.join(tempRoot, "reports", "real-project-eval.json");
  const artifactsDir = path.join(tempRoot, "artifacts");
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    projects: [{
      id: "noisy-project",
      repoPath: noisyProject,
      testCommand: "npm test",
      skipRepairArms: true
    }]
  }));

  const result = spawnSync("node", [
    "scripts/real-project-eval.js",
    "--manifest",
    manifestPath,
    "--report",
    reportPath,
    "--artifacts-dir",
    artifactsDir
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const reportFile = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.deepEqual(reportFile, output);
  assert.equal(output.ok, true);
  assert.equal(output.artifacts.directory, artifactsDir);
  assert.equal(output.artifacts.summary, "summary.json");
  assert.equal(output.projects[0].arms.raw.artifact, path.join("projects", "noisy-project", "raw.json"));
  assert.equal(result.stdout.includes("x".repeat(2500)), false);

  const summaryArtifact = JSON.parse(fs.readFileSync(path.join(artifactsDir, "summary.json"), "utf8"));
  assert.equal(summaryArtifact.type, "real-project-eval-summary");
  assert.equal(summaryArtifact.projects[0].artifacts.raw, path.join("projects", "noisy-project", "raw.json"));

  const rawArtifact = JSON.parse(fs.readFileSync(path.join(artifactsDir, "projects", "noisy-project", "raw.json"), "utf8"));
  assert.equal(rawArtifact.type, "real-project-eval-arm");
  assert.equal(rawArtifact.project.id, "noisy-project");
  assert.equal(rawArtifact.arm.name, "raw");
  assert.equal(rawArtifact.arm.runs, 1);
  assert.equal(rawArtifact.arm.successRuns, 1);
  assert.equal(rawArtifact.runs.length, 1);
  assert.equal(rawArtifact.runs[0].run, 1);
  assert.equal(rawArtifact.commands[0].output.stdout.chars > 5000, true);
  assert.equal(rawArtifact.commands[0].output.stdout.truncated, true);
  assert.equal(rawArtifact.commands[0].output.stdout.head.length, 1000);
  assert.equal(rawArtifact.commands[0].output.stdout.tail.length, 1000);
  assert.equal(rawArtifact.commands[0].output.stderr.truncated, false);
  assert.match(rawArtifact.commands[0].output.stderr.text, /compact stderr/);
});

test("real project eval repeats arms and aggregates run metrics", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-real-project-eval-"));
  const passingProject = path.join(tempRoot, "passing-project");
  fs.mkdirSync(passingProject);
  fs.writeFileSync(path.join(passingProject, "package.json"), JSON.stringify({
    type: "module",
    scripts: {
      test: "node -e \"console.log('stable pass')\""
    }
  }));

  const manifestPath = path.join(tempRoot, "manifest.json");
  const artifactsDir = path.join(tempRoot, "artifacts");
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    projects: [{
      id: "passing-project",
      repoPath: passingProject,
      testCommand: "npm test",
      skipRepairArms: true
    }]
  }));

  const result = spawnSync("node", [
    "scripts/real-project-eval.js",
    "--manifest",
    manifestPath,
    "--runs",
    "2",
    "--artifacts-dir",
    artifactsDir
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.runs, 2);
  assert.equal(output.summary.arms.raw.total, 1);
  assert.equal(output.summary.arms.raw.success, 1);
  assert.equal(output.summary.arms.raw.runs, 2);
  assert.equal(output.summary.arms.raw.successRuns, 2);

  const raw = output.projects[0].arms.raw;
  assert.equal(raw.success, true);
  assert.equal(raw.runs, 2);
  assert.equal(raw.successRuns, 2);
  assert.equal(raw.failureRuns, 0);
  assert.equal(raw.successRate, 1);
  assert.equal(raw.runResults.length, 2);
  assert.deepEqual(raw.runResults.map((run) => run.run), [1, 2]);
  assert.equal(raw.commands.length, 2);
  assert.equal(raw.averageTokens, Math.round(raw.tokens / 2));
  assert.equal(raw.averageDurationMs, Math.round(raw.durationMs / 2));

  const rawArtifact = JSON.parse(fs.readFileSync(path.join(artifactsDir, "projects", "passing-project", "raw.json"), "utf8"));
  assert.equal(rawArtifact.arm.runs, 2);
  assert.equal(rawArtifact.arm.successRuns, 2);
  assert.equal(rawArtifact.runs.length, 2);
  assert.deepEqual(rawArtifact.runs.map((run) => run.run), [1, 2]);
  assert.equal(rawArtifact.runs[0].commands[0].output.stdout.truncated, false);
  assert.match(rawArtifact.runs[0].commands[0].output.stdout.text, /stable pass/);
});
