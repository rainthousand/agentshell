import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("plugin smoke exposes compact JSON usage", () => {
  const result = spawnSync("node", ["scripts/plugin-smoke.js", "--help"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.usage, "node scripts/plugin-smoke.js [--path <installedPath>] [--markdown]");
});

test("plugin smoke keeps default report output JSON-compatible", () => {
  const result = spawnSync("node", ["scripts/plugin-smoke.js", "--path", "/tmp/agentshell-plugin-smoke-missing"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.protocolVersion, "agentshell.plugin-smoke.v1");
  assert.equal(output.installedPath, "/tmp/agentshell-plugin-smoke-missing");
  assert.equal(output.summary.total, output.checks.length);
  assert.equal(output.summary.failed, output.checks.filter((entry) => !entry.ok).length);
  assert.ok(output.checks.some((entry) => entry.name === "skill text recommends compact start or entry first pass"));
});

test("plugin smoke exposes markdown summary output", () => {
  const result = spawnSync("node", ["scripts/plugin-smoke.js", "--path", "/tmp/agentshell-plugin-smoke-missing", "--markdown"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /^# Agentshell Plugin Smoke/m);
  assert.match(result.stdout, /^Status: FAIL$/m);
  assert.match(result.stdout, /^Installed path: `\/tmp\/agentshell-plugin-smoke-missing`$/m);
  assert.match(result.stdout, /^Checks: \d+\/\d+ passed$/m);
  assert.match(result.stdout, /- \[ \] installed path exists/);
  assert.match(result.stdout, /- \[ \] skill text recommends compact start or entry first pass/);
});

test("plugin smoke validates installed skill first-pass recommendations from a fixture", () => {
  const installedPath = makeInstalledFixture([
    "Use `agentshell start --compact` or `agentshell entry --compact` for the cheapest first pass.",
    "Do not rely on a split setup path for fresh plugin entry."
  ].join("\n"));
  const result = spawnSync("node", ["scripts/plugin-smoke.js", "--path", installedPath], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  const check = output.checks.find((entry) => entry.name === "skill text recommends compact start or entry first pass");
  assert.ok(check, "missing compact first-pass skill check");
  assert.equal(check.ok, true);
});

test("plugin smoke validates installed plugin manifest identity from a fixture", () => {
  const installedPath = makeInstalledFixture("Use `agentshell start --compact` or `agentshell entry --compact`.");
  const result = spawnSync("node", ["scripts/plugin-smoke.js", "--path", installedPath], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  const check = output.checks.find((entry) => entry.name === "installed plugin manifest identity is stable");
  assert.ok(check, "missing installed manifest identity check");
  assert.equal(check.ok, true);
});

test("plugin smoke rejects installed plugin manifest identity drift", () => {
  const installedPath = makeInstalledFixture("Use `agentshell start --compact` or `agentshell entry --compact`.", {
    author: { name: "Someone Else" },
    interface: { developerName: "Not Alvin" }
  });
  const result = spawnSync("node", ["scripts/plugin-smoke.js", "--path", installedPath], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  const check = output.checks.find((entry) => entry.name === "installed plugin manifest identity is stable");
  assert.ok(check, "missing installed manifest identity check");
  assert.equal(check.ok, false);
  assert.match(check.error, /installed manifest author\.name Someone Else !== Alvin/);
});

test("plugin smoke validates installed plugin status developer metadata contract from a fixture", () => {
  const installedPath = makeInstalledFixture(
    "Use `agentshell start --compact` or `agentshell entry --compact`.",
    {},
    { pluginStatusContract: "valid" }
  );
  const result = spawnSync("node", ["scripts/plugin-smoke.js", "--path", installedPath], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  const check = output.checks.find((entry) => entry.name === "installed plugin status contract exposes developer metadata");
  assert.ok(check, "missing installed plugin status contract check");
  assert.equal(check.ok, true);
});

test("plugin smoke validates installed plugin validate schema contract from a fixture", () => {
  const installedPath = makeInstalledFixture(
    "Use `agentshell start --compact` or `agentshell entry --compact`.",
    {},
    { pluginStatusContract: "valid" }
  );
  const result = spawnSync("node", ["scripts/plugin-smoke.js", "--path", installedPath], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  const check = output.checks.find((entry) => entry.name === "schema get plugin-validate exposes validation protocol");
  assert.ok(check, "missing installed plugin validate schema check");
  assert.equal(check.ok, true);
});

test("plugin smoke rejects installed plugin status schema developer metadata drift", () => {
  const installedPath = makeInstalledFixture(
    "Use `agentshell start --compact` or `agentshell entry --compact`.",
    {},
    { pluginStatusContract: "missingDeveloperNameSchema" }
  );
  const result = spawnSync("node", ["scripts/plugin-smoke.js", "--path", installedPath], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  const check = output.checks.find((entry) => entry.name === "installed plugin status contract exposes developer metadata");
  assert.ok(check, "missing installed plugin status contract check");
  assert.equal(check.ok, false);
  assert.match(check.error, /plugin-status schema full plugin does not require developerName/);
});

test("plugin smoke rejects installed plugin status output developer metadata drift", () => {
  const installedPath = makeInstalledFixture(
    "Use `agentshell start --compact` or `agentshell entry --compact`.",
    {},
    { pluginStatusContract: "missingDeveloperNameOutput" }
  );
  const result = spawnSync("node", ["scripts/plugin-smoke.js", "--path", installedPath], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  const check = output.checks.find((entry) => entry.name === "installed plugin status contract exposes developer metadata");
  assert.ok(check, "missing installed plugin status contract check");
  assert.equal(check.ok, false);
  assert.match(check.error, /plugin status developerName undefined !== Alvin/);
});

test("plugin smoke rejects the old doctor understand first-pass recommendation", () => {
  const installedPath = makeInstalledFixture([
    "Use `agentshell start --compact` or `agentshell entry --compact` when available.",
    "The recommended first pass is doctor -> understand -> fix/diagnose/verify."
  ].join("\n"));
  const result = spawnSync("node", ["scripts/plugin-smoke.js", "--path", installedPath, "--markdown"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /- \[ \] skill text recommends compact start or entry first pass/);
  assert.match(result.stdout, /skill still recommends doctor -> understand -> fix\/diagnose\/verify as the first pass/);
});

test("plugin smoke validates agent-facing docs against compact manual topic flow", () => {
  const installedPath = makeInstalledFixture(validManualFlowText());
  const result = spawnSync("node", ["scripts/plugin-smoke.js", "--path", installedPath], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  const check = output.checks.find((entry) => entry.name === "agent-facing docs follow compact manual topic flow");
  assert.ok(check, "missing agent-facing manual flow check");
  assert.equal(check.ok, true);
});

test("plugin smoke rejects agent-facing docs that omit compact manual topics", () => {
  const installedPath = makeInstalledFixture(validManualFlowText(), {}, {
    codexDoc: [
      "Use `agentshell manual` for usage.",
      "Use `agentshell manual --topic repair` for repair.",
      "Use `agentshell manual --full` for the complete command map.",
      "Use `agentshell start --compact` first."
    ].join("\n")
  });
  const result = spawnSync("node", ["scripts/plugin-smoke.js", "--path", installedPath], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  const check = output.checks.find((entry) => entry.name === "agent-facing docs follow compact manual topic flow");
  assert.ok(check, "missing agent-facing manual flow check");
  assert.equal(check.ok, false);
  assert.match(check.error, /docs\/agent\/codex\.md does not mention agentshell manual --topic plugin/);
});

test("plugin smoke validates bundled string case real-project fixture", () => {
  const result = spawnSync("node", ["scripts/plugin-smoke.js", "--path", process.cwd()], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  const check = output.checks.find((entry) => entry.name === "real project eval manifest is bundled");
  assert.ok(check, "missing real project manifest bundle check");
  assert.equal(check.ok, true);
});

function makeInstalledFixture(skillText, manifest = {}, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-plugin-smoke-fixture-"));
  const manifestDir = path.join(dir, ".codex-plugin");
  const skillDir = path.join(dir, "skills", "agentshell");
  const codexDocDir = path.join(dir, "docs", "agent");
  const adapterDocDir = path.join(dir, "docs", "adapters");
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(codexDocDir, { recursive: true });
  fs.mkdirSync(adapterDocDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(manifestDir, "plugin.json"), `${JSON.stringify({
    name: "agentshell",
    version: "0.24.0+fixture",
    author: { name: "Alvin" },
    interface: { developerName: "Alvin" },
    ...manifest
  })}\n`);
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `${skillText}\n`);
  fs.writeFileSync(path.join(codexDocDir, "codex.md"), `${options.codexDoc || validManualFlowText()}\n`);
  fs.writeFileSync(path.join(adapterDocDir, "README.md"), `${options.adapterReadme || validManualFlowText()}\n`);
  if (options.pluginStatusContract) {
    fs.writeFileSync(path.join(binDir, "agentshell"), pluginStatusBinSource(options.pluginStatusContract));
  }
  return dir;
}

function validManualFlowText() {
  return [
    "Use `agentshell manual` as the compact command router.",
    "Use `agentshell manual --topic repair|plugin|benchmark|profile|onboarding|log-triage|reference` for focused guidance.",
    "Use `agentshell manual --full` only when the compact router is insufficient.",
    "Use `agentshell start --compact` or `agentshell entry --compact` for the cheapest first pass."
  ].join("\n");
}

function pluginStatusBinSource(contract) {
  const includeDeveloperNameInSchema = contract !== "missingDeveloperNameSchema";
  const includeDeveloperNameInOutput = contract !== "missingDeveloperNameOutput";
  const pluginRequired = includeDeveloperNameInSchema
    ? ["name", "version", "authorName", "developerName"]
    : ["name", "version", "authorName"];
  const pluginProperties = {
    name: { type: ["string", "null"] },
    version: { type: ["string", "null"] },
    authorName: { type: ["string", "null"] }
  };
  if (includeDeveloperNameInSchema) {
    pluginProperties.developerName = { type: ["string", "null"] };
  }
  const schema = {
    oneOf: [
      {
        properties: {
          protocolVersion: { enum: ["agentshell.plugin-status.v1"] },
          plugin: {
            required: pluginRequired,
            properties: pluginProperties
          }
        }
      },
      {
        properties: {
          compact: { const: true },
          plugin: {
            required: pluginRequired,
            properties: pluginProperties
          }
        }
      }
    ]
  };
  const validateSchema = {
    oneOf: [
      {
        properties: {
          protocolVersion: { const: "agentshell.plugin-validate.v1" }
        }
      },
      {
        properties: {
          protocolVersion: { const: "agentshell.plugin-validate.v1" },
          compact: { const: true }
        }
      }
    ],
    $defs: {
      pluginStatusSummary: {
        properties: {
          protocolVersion: { const: "agentshell.plugin-status.v1" }
        }
      }
    }
  };
  const plugin = {
    name: "agentshell",
    version: "0.24.0+fixture",
    authorName: "Alvin"
  };
  if (includeDeveloperNameInOutput) {
    plugin.developerName = "Alvin";
  }
  const status = {
    ok: true,
    protocolVersion: "agentshell.plugin-status.v1",
    compact: true,
    status: "ready",
    plugin
  };
  return [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    `const schema = ${JSON.stringify(schema)};`,
    `const validateSchema = ${JSON.stringify(validateSchema)};`,
    `const status = ${JSON.stringify(status)};`,
    "if (args.join(' ') === 'schema get plugin-status') { console.log(JSON.stringify(schema)); process.exit(0); }",
    "if (args.join(' ') === 'schema get plugin-validate') { console.log(JSON.stringify(validateSchema)); process.exit(0); }",
    "if (args[0] === 'plugin' && args[1] === 'status') { console.log(JSON.stringify(status)); process.exit(0); }",
    "console.log(JSON.stringify({ ok: false, error: { code: 'UNSUPPORTED' } }));",
    "process.exit(1);"
  ].join("\n");
}
