import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  auditCommandContracts,
  extractAgentShellCommands,
  matchesHelpCommand
} from "../scripts/command-contract-audit.js";

const script = path.resolve("scripts/command-contract-audit.js");

test("repository command, schema, package, and skill contracts stay aligned", () => {
  const report = auditCommandContracts();

  assert.equal(report.ok, true, report.issues.join("\n"));
  assert.equal(report.drift.invalidCommands.length, 0);
  assert.equal(report.drift.missingSchemas.length, 0);
  assert.equal(report.drift.unregisteredSchemas.length, 0);
});

test("help matching accepts registered alternatives and rejects command drift", () => {
  const help = [
    "agentshell verify <test|build> [--compact]",
    "agentshell plugin status [--compact]",
    "agentshell find <query>"
  ];

  assert.equal(matchesHelpCommand("agentshell verify build --compact", help), true);
  assert.equal(matchesHelpCommand("agentshell plugin status --compact", help), true);
  assert.equal(matchesHelpCommand("agentshell find SomeSymbol", help), true);
  assert.equal(matchesHelpCommand("agentshell verify deploy --compact", help), false);
  assert.equal(matchesHelpCommand("agentshell plugin remove", help), false);
  assert.equal(matchesHelpCommand("agentshell imaginary --compact", help), false);
});

test("fixture audit reports schema and skill command drift", () => {
  const root = fixtureRoot();
  const report = auditCommandContracts({
    root,
    helpCommands: ["agentshell start [--compact]"],
    schemaNames: ["start", "missing"]
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.drift.missingSchemas, ["missing"]);
  assert.deepEqual(report.drift.unregisteredSchemas, ["extra"]);
  assert.equal(report.drift.invalidCommands[0].command, "agentshell deploy --compact");
});

test("extractor reports source locations and CLI exits non-zero on drift", () => {
  const root = fixtureRoot();
  const file = path.join(root, "skills/agentshell/SKILL.md");
  const extracted = extractAgentShellCommands(fs.readFileSync(file, "utf8"), file, root);
  assert.deepEqual(extracted, [{ command: "agentshell deploy --compact", file: "skills/agentshell/SKILL.md", line: 6 }]);

  const result = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, false);
});

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentshell-contract-audit-"));
  fs.mkdirSync(path.join(root, "skills/agentshell/references"), { recursive: true });
  fs.mkdirSync(path.join(root, "schemas"));
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "skills/agentshell/SKILL.md"), [
    "---",
    "name: fixture",
    "description: fixture",
    "---",
    "# Fixture",
    "`agentshell deploy --compact`",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(root, "schemas/start.schema.json"), "{}\n");
  fs.writeFileSync(path.join(root, "schemas/extra.schema.json"), "{}\n");
  fs.writeFileSync(path.join(root, "bin/agentshell"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ bin: { agentshell: "./bin/agentshell" } }));
  return root;
}
