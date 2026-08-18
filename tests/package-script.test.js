import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { packageScript } from "../src/commands/package-script.js";

test("packageScript returns a compact summary for a matching script", async () => {
  const root = fixturePackage({
    name: "single-script-fixture",
    version: "2.0.0",
    private: true,
    scripts: {
      test: "vitest run",
      build: "vite build"
    }
  }, { lockfile: "pnpm-lock.yaml" });

  const result = await packageScript(root, "test", { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.package-script.v1");
  assert.equal(result.compact, true);
  assert.equal(result.packageManager, "pnpm");
  assert.deepEqual(result.package, {
    name: "single-script-fixture",
    version: "2.0.0",
    private: true,
    path: path.join(root, "package.json")
  });
  assert.deepEqual(result.script, {
    name: "test",
    command: "vitest run",
    category: "test",
    risky: false,
    longRunning: false
  });
  assert.equal(result.summary.totalScripts, 2);
  assert.equal(result.summary.scriptFound, true);
  assert.equal(result.summary.category, "test");
  assert.equal(result.summary.risky, false);
  assert.equal(result.summary.longRunning, false);
  assert.ok(result.suggestedNextActions.some((action) => action.command === "pnpm run test"));
});

test("packageScript preserves risky and long-running classification", async () => {
  const root = fixturePackage({
    name: "risk-fixture",
    scripts: {
      deploy: "npm publish",
      dev: "vite --host 0.0.0.0"
    }
  });

  const risky = await packageScript(root, "deploy", { compact: true });
  const longRunning = await packageScript(root, "dev", { compact: true });

  assert.equal(risky.ok, true);
  assert.equal(risky.script.category, "other");
  assert.equal(risky.script.risky, true);
  assert.equal(risky.script.longRunning, false);
  assert.equal(risky.suggestedNextActions[0].command, "agentshell package scripts --compact");
  assert.equal(longRunning.ok, true);
  assert.equal(longRunning.script.category, "dev");
  assert.equal(longRunning.script.risky, false);
  assert.equal(longRunning.script.longRunning, true);
});

test("packageScript finds package.json from nested directories", async () => {
  const root = fixturePackage({
    name: "nested-fixture",
    scripts: {
      build: "vite build"
    }
  });
  const nested = path.join(root, "src", "feature");
  fs.mkdirSync(nested, { recursive: true });

  const result = await packageScript(nested, "build", { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.package.name, "nested-fixture");
  assert.equal(result.script.name, "build");
  assert.equal(result.script.category, "build");
});

test("packageScript reports PACKAGE_JSON_NOT_FOUND clearly", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-package-script-missing-package-"));

  const result = await packageScript(root, "test", { compact: true });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PACKAGE_JSON_NOT_FOUND");
  assert.match(result.error.message, /No package\.json/i);
  assert.equal(result.error.details.root, root);
  assert.equal(result.error.suggestedNextActions[0].command, "agentshell tree --compact");
});

test("packageScript reports PACKAGE_SCRIPT_NOT_FOUND clearly", async () => {
  const root = fixturePackage({
    name: "missing-script-fixture",
    scripts: {
      test: "node --test",
      lint: "eslint src"
    }
  });

  const result = await packageScript(root, "build", { compact: true });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PACKAGE_SCRIPT_NOT_FOUND");
  assert.match(result.error.message, /Script not found/i);
  assert.equal(result.error.details.name, "build");
  assert.deepEqual(result.error.details.availableScripts, ["test", "lint"]);
  assert.equal(result.error.suggestedNextActions[0].command, "agentshell package scripts --compact");
});

test("package script schema exposes the compact response contract", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/package-script.schema.json", "utf8"));

  assert.equal(schema.title, "AgentShell Package Script Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.package-script.v1");
  assert.ok(schema.oneOf[0].required.includes("packageManager"));
  assert.ok(schema.oneOf[0].required.includes("script"));
  assert.ok(schema.oneOf[0].required.includes("summary"));
  assert.ok(schema.$defs.script.required.includes("category"));
  assert.ok(schema.$defs.script.required.includes("risky"));
  assert.ok(schema.$defs.script.required.includes("longRunning"));
  assert.ok(schema.$defs.summary.required.includes("scriptFound"));
});

function fixturePackage(pkg, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-package-script-"));
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  if (options.lockfile) {
    fs.writeFileSync(path.join(root, options.lockfile), "");
  }
  return root;
}
