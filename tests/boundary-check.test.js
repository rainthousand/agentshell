import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { boundaryCheck } from "../src/commands/boundary-check.js";
import { evaluateBoundaryPolicy, normalizeBoundaryPolicy } from "../src/core/boundary-check.js";

test("deny glob and prefix rules reject matching changed files", () => {
  const result = evaluateBoundaryPolicy([
    "src/app.js",
    "generated/client.js",
    "secrets/local.key"
  ], {
    name: "workspace-boundaries",
    deny: {
      globs: ["**/*.key"],
      prefixes: ["generated"],
      reason: "Protected path"
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.summary.violationCount, 2);
  assert.deepEqual(result.violations.map((entry) => entry.file), ["generated/client.js", "secrets/local.key"]);
});

test("allow rules create an explicit scope and deny takes precedence", () => {
  const result = evaluateBoundaryPolicy([
    "service/api/app.go",
    "service/api/private/key.go",
    "service/worker/job.go"
  ], {
    rules: [
      { id: "api", effect: "allow", prefixes: ["service/api"] },
      { id: "private", effect: "deny", globs: ["service/api/private/**"], reason: "Private API is protected" }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.violations.find((entry) => entry.file === "service/api/private/key.go").ruleId, "private");
  assert.equal(result.violations.find((entry) => entry.file === "service/worker/job.go").ruleId, "allow-scope");
  assert.equal(result.files.find((entry) => entry.file === "service/api/app.go").allowed, true);
});

test("boundary command is check-only and accepts an inline policy", () => {
  const root = tempProject();
  const output = boundaryCheck(root, {
    changedFiles: ["src/app.ts", "vendor/generated.ts"],
    policy: { deny: { prefixes: ["vendor"] } },
    compact: true
  });

  assert.equal(output.protocolVersion, "agentshell.boundary-check.v1");
  assert.equal(output.mode, "check");
  assert.equal(output.ok, false);
  assert.equal(output.summary.changedFileCount, 2);
  assert.equal(output.violations[0].file, "vendor/generated.ts");
});

test("boundary command loads a workspace-relative JSON policy", () => {
  const root = tempProject();
  fs.mkdirSync(path.join(root, ".agentshell"));
  fs.writeFileSync(path.join(root, ".agentshell", "boundaries.json"), JSON.stringify({
    defaultEffect: "deny",
    allow: { globs: ["src/**"] }
  }));

  const output = boundaryCheck(root, {
    changedFiles: ["src/app.py"],
    policyFile: ".agentshell/boundaries.json"
  });

  assert.equal(output.ok, true);
  assert.equal(output.policy.defaultEffect, "deny");
});

test("boundary command rejects a workspace symlink to an external policy", () => {
  const root = tempProject();
  const external = tempProject();
  fs.mkdirSync(path.join(root, ".agentshell"));
  const externalPolicy = path.join(external, "boundaries.json");
  fs.writeFileSync(externalPolicy, JSON.stringify({ defaultEffect: "allow" }));
  fs.symlinkSync(externalPolicy, path.join(root, ".agentshell", "boundaries.json"));

  const output = boundaryCheck(root, {
    changedFiles: ["src/app.py"],
    policyFile: ".agentshell/boundaries.json"
  });

  assert.equal(output.ok, false);
  assert.equal(output.error.code, "BOUNDARY_POLICY_PATH_INVALID");
});

test("invalid and oversized policies fail closed", () => {
  const invalid = normalizeBoundaryPolicy({ rules: [{ effect: "allow", globs: ["../outside/**"] }] });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, "BOUNDARY_POLICY_INVALID");

  const oversized = normalizeBoundaryPolicy({ rules: Array.from({ length: 101 }, (_, index) => ({ id: `r${index}`, effect: "deny", prefixes: [`p${index}`] })) });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.code, "BOUNDARY_POLICY_TOO_LARGE");
});

test("truncated changed-file input cannot produce a passing boundary result", () => {
  const output = boundaryCheck(tempProject(), {
    changedFiles: ["src/app.ts"],
    changedFilesTotal: 501,
    policy: { allow: { prefixes: ["src"] } }
  });

  assert.equal(output.ok, false);
  assert.equal(output.summary.changedFilesTruncated, true);
  assert.equal(output.violations.at(-1).ruleId, "changed-files-truncated");
});

test("boundary summary counts every violation while returning a bounded sample", () => {
  const files = Array.from({ length: 125 }, (_, index) => `generated/file-${index}.js`);
  const result = evaluateBoundaryPolicy(files, { deny: { prefixes: ["generated"] } });

  assert.equal(result.ok, false);
  assert.equal(result.summary.violationCount, 125);
  assert.equal(result.summary.allowedFileCount, 0);
  assert.equal(result.summary.violationsTruncated, true);
  assert.equal(result.violations.length, 100);
});

test("boundary command preserves true counts and truncation evidence within its limit", () => {
  const files = Array.from({ length: 125 }, (_, index) => `generated/file-${index}.js`);
  const output = boundaryCheck(tempProject(), {
    changedFiles: files,
    changedFilesTotal: 501,
    policy: { deny: { prefixes: ["generated"] } }
  });

  assert.equal(output.summary.violationCount, 126);
  assert.equal(output.summary.violationsTruncated, true);
  assert.equal(output.violations.length, 100);
  assert.equal(output.violations.at(-1).ruleId, "changed-files-truncated");
});

test("boundary policy is generic and contains no product-specific names", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "core", "boundary-check.js"), "utf8");
  assert.doesNotMatch(source, /\b(?:SFC|WYC)\b/i);
});

test("boundary check schema declares bounded violations", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "boundary-check.schema.json"), "utf8"));
  assert.equal(schema.properties.protocolVersion.const, "agentshell.boundary-check.v1");
  assert.equal(schema.properties.violations.maxItems, 100);
  assert.equal(schema.properties.files.maxItems, 200);
});

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-boundary-check-"));
}
