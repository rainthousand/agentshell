import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  applyHighNoiseSafeDefaults,
  classifyHighNoiseCommand,
  listHighNoiseProfiles,
  summarizeHighNoiseOutput
} from "../src/core/high-noise-profiles.js";
import { GO_COMMAND_PROFILES } from "../src/core/go-command-profiles.js";

const cases = JSON.parse(fs.readFileSync("tests/fixtures/high-noise-profiles/cases.json", "utf8"));

test("classifies every supported high-noise command family", () => {
  assert.equal(listHighNoiseProfiles().length, 14 + GO_COMMAND_PROFILES.length);
  for (const fixture of cases) {
    assert.equal(classifyHighNoiseCommand(fixture.command)?.id, fixture.id, fixture.id);
  }
  assert.equal(classifyHighNoiseCommand("git status"), null);
  assert.equal(classifyHighNoiseCommand([]), null);
});

test("safe defaults are argv-only, idempotent, and preserve explicit user choices", () => {
  const planned = applyHighNoiseSafeDefaults(["docker", "logs", "--tail", "50", "api"]);
  assert.equal(planned.matched, true);
  assert.deepEqual(planned.argv, ["docker", "logs", "--tail", "50", "api"]);
  assert.deepEqual(planned.appliedDefaults, []);

  const terraform = applyHighNoiseSafeDefaults(["terraform", "plan", "-input=true"]);
  assert.equal(terraform.argv.includes("-input=false"), false);
  assert.equal(terraform.argv.includes("-no-color"), true);
  assert.equal(terraform.argv.includes("-detailed-exitcode"), true);

  const first = applyHighNoiseSafeDefaults(["mypy", "src"]);
  const second = applyHighNoiseSafeDefaults(first.argv, first.profile);
  assert.deepEqual(second.argv, first.argv);
  assert.deepEqual(second.appliedDefaults, []);
  assert.equal(applyHighNoiseSafeDefaults("git status").matched, false);
});

for (const fixture of cases) {
  test(`extracts bounded key failures for ${fixture.id}`, () => {
    const result = summarizeHighNoiseOutput(fixture.command, fixture.output, { exitCode: fixture.exitCode });
    assert.equal(result.profileId, fixture.id);
    assert.equal(result.status, "failed");
    assert.match(result.mainError, new RegExp(escapeRegex(fixture.message), "i"));
    assert.equal(result.failures.length <= 8, true);
    assert.equal(result.locations.length <= 8, true);
    assert.equal(result.failures.every((entry) => entry.message.length <= 240), true);
    assert.equal(result.suggestedNextActions.length, 1);
    if (fixture.file) {
      assert.ok(result.locations.some((entry) => entry.file === fixture.file && entry.line === fixture.line));
    }
  });
}

test("terraform plan exit 2 is a successful changed result", () => {
  const result = summarizeHighNoiseOutput("terraform-plan", "Plan: 2 to add, 0 to change, 0 to destroy.", { exitCode: 2 });
  assert.equal(result.status, "changed");
  assert.equal(result.mainError, null);
});

test("unknown exit status remains explicit instead of claiming success", () => {
  const result = summarizeHighNoiseOutput("docker-logs", "service ready");
  assert.equal(result.status, "unknown");
  assert.equal(result.exitCode, null);
});

test("captures both ends of oversized output and reports truncation", () => {
  const noise = "noise\n".repeat(100000);
  const result = summarizeHighNoiseOutput("mypy", {
    stdout: `src/first.py:1: error: first failure [name-defined]\n${noise}`,
    stderr: "src/last.py:2: error: last failure [return-value]\n"
  }, { exitCode: 1 });

  assert.equal(result.truncated, true);
  assert.ok(result.failures.some((entry) => entry.message.includes("first failure")));
  assert.ok(result.failures.some((entry) => entry.message.includes("last failure")));
});

test("deduplicates and caps repeated failures and locations", () => {
  const output = Array.from({ length: 20 }, (_, index) =>
    `src/file${index}.py:${index + 1}: error: failure ${index} [misc]`
  ).join("\n");
  const result = summarizeHighNoiseOutput("mypy", output, { exitCode: 1 });

  assert.equal(result.failures.length, 8);
  assert.equal(result.locations.length, 8);
  assert.equal(result.counts.detectedFailures, 20);
  assert.equal(result.truncated, true);
});

test("schema describes the bounded summary contract", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/high-noise-profile-summary.schema.json", "utf8"));
  assert.equal(schema.title, "AgentShell High-noise Profile Summary");
  assert.equal(schema.properties.failures.maxItems, 8);
  assert.equal(schema.$defs.failure.properties.message.maxLength, 240);
  assert.deepEqual(schema.properties.status.enum, ["passed", "failed", "changed", "unknown"]);
  assert.equal(schema.properties.details.maxProperties, 8);
});

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
