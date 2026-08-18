import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { packageScripts } from "../src/commands/package-scripts.js";

test("packageScripts returns compact package script summaries", async () => {
  const root = fixturePackage({
    name: "script-fixture",
    version: "1.2.3",
    private: true,
    scripts: {
      test: "vitest run",
      build: "vite build",
      lint: "eslint src",
      typecheck: "tsc --noEmit",
      dev: "vite --host 0.0.0.0",
      format: "prettier --write .",
      deploy: "npm publish",
      "docs:preview": "vite preview"
    }
  }, { lockfile: "pnpm-lock.yaml" });

  const result = await packageScripts(root, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.package-scripts.v1");
  assert.equal(result.compact, true);
  assert.equal(result.packageManager, "pnpm");
  assert.deepEqual(result.package, {
    name: "script-fixture",
    version: "1.2.3",
    private: true,
    path: path.join(root, "package.json")
  });
  assert.equal(result.summary.totalScripts, 8);
  assert.equal(result.summary.returnedScripts, 8);
  assert.equal(result.summary.truncated, false);
  assert.equal(result.summary.hasTest, true);
  assert.equal(result.summary.hasBuild, true);
  assert.equal(result.summary.hasLint, true);
  assert.equal(result.summary.hasTypecheck, true);
  assert.equal(result.summary.hasDev, true);
  assert.equal(result.summary.hasFormat, true);
  assert.equal(result.summary.riskyCount, 1);
  assert.equal(result.summary.longRunningCount, 2);

  const byName = Object.fromEntries(result.scripts.map((script) => [script.name, script]));
  assert.equal(byName.test.category, "test");
  assert.equal(byName.build.category, "build");
  assert.equal(byName.lint.category, "lint");
  assert.equal(byName.typecheck.category, "typecheck");
  assert.equal(byName.dev.category, "dev");
  assert.equal(byName.format.category, "format");
  assert.equal(byName.deploy.category, "other");
  assert.equal(byName.deploy.risky, true);
  assert.equal(byName.dev.longRunning, true);
  assert.equal(byName["docs:preview"].longRunning, true);
  assert.ok(result.suggestedNextActions.some((action) => action.command === "agentshell verify test --compact"));
});

test("packageScripts finds package.json from nested directories and handles empty scripts", async () => {
  const root = fixturePackage({ name: "empty-fixture" });
  const nested = path.join(root, "src", "feature");
  fs.mkdirSync(nested, { recursive: true });

  const result = await packageScripts(nested, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.package.name, "empty-fixture");
  assert.equal(result.summary.totalScripts, 0);
  assert.equal(result.summary.returnedScripts, 0);
  assert.equal(result.summary.truncated, false);
  assert.equal(result.summary.hasTest, false);
  assert.equal(result.scripts.length, 0);
  assert.ok(result.suggestedNextActions.some((action) => action.command === "agentshell tree --compact"));
});

test("packageScripts reports PACKAGE_JSON_NOT_FOUND clearly", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-package-scripts-missing-"));

  const result = await packageScripts(root, { compact: true });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PACKAGE_JSON_NOT_FOUND");
  assert.match(result.error.message, /No package\.json/i);
  assert.equal(result.error.details.root, root);
});

test("packageScripts truncates compact output while preserving total summary", async () => {
  const scripts = {};
  for (let index = 0; index < 30; index += 1) {
    scripts[`script:${index}`] = `node script-${index}.js`;
  }
  const root = fixturePackage({ name: "many-scripts", scripts });

  const result = await packageScripts(root, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.summary.totalScripts, 30);
  assert.equal(result.summary.returnedScripts, 20);
  assert.equal(result.summary.truncated, true);
  assert.equal(result.scripts.length, 20);
  assert.ok(result.suggestedNextActions.some((action) => action.command === "agentshell package scripts"));
});

test("package scripts schema exposes the compact response contract", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/package-scripts.schema.json", "utf8"));

  assert.equal(schema.title, "AgentShell Package Scripts Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.package-scripts.v1");
  assert.ok(schema.oneOf[0].required.includes("packageManager"));
  assert.ok(schema.oneOf[0].required.includes("scripts"));
  assert.ok(schema.$defs.script.required.includes("category"));
  assert.ok(schema.$defs.script.required.includes("risky"));
  assert.ok(schema.$defs.script.required.includes("longRunning"));
  assert.ok(schema.$defs.summary.required.includes("returnedScripts"));
  assert.ok(schema.$defs.summary.required.includes("truncated"));
});

function fixturePackage(pkg, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-package-scripts-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg, null, 2));
  if (options.lockfile) {
    fs.writeFileSync(path.join(root, options.lockfile), "");
  }
  return root;
}
