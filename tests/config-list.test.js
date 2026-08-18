import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { configList } from "../src/commands/config-list.js";

test("configList discovers common Node project config entrypoints without reading contents", async () => {
  const root = fixtureDir("agentshell-config-list-node-");
  writeJson(path.join(root, "package.json"), { name: "node-fixture" });
  write(path.join(root, "tsconfig.json"), "{ this would be invalid json if read fully");
  write(path.join(root, "jsconfig.json"), "");
  write(path.join(root, "vite.config.ts"), "");
  write(path.join(root, "webpack.config.cjs"), "");
  write(path.join(root, "rollup.config.mjs"), "");
  write(path.join(root, "eslint.config.js"), "");
  write(path.join(root, ".prettierrc"), "");
  write(path.join(root, "biome.jsonc"), "");

  const result = await configList(root, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, "agentshell.config-list.v1");
  assert.equal(result.compact, true);
  assert.equal(result.summary.totalConfigs, 9);
  assert.equal(result.summary.returnedConfigs, 9);
  assert.equal(result.summary.truncated, false);
  assert.equal(result.summary.hasNode, true);
  assert.equal(result.summary.hasGo, false);
  assert.equal(result.summary.categories.package, 1);
  assert.equal(result.summary.categories.language, 2);
  assert.equal(result.summary.categories.build, 3);
  assert.equal(result.summary.categories.quality, 3);

  const byPath = new Map(result.configs.map((entry) => [entry.path, entry]));
  assert.equal(byPath.get("package.json").type, "package-json");
  assert.equal(byPath.get("tsconfig.json").type, "tsconfig");
  assert.equal(byPath.get("vite.config.ts").category, "build");
  assert.equal(byPath.get("eslint.config.js").risk, "low");
  assert.equal(byPath.get("package.json").readCommand, "agentshell read package.json --lines 1:80");
  assert.ok(result.suggestedNextActions.some((entry) => entry.command === "agentshell package scripts --compact"));
});

test("configList discovers Go, container, CI, and Codex or AgentShell config", async () => {
  const root = fixtureDir("agentshell-config-list-go-ci-");
  write(path.join(root, "go.mod"), "module example.com/service\n\ngo 1.22\n");
  write(path.join(root, "go.work"), "go 1.22\n\nuse ./service\n");
  write(path.join(root, "Makefile"), "test:\n\tgo test ./...\n");
  write(path.join(root, "Dockerfile"), "FROM scratch\n");
  write(path.join(root, "compose.yaml"), "services: {}\n");
  write(path.join(root, ".github", "workflows", "ci.yml"), "name: ci\n");
  write(path.join(root, ".circleci", "config.yml"), "version: 2.1\n");
  write(path.join(root, "AGENTS.md"), "# policy\n");
  write(path.join(root, ".agentshell", "config.json"), "{}\n");
  write(path.join(root, ".codex", "config.toml"), "");

  const result = await configList(root, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.summary.totalConfigs, 10);
  assert.equal(result.summary.hasGo, true);
  assert.equal(result.summary.hasCi, true);
  assert.equal(result.summary.hasContainers, true);
  assert.equal(result.summary.hasAgentConfig, true);
  assert.equal(result.summary.categories.go, 2);
  assert.equal(result.summary.categories.container, 2);
  assert.equal(result.summary.categories.ci, 2);
  assert.equal(result.summary.categories.agent, 3);

  const byPath = new Map(result.configs.map((entry) => [entry.path, entry]));
  assert.equal(byPath.get("go.mod").type, "go-mod");
  assert.equal(byPath.get("go.work").type, "go-work");
  assert.equal(byPath.get("Makefile").category, "automation");
  assert.equal(byPath.get("Dockerfile").risk, "high");
  assert.equal(byPath.get(".github/workflows/ci.yml").type, "github-actions");
  assert.equal(byPath.get(".circleci/config.yml").type, "ci");
  assert.equal(byPath.get(".agentshell/config.json").type, "agent-config");
  assert.ok(result.suggestedNextActions.some((entry) => entry.command === "agentshell verify test --compact"));
  assert.ok(result.suggestedNextActions.some((entry) => entry.command === "agentshell files changed --compact"));
});

test("configList truncates compact output at 60 by default while preserving totals", async () => {
  const root = fixtureDir("agentshell-config-list-truncated-");
  writeJson(path.join(root, "package.json"), { name: "many-configs" });
  for (let index = 0; index < 65; index += 1) {
    write(path.join(root, "packages", `pkg-${String(index).padStart(2, "0")}`, "tsconfig.json"), "{}\n");
  }

  const result = await configList(root, { compact: true });

  assert.equal(result.ok, true);
  assert.equal(result.summary.totalConfigs, 66);
  assert.equal(result.summary.returnedConfigs, 60);
  assert.equal(result.summary.truncated, true);
  assert.equal(result.configs.length, 60);
  assert.ok(result.suggestedNextActions.some((entry) => entry.command === "agentshell config list"));
});

test("config list schema exposes the compact response contract", () => {
  const schema = JSON.parse(fs.readFileSync("schemas/config-list.schema.json", "utf8"));

  assert.equal(schema.title, "AgentShell Config List Response");
  assert.equal(schema.oneOf[0].properties.protocolVersion.const, "agentshell.config-list.v1");
  assert.ok(schema.oneOf[0].required.includes("summary"));
  assert.ok(schema.oneOf[0].required.includes("configs"));
  assert.ok(schema.$defs.summary.required.includes("returnedConfigs"));
  assert.ok(schema.$defs.summary.required.includes("truncated"));
  assert.ok(schema.$defs.config.required.includes("readCommand"));
  assert.ok(schema.$defs.config.properties.type.enum.includes("github-actions"));
  assert.ok(schema.$defs.config.properties.type.enum.includes("agent-config"));
});

function fixtureDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(file, value) {
  write(file, JSON.stringify(value, null, 2));
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
