import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const cli = path.join(root, "src", "cli.js");

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function run(args, cwd) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function withGoModule(fn) {
  const moduleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-go-contract-"));
  const nested = path.join(moduleRoot, "internal", "service");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(
    path.join(moduleRoot, "go.mod"),
    "module example.com/agentshell/contract\n\ngo 1.22\n"
  );
  try {
    return fn({ moduleRoot, nested });
  } finally {
    fs.rmSync(moduleRoot, { recursive: true, force: true });
  }
}

test("Go is additive in doctor, understand, and start schemas", () => {
  const doctor = readJson("schemas/doctor.schema.json");
  const understand = readJson("schemas/understand.schema.json");
  const start = readJson("schemas/start.schema.json");

  assert.ok(doctor.$defs.package.properties.manager.enum.includes("go"));
  assert.deepEqual(doctor.$defs.package.properties.kind.enum, ["node", "go"]);
  assert.ok(doctor.$defs.package.properties.manifest.enum.includes("go.mod"));
  assert.equal(doctor.oneOf[0].properties.runtime.properties.go.$ref, "#/$defs/go");
  assert.ok(doctor.$defs.check.properties.name.enum.includes("go"));

  assert.ok(understand.$defs.stack.properties.packageManager.enum.includes("go"));
  assert.ok(understand.$defs.stack.properties.languages.items.examples.includes("go"));

  const embeddedStack = start.$defs.compactUnderstand.properties.stack.properties;
  assert.ok(embeddedStack.packageManager.enum.includes("go"));
  assert.ok(embeddedStack.languages.items.examples.includes("go"));
  assert.ok(start.$defs.summary.properties.packageManager.enum.includes("go"));
  assert.ok(start.$defs.compactSummary.properties.packageManager.enum.includes("go"));
});

test("Go workspace discovery keeps runtime response shapes aligned", () => {
  withGoModule(({ moduleRoot, nested }) => {
    const understand = run(["understand"], nested);
    assert.equal(understand.workspace.root, fs.realpathSync(moduleRoot));
    assert.deepEqual(understand.stack.languages, ["go"]);
    assert.equal(understand.stack.packageManager, "go");
    assert.equal(understand.scripts.test, "go test ./...");

    const doctor = run(["doctor"], nested);
    assert.equal(doctor.package.found, true);
    assert.equal(doctor.package.manager, "go");
    assert.equal(doctor.package.kind, "go");
    assert.equal(doctor.package.manifest, "go.mod");
    assert.equal(doctor.package.scripts.test, "go test ./...");
    assert.ok(doctor.runtime.go);
    assert.ok(doctor.checks.some((check) => check.name === "go"));

    const start = run(["start", "--compact"], nested);
    assert.equal(start.summary.packageManager, "go");
    assert.deepEqual(start.summary.languages, ["go"]);
    assert.equal(start.summary.scripts.test, "go test ./...");
  });
});

test("Go documentation keeps verification and repair boundaries explicit", () => {
  const docs = [
    fs.readFileSync(path.join(root, "README.md"), "utf8"),
    fs.readFileSync(path.join(root, "skills", "agentshell", "SKILL.md"), "utf8"),
    fs.readFileSync(path.join(root, "docs", "compatibility.md"), "utf8")
  ].join("\n");

  assert.match(docs, /go test \.\/\.\.\./);
  assert.match(docs, /package-scoped/i);
  assert.match(docs, /cache fingerprints?/i);
  assert.match(docs, /Automatic\s+Go(?:\/Python\/Java)?\s+(?:code|source) repair is not supported yet/i);
  assert.match(docs, /Python and Java support in V1\.0 is read-only discovery and summarization/i);
});
