import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  evaluateCompactCase,
  evaluateCompactCorpus,
  isExecutableCommand,
  loadGoldenCorpus
} from "../scripts/compact-semantic-evaluator.js";

const evaluator = path.resolve("scripts/compact-semantic-evaluator.js");

test("default v2 corpus clears semantic, reduction, and compact-budget gates", () => {
  const report = evaluateCompactCorpus(loadGoldenCorpus());

  assert.equal(report.ok, true);
  assert.equal(report.protocolVersion, "agentshell.compact-semantic-quality.v2");
  assert.equal(report.summary.fixtureCount, 12);
  assert.equal(report.summary.failedFixtures, 0);
  assert.equal(report.summary.budgetPass, true);
  assert.equal(report.micro.errorRecall, 1);
  assert.equal(report.micro.fileLocationAccuracy, 1);
  assert.equal(report.micro.lineAccuracy, 1);
  assert.equal(report.micro.decisionConsistency, 1);
  assert.equal(report.micro.necessaryInformationRetention, 1);
  assert.equal(report.summary.measuredTokenReductionCases, 4);
  assert.equal(report.summary.measuredExtraReadRiskCases, 4);
  assert.equal(report.micro.extraReadRisk, 0);
  assert.ok(report.micro.tokenReduction >= 0.5);
  assert.ok(report.macro.overall >= 0.9);
  assert.deepEqual(Object.keys(report.groups.byLanguage), ["go", "java", "javascript", "python", "typescript"]);
  assert.ok(report.cases.every((entry) => entry.measurement.estimatedTokens <= 3_000));
  assert.ok(report.cases.every((entry) => entry.measurement.chars <= 12_000));
});

test("evaluation is deterministic and independent from workspace state", () => {
  const corpus = loadGoldenCorpus();
  assert.deepEqual(evaluateCompactCorpus(corpus), evaluateCompactCorpus(structuredClone(corpus)));
});

test("missing evidence independently lowers semantic metrics", () => {
  const fixture = structuredClone(loadGoldenCorpus().fixtures[0]);
  fixture.compact.summary.mainError = "unrelated failure";
  fixture.compact.primaryFailure.message = "unrelated failure";
  fixture.compact.primaryFailure.line = 99;
  fixture.compact.fixPlan.target.line = 99;
  fixture.compact.fixPlan.nextCommand = "agentshell change <change.json>";
  fixture.compact.suggestedNextActions = [{ command: "agentshell change <change.json>", reason: "No useful evidence" }];

  const result = evaluateCompactCase(fixture);

  assert.equal(result.ok, false);
  assert.equal(result.scores.errorRecall, 0);
  assert.equal(result.scores.fileLocationAccuracy, 1);
  assert.equal(result.scores.lineAccuracy, 0);
  assert.equal(result.scores.decisionConsistency, 0);
  assert.ok(result.scores.necessaryInformationRetention < 1);
});

test("semantic success cannot bypass the compact output budget", () => {
  const fixture = structuredClone(loadGoldenCorpus().fixtures[0]);
  fixture.compact.noise = "x".repeat(13_000);

  const result = evaluateCompactCase(fixture);
  assert.equal(result.ok, false);
  assert.ok(result.budgetViolations.some((entry) => entry.kind === "string"));
  assert.ok(result.budgetViolations.some((entry) => entry.kind === "chars"));
});

test("next-action executability rejects placeholders and accepts concrete commands", () => {
  assert.equal(isExecutableCommand("agentshell read src/app.js --lines 1:20"), true);
  assert.equal(isExecutableCommand("go test ./internal/parser"), true);
  assert.equal(isExecutableCommand("agentshell change <change.json>"), false);
  assert.equal(isExecutableCommand("agentshell trial export --rating 1-5"), false);
  assert.equal(isExecutableCommand("TODO"), false);
});

test("CLI returns success for the corpus and failure for a degraded corpus", () => {
  const success = spawnSync(process.execPath, [evaluator], { encoding: "utf8" });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).ok, true);

  const corpus = loadGoldenCorpus();
  corpus.fixtures[0].compact.summary.mainError = "wrong";
  corpus.fixtures[0].compact.primaryFailure.message = "wrong";
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-semantic-corpus-"));
  const file = path.join(directory, "degraded.json");
  fs.writeFileSync(file, JSON.stringify(corpus));
  const failure = spawnSync(process.execPath, [evaluator, "--corpus", file], { encoding: "utf8" });
  assert.equal(failure.status, 1, failure.stderr);
  assert.equal(JSON.parse(failure.stdout).ok, false);
});

test("corpus and report schemas remain parseable and identify their contracts", () => {
  const corpusSchema = JSON.parse(fs.readFileSync("schemas/compact-semantic-corpus.schema.json", "utf8"));
  const reportSchema = JSON.parse(fs.readFileSync("schemas/compact-semantic-report.schema.json", "utf8"));
  assert.deepEqual(corpusSchema.properties.version.enum, [1, 2]);
  assert.equal(reportSchema.properties.protocolVersion.const, "agentshell.compact-semantic-quality.v2");
});

test("v2 metrics cover tolerance, token reduction, extra reads, and grouped micro/macro reports", () => {
  const fixture = {
    id: "go-noisy-counterexample",
    language: "go",
    scenario: "test-failure",
    supported: true,
    baseline: `old cached failure: timeout\n${"dependency debug noise\n".repeat(120)}parser/parser_test.go:42: expected invalid input error`,
    compact: {
      ok: false,
      protocolVersion: "agentshell.verify.v1",
      compact: true,
      summary: { status: "failed", mainError: "expected invalid input error" },
      primaryFailure: { file: "parser/parser_test.go", line: 43, message: "expected invalid input error" },
      suggestedNextActions: [{ command: "go test ./parser -run TestParse", reason: "rerun focused test" }]
    },
    expected: {
      errors: [{ anyOf: ["expected invalid input error"] }],
      locations: [{ file: "parser/parser_test.go", line: 42, lineTolerance: 1 }],
      decisions: [{ command: "go test ./parser -run TestParse" }],
      necessaryFacts: ["failed", "expected invalid input error", "rerun focused test"],
      forbiddenFacts: ["old cached failure: timeout"],
      additionalRead: { allowed: false }
    }
  };
  const report = evaluateCompactCorpus({ version: 2, fixtures: [fixture] });

  assert.equal(report.ok, true);
  assert.equal(report.micro.lineAccuracy, 1);
  assert.equal(report.cases[0].evidence.locations[0].lineDelta, 1);
  assert.equal(report.micro.extraReadRisk, 0);
  assert.ok(report.micro.tokenReduction > 0.5);
  assert.equal(report.groups.byLanguage.go.fixtureCount, 1);
  assert.equal(report.groups.byScenario["test-failure"].macro.decisionConsistency, 1);
});

test("gate catches a risky extra read and supports report-only mode", () => {
  const fixture = structuredClone(loadGoldenCorpus().fixtures[0]);
  fixture.expected.additionalRead = { allowed: false };
  fixture.compact.suggestedNextActions.push({ command: "agentshell log get noisy-log --tail 1000", reason: "reopen full log" });
  const report = evaluateCompactCorpus({ version: 2, fixtures: [fixture] });

  assert.equal(report.ok, false);
  assert.ok(report.micro.extraReadRisk > 0);
  assert.equal(report.gates.extraReadRisk.passed, false);
});

test("v2 gates reject unmeasured reduction and extra-read risk while v1 remains compatible", () => {
  const fixture = structuredClone(loadGoldenCorpus().fixtures[0]);
  const v2 = evaluateCompactCorpus({ version: 2, fixtures: [fixture] });
  assert.equal(v2.ok, false);
  assert.equal(v2.gates.extraReadRisk.measured, false);
  assert.equal(v2.gates.extraReadRisk.passed, false);
  assert.equal(v2.gates.tokenReduction.passed, false);

  const v1 = evaluateCompactCorpus({ version: 1, fixtures: [fixture] });
  assert.equal(v1.ok, true);
  assert.equal(v1.gates.extraReadRisk.passed, true);
  assert.equal(v1.gates.tokenReduction.passed, true);
});
