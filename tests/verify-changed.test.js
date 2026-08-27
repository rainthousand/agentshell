import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { verifyChanged } from "../src/commands/verify-changed.js";
import { planChangedVerification } from "../src/core/verify-changed.js";

test("verify changed defaults to a dry-run Node plan with full tests", async () => {
  const root = tempProject();
  writeJson(path.join(root, "package.json"), { scripts: { "format:check": "prettier --check .", build: "tsc", test: "node --test" } });

  const output = await verifyChanged(root, { changedFiles: ["src/app.ts"], compact: true });

  assert.equal(output.ok, true);
  assert.equal(output.mode, "plan");
  assert.equal(output.summary.executedStepCount, 0);
  assert.deepEqual(output.plan.map((entry) => entry.argv), [
    ["npm", "run", "format:check"],
    ["npm", "run", "build"],
    ["npm", "run", "test"]
  ]);
  assert.equal(output.plan.at(-1).scope, "full");
  assert.equal(output.plan.at(-1).fallback, true);
});

test("verify changed maps ordinary Go files to affected packages", () => {
  const root = tempProject();
  fs.writeFileSync(path.join(root, "go.mod"), "module example.test/demo\n\ngo 1.22\n");
  fs.mkdirSync(path.join(root, "internal", "alpha"), { recursive: true });
  fs.writeFileSync(path.join(root, "internal", "alpha", "alpha.go"), "package alpha\n");

  const output = planChangedVerification(root, { changedFiles: ["internal/alpha/alpha.go"] });

  assert.equal(output.ok, true);
  assert.equal(output.summary.fullFallback, false);
  assert.deepEqual(output.plan.find((entry) => entry.kind === "build").argv, ["go", "test", "-run", "^$", "./internal/alpha"]);
  assert.deepEqual(output.plan.find((entry) => entry.kind === "test").argv, ["go", "test", "./internal/alpha"]);
});

test("Go control files force a complete verification fallback", () => {
  const root = tempProject();
  fs.writeFileSync(path.join(root, "go.mod"), "module example.test/demo\n\ngo 1.22\n");

  const output = planChangedVerification(root, { changedFiles: ["go.mod"] });

  assert.equal(output.summary.fullFallback, true);
  assert.deepEqual(output.plan.find((entry) => entry.kind === "test").argv, ["go", "test", "./..."]);
});

test("includeDependents expands Go tests to transitive workspace importers", () => {
  const root = tempProject();
  fs.writeFileSync(path.join(root, "go.mod"), "module example.test/demo\n\ngo 1.22\n");
  for (const directory of ["internal/base", "internal/middle", "cmd/app"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "internal/base/base.go"), "package base\n");
  const graph = [
    { ImportPath: "example.test/demo/internal/base", Dir: path.join(root, "internal/base"), Imports: [] },
    { ImportPath: "example.test/demo/internal/middle", Dir: path.join(root, "internal/middle"), Imports: ["example.test/demo/internal/base"] },
    { ImportPath: "example.test/demo/cmd/app", Dir: path.join(root, "cmd/app"), Imports: ["example.test/demo/internal/middle"] }
  ].map(JSON.stringify).join("\n");
  const calls = [];

  const output = planChangedVerification(root, {
    changedFiles: ["internal/base/base.go"],
    includeDependents: true,
    env: {
      ...process.env,
      GOENV: "/tmp/unsafe-goenv",
      GOFLAGS: "-toolexec=unexpected",
      GOPROXY: "https://proxy.example.test",
      GOSUMDB: "sum.example.test",
      GOTOOLCHAIN: "auto",
      GOWORK: "/tmp/outside.work"
    },
    spawnSync(command, argv, options) {
      calls.push({ command, argv, options });
      return { status: 0, stdout: graph, stderr: "" };
    }
  });

  assert.deepEqual(calls[0].argv, ["list", "-json", "./..."]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.timeout, 10_000);
  assert.equal(calls[0].options.maxBuffer, 8 * 1024 * 1024);
  assert.equal(calls[0].options.env.GOENV, "off");
  assert.equal(calls[0].options.env.GOFLAGS, "-mod=readonly");
  assert.equal(calls[0].options.env.GOPROXY, "off");
  assert.equal(calls[0].options.env.GOSUMDB, "off");
  assert.equal(calls[0].options.env.GOTOOLCHAIN, "local");
  assert.equal(calls[0].options.env.GOWORK, undefined);
  assert.equal(output.summary.dependentsExpanded, true);
  assert.equal(output.summary.dependencyFallback, false);
  assert.deepEqual(output.plan.find((entry) => entry.kind === "test").argv, [
    "go", "test", "./cmd/app", "./internal/base", "./internal/middle"
  ]);
});

test("Go dependency discovery failure conservatively falls back to all packages", () => {
  const root = tempProject();
  fs.writeFileSync(path.join(root, "go.mod"), "module example.test/demo\n\ngo 1.22\n");
  fs.mkdirSync(path.join(root, "internal/base"), { recursive: true });
  fs.writeFileSync(path.join(root, "internal/base/base.go"), "package base\n");

  const output = planChangedVerification(root, {
    changedFiles: ["internal/base/base.go"],
    includeDependents: true,
    spawnSync: () => ({ status: 1, stdout: "", stderr: "failed" })
  });

  assert.equal(output.summary.fullFallback, true);
  assert.equal(output.summary.dependencyFallback, true);
  assert.deepEqual(output.plan.find((entry) => entry.kind === "test").argv, ["go", "test", "./..."]);
  assert.match(output.reasons.join(" "), /dependency graph was not reliable/);
});

test("Go dependency discovery spawn errors conservatively fall back to all packages", () => {
  const root = tempProject();
  fs.writeFileSync(path.join(root, "go.mod"), "module example.test/demo\n\ngo 1.22\n");
  fs.mkdirSync(path.join(root, "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, "pkg/value.go"), "package pkg\n");

  const output = planChangedVerification(root, {
    changedFiles: ["pkg/value.go"],
    includeDependents: true,
    spawnSync: () => { throw new Error("spawn failed"); }
  });

  assert.equal(output.summary.dependencyFallback, true);
  assert.deepEqual(output.plan.find((entry) => entry.kind === "test").argv, ["go", "test", "./..."]);
});

test("Go dependent discovery uses transitive go list dependency data", () => {
  const root = tempProject();
  fs.writeFileSync(path.join(root, "go.mod"), "module example.test/demo\n\ngo 1.22\n");
  for (const directory of ["base", "consumer"]) fs.mkdirSync(path.join(root, directory), { recursive: true });
  fs.writeFileSync(path.join(root, "base/value.go"), "package base\n");
  const records = [
    { ImportPath: "example.test/demo/base", Dir: path.join(root, "base"), Imports: [], Deps: [] },
    { ImportPath: "example.test/demo/consumer", Dir: path.join(root, "consumer"), Imports: ["example.test/bridge"], Deps: ["example.test/demo/base"] }
  ];

  const output = planChangedVerification(root, {
    changedFiles: ["base/value.go"],
    includeDependents: true,
    spawnSync: () => ({ status: 0, stdout: records.map(JSON.stringify).join("\n"), stderr: "" })
  });

  assert.equal(output.summary.dependentsExpanded, true);
  assert.deepEqual(output.plan.find((entry) => entry.kind === "test").argv, ["go", "test", "./base", "./consumer"]);
});

test("an oversized affected Go package set falls back to all packages", () => {
  const root = tempProject();
  fs.writeFileSync(path.join(root, "go.mod"), "module example.test/demo\n\ngo 1.22\n");
  fs.mkdirSync(path.join(root, "base"), { recursive: true });
  fs.writeFileSync(path.join(root, "base/value.go"), "package base\n");
  const records = [{ ImportPath: "example.test/demo/base", Dir: path.join(root, "base"), Imports: [] }];
  for (let index = 0; index < 100; index += 1) {
    records.push({ ImportPath: `example.test/demo/user${index}`, Dir: path.join(root, `user${index}`), Imports: ["example.test/demo/base"] });
  }

  const output = planChangedVerification(root, {
    changedFiles: ["base/value.go"],
    includeDependents: true,
    spawnSync: () => ({ status: 0, stdout: records.map(JSON.stringify).join("\n"), stderr: "" })
  });

  assert.equal(output.summary.dependencyFallback, true);
  assert.deepEqual(output.plan.find((entry) => entry.kind === "test").argv, ["go", "test", "./..."]);
});

test("default Go planning does not invoke dependency discovery", () => {
  const root = tempProject();
  fs.writeFileSync(path.join(root, "go.mod"), "module example.test/demo\n\ngo 1.22\n");
  fs.mkdirSync(path.join(root, "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, "pkg/value.go"), "package pkg\n");

  const output = planChangedVerification(root, {
    changedFiles: ["pkg/value.go"],
    spawnSync: () => { throw new Error("must not be called"); }
  });

  assert.equal(output.includeDependents, false);
  assert.deepEqual(output.plan.find((entry) => entry.kind === "test").argv, ["go", "test", "./pkg"]);
});

test("includeDependents expands reliable Node workspace tests", () => {
  const root = tempProject();
  writeJson(path.join(root, "package.json"), { private: true, workspaces: ["packages/*"], scripts: { test: "node --test" } });
  for (const name of ["base", "app"]) fs.mkdirSync(path.join(root, "packages", name), { recursive: true });
  writeJson(path.join(root, "packages/base/package.json"), { name: "@demo/base", scripts: { test: "node --test" } });
  writeJson(path.join(root, "packages/app/package.json"), { name: "@demo/app", dependencies: { "@demo/base": "workspace:*" }, scripts: { build: "tsc", test: "node --test" } });

  const output = planChangedVerification(root, {
    changedFiles: ["packages/base/src/index.ts"],
    includeDependents: true
  });

  assert.equal(output.summary.dependentsExpanded, true);
  assert.equal(output.summary.fullFallback, false);
  assert.deepEqual(output.plan.map((entry) => entry.argv), [
    ["npm", "run", "test", "--workspace", "@demo/base"],
    ["npm", "run", "build", "--workspace", "@demo/app"],
    ["npm", "run", "test", "--workspace", "@demo/app"]
  ]);
});

test("includeDependents is preserved in the suggested execute command", async () => {
  const root = tempProject();
  writeJson(path.join(root, "package.json"), { scripts: { test: "node --test" } });

  const output = await verifyChanged(root, { changedFiles: ["src/app.ts"], includeDependents: true });

  assert.equal(output.includeDependents, true);
  assert.equal(output.suggestedNextActions[0].command, "agentshell verify changed --execute --include-dependents --compact");
});

test("unreliable Node workspace graph retains complete root verification", () => {
  const root = tempProject();
  writeJson(path.join(root, "package.json"), { private: true, workspaces: ["packages/*"], scripts: { test: "node --test" } });
  fs.mkdirSync(path.join(root, "packages/base"), { recursive: true });
  writeJson(path.join(root, "packages/base/package.json"), { name: "@demo/base" });

  const output = planChangedVerification(root, {
    changedFiles: ["packages/base/src/index.ts"],
    includeDependents: true
  });

  assert.equal(output.summary.dependencyFallback, true);
  assert.equal(output.summary.fullFallback, true);
  assert.deepEqual(output.plan.find((entry) => entry.kind === "test").argv, ["npm", "run", "test"]);
});

test("oversized Node dependent plans retain complete root verification", () => {
  const root = tempProject();
  writeJson(path.join(root, "package.json"), { private: true, workspaces: ["packages/*"], scripts: { test: "node --test" } });
  for (let index = 0; index < 9; index += 1) {
    const directory = path.join(root, "packages", `package-${index}`);
    fs.mkdirSync(directory, { recursive: true });
    writeJson(path.join(directory, "package.json"), {
      name: `@demo/package-${index}`,
      dependencies: index === 0 ? {} : { [`@demo/package-${index - 1}`]: "workspace:*" },
      scripts: { build: "build", test: "test" }
    });
  }

  const output = planChangedVerification(root, {
    changedFiles: ["packages/package-0/src/index.ts"],
    includeDependents: true
  });

  assert.equal(output.summary.dependencyFallback, true);
  assert.equal(output.summary.planTruncated, false);
  assert.deepEqual(output.plan.map((entry) => entry.argv), [["npm", "run", "test"]]);
});

test("Python and Java source changes retain full build and test plans", () => {
  const pythonRoot = tempProject();
  fs.writeFileSync(path.join(pythonRoot, "pyproject.toml"), "[tool.ruff]\nline-length = 100\n");
  const python = planChangedVerification(pythonRoot, { changedFiles: ["src/app.py"] });
  assert.deepEqual(python.plan.find((entry) => entry.kind === "format").argv, ["python", "-m", "ruff", "format", "--check", "."]);
  assert.deepEqual(python.plan.find((entry) => entry.kind === "test").argv, ["python", "-m", "pytest"]);

  const javaRoot = tempProject();
  fs.writeFileSync(path.join(javaRoot, "pom.xml"), "<project/>\n");
  const java = planChangedVerification(javaRoot, { changedFiles: ["src/main/java/App.java"] });
  assert.deepEqual(java.plan.find((entry) => entry.kind === "build").argv, ["mvn", "-q", "-DskipTests", "compile"]);
  assert.deepEqual(java.plan.find((entry) => entry.kind === "test").argv, ["mvn", "-q", "test"]);
});

test("unmapped non-documentation changes fall back to complete verification", () => {
  const root = tempProject();
  writeJson(path.join(root, "package.json"), { scripts: { test: "node --test" } });

  const output = planChangedVerification(root, { changedFiles: ["infra/custom.input"] });

  assert.equal(output.summary.fullFallback, true);
  assert.deepEqual(output.plan.find((entry) => entry.kind === "test").argv, ["npm", "run", "test"]);
  assert.match(output.reasons[0], /Unmapped changed file/);
});

test("truncated changed-file input forces all detected ecosystems to full verification", () => {
  const root = tempProject();
  writeJson(path.join(root, "package.json"), { scripts: { test: "node --test" } });

  const output = planChangedVerification(root, {
    changedFiles: ["README.md"],
    changedFilesTotal: 501
  });

  assert.equal(output.summary.fullFallback, true);
  assert.deepEqual(output.plan.find((entry) => entry.kind === "test").argv, ["npm", "run", "test"]);
  assert.match(output.reasons[0], /truncated/);
});

test("a language change without its manifest falls back to the detected project verification", () => {
  const root = tempProject();
  fs.writeFileSync(path.join(root, "pyproject.toml"), "[tool.pytest.ini_options]\n");

  const output = planChangedVerification(root, { changedFiles: ["tools/helper.ts"] });

  assert.equal(output.summary.fullFallback, true);
  assert.deepEqual(output.plan.find((entry) => entry.kind === "test").argv, ["python", "-m", "pytest"]);
  assert.match(output.reasons[0], /no matching root manifest/);
});

test("execute passes argv arrays without a shell and stops after failure", async () => {
  const root = tempProject();
  writeJson(path.join(root, "package.json"), { scripts: { build: "build", test: "test" } });
  const seen = [];

  const output = await verifyChanged(root, {
    changedFiles: ["src/a.js"],
    execute: true,
    runCommand: async (argv, cwd) => {
      seen.push({ argv, cwd });
      return { exitCode: 1, durationMs: 3, stderr: "first failure\n".repeat(100), stdout: "", timedOut: false, truncated: true };
    }
  });

  assert.equal(output.ok, false);
  assert.equal(output.summary.executedStepCount, 1);
  assert.equal(Array.isArray(seen[0].argv), true);
  assert.deepEqual(seen[0].argv, ["npm", "run", "build"]);
  assert.equal(seen[0].cwd, root);
  assert.ok(output.executions[0].mainError.length <= 400);
  assert.equal(output.executions[0].outputTruncated, true);
});

test("execute redacts secrets from compact failure summaries", async () => {
  const root = tempProject();
  writeJson(path.join(root, "package.json"), { scripts: { test: "test" } });

  const output = await verifyChanged(root, {
    changedFiles: ["src/a.js"],
    execute: true,
    runCommand: async () => ({
      exitCode: 1,
      durationMs: 2,
      stderr: "api_key=super-secret access_token=also-secret",
      stdout: "",
      timedOut: false,
      truncated: false
    })
  });

  assert.equal(output.ok, false);
  assert.doesNotMatch(output.executions[0].mainError, /super-secret|also-secret/);
  assert.match(output.executions[0].mainError, /api_key=\[REDACTED\]/);
  assert.match(output.executions[0].mainError, /access_token=\[REDACTED\]/);
});

test("verify changed returns the shared failure shape when change discovery fails", async () => {
  const root = path.join(tempProject(), "missing");

  const output = await verifyChanged(root);

  assert.equal(output.ok, false);
  assert.equal(output.error.code, "GIT_STATUS_FAILED");
  assert.equal(typeof output.error.message, "string");
  assert.deepEqual(output.error.details, {});
  assert.deepEqual(output.error.suggestedNextActions, []);
  assert.equal(output.protocolVersion, undefined);
});

test("verify changed schema declares the bounded protocol", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "verify-changed.schema.json"), "utf8"));
  const success = schema.oneOf[0];
  assert.equal(success.properties.ok.type, "boolean");
  assert.equal(success.properties.protocolVersion.const, "agentshell.verify-changed.v1");
  assert.equal(success.properties.plan.maxItems, 16);
  assert.equal(success.properties.changedFiles.maxItems, 500);
  assert.equal(success.properties.includeDependents.type, "boolean");
  assert.equal(success.properties.includeDependents.default, false);
  assert.equal(schema.oneOf[1].$ref, "common.schema.json#/$defs/failure");
});

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-verify-changed-"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
