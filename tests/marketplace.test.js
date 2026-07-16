import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const marketplacePath = new URL("../.agents/plugins/marketplace.json", import.meta.url);
const readmePath = new URL("../README.md", import.meta.url);

test("GitHub marketplace exposes the AgentShell root plugin", () => {
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));

  assert.equal(marketplace.name, "agentshell");
  assert.equal(marketplace.interface?.displayName, "AgentShell");
  assert.equal(marketplace.plugins?.length, 1);

  const [plugin] = marketplace.plugins;
  assert.equal(plugin.name, "agentshell");
  assert.deepEqual(plugin.source, {
    source: "url",
    url: "https://github.com/rainthousand/agentshell.git",
    ref: "main"
  });
  assert.deepEqual(plugin.policy, {
    installation: "AVAILABLE",
    authentication: "ON_INSTALL"
  });
  assert.equal(plugin.category, "Productivity");
});

test("README documents the repository marketplace install flow", () => {
  const readme = fs.readFileSync(readmePath, "utf8");

  assert.match(readme, /codex plugin marketplace add rainthousand\/agentshell --ref main/);
  assert.match(readme, /codex plugin add agentshell@agentshell/);
  assert.match(readme, /codex plugin marketplace upgrade agentshell/);
});
